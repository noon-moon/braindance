// Worker tests — the failure paths, which is nearly all of this module.
// Run: `npm run test:worker`.
//
// The happy path here is one line (ask, write the answer down). Everything else
// in worker.ts exists to answer "and what if it doesn't work", and until now none
// of it ran outside production: a refusal, a 5xx, an unparseable answer, a
// sidecar that won't parse, a sidecar that won't WRITE. Those branches decide
// whether a note is asked about again, so a mistake in one of them is a bill
// rather than a bug, and a bill nobody sees.
//
// Offline and deterministic. `globalThis.fetch` is replaced BEFORE the SDK client
// is constructed (suggest.ts builds it lazily on first use), so the transport is
// a scripted queue: no key is used, no packet leaves, and every reply — an
// answer, a refusal, a 500 — is chosen by the test rather than by a service. The
// call COUNT is the assertion that matters most in this file: "never reaching a
// paid call" is not observable any other way.
//
// The blocks are order-dependent by construction, because the module is: the
// worker's cost ceiling is module state (`persistBroken` latches on purpose), so
// the unwritable-sidecar block is last and says so.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// All three resolve at module load, so they are set before the imports below.
const DIR = mkdtempSync(join(tmpdir(), "bd-worker-sidecars-"));
process.env.SUGGESTIONS_DIR = DIR;
const VAULT = mkdtempSync(join(tmpdir(), "bd-worker-vault-"));
mkdirSync(join(VAULT, "inbox"));
process.env.VAULT_PATH = VAULT;

// The SDK constructor throws with no key, and the worker only starts with one —
// so a key has to exist for these paths to be reachable at all. It is never sent
// anywhere: the fetch below never leaves the process.
process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key";
process.env.AI_SUGGEST = "1";
process.env.AI_MODEL = "test-model";

/** The tick's own interval, and therefore the base of every backoff it writes. */
const INTERVAL = 60_000;

// ── The transport ───────────────────────────────────────────────────────────

interface Reply { status: number; body: unknown; headers?: Record<string, string> }

/** Every outbound request, in order. Length is the money question. */
const calls: string[] = [];
/** Replies, consumed in the order the worker makes calls — which is the order
 *  listInbox returns notes in (newest first), so a block that scripts more than
 *  one reply is also asserting that order. */
let replies: Reply[] = [];

globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  calls.push(String(init?.body ?? ""));
  const r = replies.shift();
  // An unscripted call is a test bug AND the failure this file is about — a call
  // nobody meant to pay for — so it fails loudly rather than returning something.
  assert.ok(r, `unscripted API call: ${calls.length} made, ${calls.length - 1} scripted`);
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json", ...r.headers },
  });
}) as typeof fetch;

/** The envelope every reply shares — only `content` and the stop fields differ,
 *  and those are the only fields suggest.ts reads. */
const message = (over: Record<string, unknown>): Reply => ({
  status: 200,
  body: {
    id: "msg_test", type: "message", role: "assistant", model: "test-model",
    content: [], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...over,
  },
});

/** A clean, schema-shaped answer. */
const answer = (over: Record<string, unknown> = {}): Reply => message({
  content: [{
    type: "text",
    text: JSON.stringify({
      title: "Call the dentist", funnel: "task", scope: "Home", tags: ["health"],
      due: null, priority: null, rationale: "Reads as a next action.", ...over,
    }),
  }],
});

/** The model declining outright — a verdict on the note, not on the service. */
const refusal = (): Reply => message({
  content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "policy" },
});

/** An answer that is not JSON: a failure OF THE NOTE (suggest.ts throws a plain
 *  Error on the parse), which is the kind that spends one of its four lives. */
const garbage = (): Reply => message({ content: [{ type: "text", text: "I'm afraid I can't do that." }] });

/** A service failure. `x-should-retry: false` is honoured by the SDK's own retry
 *  policy, so the test gets exactly one fetch and no real sleeps — the retry under
 *  test is the WORKER's (a sidecar and a backoff), not the transport's. */
const serverError = (): Reply => ({
  status: 500,
  headers: { "x-should-retry": "false" },
  body: { type: "error", error: { type: "api_error", message: "internal" } },
});

const { tick } = await import("../src/worker.js");
const { readSidecar, writeSidecar } = await import("../src/suggest.js");
const { getIngestableScopes, getIngestableScopesStrict, invalidate } = await import("../src/vault.js");
import type { Sidecar } from "../src/suggest.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

// ── The scratch vault ───────────────────────────────────────────────────────

/** Write a scope note. `ingestable` is the tag the whole egress story turns on,
 *  so it is a parameter here rather than a fixture. */
const scopeNote = (name: string, ingestable: boolean) => {
  writeFileSync(join(VAULT, `${name}.md`), `---\ntags: [scope${ingestable ? ", ingestable" : ""}]\n---\n\n# ${name}\n`);
  invalidate(); // the index is on a 3s TTL; a test must not race it
};

/** Drop a capture into the inbox and return its name. */
const capture = (name: string, text: string): string => {
  writeFileSync(join(VAULT, "inbox", `${name}.md`), text);
  return name;
};

/** Empty the queue and the sidecar store between blocks, so a call count means
 *  what the block says it means. */
const reset = () => {
  for (const f of readdirSync(join(VAULT, "inbox"))) rmSync(join(VAULT, "inbox", f), { recursive: true });
  for (const f of readdirSync(DIR)) rmSync(join(DIR, f), { recursive: true });
  calls.length = 0;
  replies = [];
};

const sidecarNames = (): string[] => readdirSync(DIR);

console.log("test: nothing ingestable ⇒ nothing is sent, and the picker still works");
{
  // The two accessors disagreeing is the POINT: the allowlist fails closed while
  // the capture dropdown fails open, and both behaviours have to hold at once or
  // one of them is wrong. A vault whose `ingestable` tags were bulk-edited away
  // must lose its egress, not gain the whole table of contents.
  scopeNote("Home", false);
  scopeNote("Archive", false);
  capture("2026-08-09T10-00-00-000Z", "call the dentist");

  await tick(INTERVAL);
  check("no scope is tagged ingestable ⇒ no outbound call at all", calls.length === 0);
  check("…and no sidecar, so the queue resumes the moment a tag comes back", sidecarNames().length === 0);
  check("…while the capture dropdown still lists every scope", getIngestableScopes().length === 2);
  check("…and the list that decides what may leave is empty", getIngestableScopesStrict().length === 0);
}

console.log("test: a name that can never be triaged is never paid for");
{
  reset();
  scopeNote("Home", true);
  // Arrives by `git pull` — the inbox is a synced directory. It cannot be opened,
  // triaged or discarded, so a call about it buys a row nobody can clear.
  writeFileSync(join(VAULT, "inbox", "..evil.md"), "unreachable");
  capture("2026-08-09T10-00-01-000Z", "call the dentist");
  replies = [answer()];

  await tick(INTERVAL);
  check("the unsafe name costs exactly nothing — one note, one call", calls.length === 1);
  check("…and it was the triageable note that went", calls[0].includes("call the dentist"));
  check("…with no sidecar written under a name nothing can address",
    !sidecarNames().some((f) => f.includes("evil")));
}

console.log("test: a malformed sidecar never reaches the arithmetic");
{
  reset();
  const n = capture("2026-08-09T10-00-02-000Z", "renew the passport");
  // `attempts: "x"` is the one that used to end everything: 2 ** "x1" is NaN,
  // `new Date(now + NaN).toISOString()` throws a RangeError, and it throws from
  // INSIDE the failure handler — aborting the tick, on every tick, forever.
  writeFileSync(join(DIR, `sug_${n}.json`), JSON.stringify({
    v: 1, note: n, at: "now", state: "retry",
    attempts: "x", noteAttempts: 0, nextAttemptAt: "2020-01-01T00:00:00Z", error: "boom",
  }));
  replies = [garbage()];

  await tick(INTERVAL); // the assertion is that this returns at all
  const sc = await readSidecar(n);
  check("a sidecar with attempts:\"x\" reads as unattempted rather than taking the tick down",
    sc !== null);
  check("…and the counters it replaces are finite numbers, not NaN",
    sc?.state === "retry" && sc.attempts === 1 && sc.noteAttempts === 1);
  check("…with a backoff that is a real instant",
    sc?.state === "retry" && Number.isFinite(Date.parse(sc.nextAttemptAt)));
}

console.log("test: a refusal is terminal");
{
  reset();
  const n = capture("2026-08-09T10-00-03-000Z", "something the model declines");
  replies = [refusal()];

  await tick(INTERVAL);
  check("a refusal marks the note dead on the first attempt", (await readSidecar(n))?.state === "dead");
  // No reply is scripted, so a second call would fail the run outright — which is
  // exactly the guarantee: retrying a refusal burns tokens to be told no again.
  await tick(INTERVAL);
  check("…and dead means never again: the next tick asks nobody", calls.length === 1);
}

console.log("test: a note-level failure spends a life; a service failure never does");
{
  reset();
  const n = capture("2026-08-09T10-00-04-000Z", "an answer we can't parse");
  // MAX_ATTEMPTS is 4. Each round: fail, then drag the backoff into the past so
  // the next tick is eligible — the clock is not what's under test.
  for (let i = 0; i < 4; i++) {
    replies = [garbage()];
    await tick(INTERVAL);
    const sc = await readSidecar(n);
    if (sc?.state === "retry") await writeSidecar({ ...sc, nextAttemptAt: "2020-01-01T00:00:00Z" });
  }
  const dead = await readSidecar(n);
  check("four unusable answers about one note is a verdict on the note", dead?.state === "dead");
  check("…and it took exactly four calls to get there", calls.length === 4);

  reset();
  const m = capture("2026-08-09T10-00-05-000Z", "a note the service can't answer about");
  for (let i = 0; i < 6; i++) {
    replies = [serverError()];
    await tick(INTERVAL);
    const sc = await readSidecar(m);
    if (sc?.state === "retry") await writeSidecar({ ...sc, nextAttemptAt: "2020-01-01T00:00:00Z" });
  }
  const alive = await readSidecar(m) as Extract<Sidecar, { state: "retry" }> | null;
  // Six 5xx is past MAX_ATTEMPTS twice over. If they counted, a fifteen-minute
  // outage would bury every queued capture under a marker with no expiry and no
  // way to clear it from the UI — which is what it did.
  check("six service failures leave the note alive", alive?.state === "retry");
  check("…having spent none of its four lives", alive?.noteAttempts === 0);
  check("…while the backoff still moved on every one of them", alive?.attempts === 6);
  check("…and a 5xx costs one call, not the SDK's retries as well", calls.length === 6);
}

console.log("test: one bad note does not drop the batch");
{
  reset();
  // Newest first, and BATCH is 3 — so the fourth note waits for the next tick.
  const n4 = capture("2026-08-09T10-00-09-000Z", "note four");
  const n3 = capture("2026-08-09T10-00-08-000Z", "note three");
  const n2 = capture("2026-08-09T10-00-07-000Z", "note two");
  const n1 = capture("2026-08-09T10-00-06-000Z", "note one");
  replies = [garbage(), answer(), answer()];

  await tick(INTERVAL);
  check("the batch is capped at three, not 'the whole inbox after a restart'", calls.length === 3);
  check("the newest note is the one that went first", calls[0].includes("note four"));
  check("…its failure is recorded rather than thrown away", (await readSidecar(n4))?.state === "retry");
  check("…and the two behind it still got their suggestions",
    (await readSidecar(n3))?.state === "ok" && (await readSidecar(n2))?.state === "ok");
  check("a note that was never attempted has no sidecar to say otherwise",
    await readSidecar(n1) === null);

  replies = [answer()];
  await tick(INTERVAL);
  check("…and the next tick picks it up", (await readSidecar(n1))?.state === "ok");
}

console.log("test: the tick's sweep only ever deletes files it can prove are its own");
{
  reset();
  const live = capture("2026-08-09T10-00-10-000Z", "still queued");
  // A note that left the inbox by a path that bypasses triage — a hand delete, a
  // sync. Nothing else will ever remove its sidecar.
  await writeSidecar({ v: 1, note: "2026-01-01T00-00-00-000Z", at: "", state: "dead", attempts: 4, error: "gone" });
  // The disaster case: SUGGESTIONS_DIR pointed at PROPOSALS_DIR. The prefix check
  // is what stands between a tick and somebody else's queue.
  writeFileSync(join(DIR, "prop_1234.json"), JSON.stringify({ id: "prop_1234", status: "pending" }));
  writeFileSync(join(DIR, "sug_unparseable.json"), "{not json");
  writeFileSync(join(DIR, "notes.json"), "{}");
  replies = [answer()];

  await tick(INTERVAL);
  const left = sidecarNames();
  check("a sidecar whose note left the inbox is swept", !left.includes("sug_2026-01-01T00-00-00-000Z.json"));
  check("…but never a proposal", left.includes("prop_1234.json"));
  check("…nor a file under our own prefix we cannot prove is ours", left.includes("sug_unparseable.json"));
  check("…nor anything without the prefix at all", left.includes("notes.json"));
  check("…and the live note was suggested for in the same tick", (await readSidecar(live))?.state === "ok");
}

// LAST BLOCK. `persistBroken` latches for the life of the process by design, so
// every tick after this one is a no-op and nothing may be scheduled behind it.
console.log("test: a store it cannot write to stops the worker rather than the ceiling");
{
  reset();
  const good = capture("2026-08-09T10-00-12-000Z", "this one records fine");
  const blocked = capture("2026-08-09T10-00-11-000Z", "this one cannot be recorded");
  // A directory where the sidecar file goes: writeFile fails with EISDIR. Same
  // shape as the full or read-only volume this guard exists for, without needing
  // to be root to arrange it.
  mkdirSync(join(DIR, `sug_${blocked}.json`));
  replies = [answer(), answer()];

  await tick(INTERVAL);
  check("the failed write is contained — the tick returns rather than rejecting", true);
  check("…the note processed before it keeps its suggestion", (await readSidecar(good))?.state === "ok");
  check("…and both notes were asked about, so nothing was skipped on the way", calls.length === 2);

  // Attempt counts and `dead` markers live ONLY in these files. A store that
  // can't be written is a store with no cost ceiling, so every note would look
  // unattempted on every tick and be re-submitted at full price, forever. Stopping
  // is the loud, terminal failure that a silent retry loop is not.
  replies = [answer()];
  await tick(INTERVAL);
  check("with no way to record what it spends, the worker stops spending", calls.length === 2);
}

console.log(`\n${passed} checks passed`);
