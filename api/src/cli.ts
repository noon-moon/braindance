// The applier, as a command. `tsx src/cli.ts propose <capture>` | `pass [--dry]`
//
// This replaces two scratch scripts that drifted the moment the module they
// called changed shape: `Proposal.scope` went plural and both kept building the
// singular field, failing at the first render with a type error a compiler would
// have caught the second it was written. A tool that operates on a vault has no
// business living outside the typecheck that guards the vault's own writers.
import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { VAULT } from "./config.js";
import { suggestFor, scopeCatalogue, type Suggestion } from "./suggest.js";
import { funnelById } from "./funnels.js";
import { getIngestableScopesStrict, takenRootNames, invalidate } from "./vault.js";
import { slug, noteName } from "./notes.js";
import { intentOf, validateAction } from "./intent.js";
import { reviseProposal, fileNote, mintHub, findCaptures } from "./applier.js";
import { renderTask, taskConfig } from "./tasknotes.js";
import {
  parseProposal, readReply, renderProposal, triageRel, keyOf, TRIAGE_DIR,
  markUnclear, alreadyAsked, isAnswered, stripMarker,
  parseFailure, renderFailure, nextFailure, markFailed, clearFailure, isDue, MAX_ATTEMPTS, type Proposal,
} from "./approval.js";
import { TransientError, RefusalError } from "./suggest.js";
import { report, reset } from "./usage.js";

const abs = (rel: string): string => join(VAULT, rel);

/** Say which vault this is operating on, every run, before doing anything.
 *
 *  There is no fallback any more — see config.ts. This says which vault out
 *  loud because the version that did not cost an evening. */
function announceVault(): void {
  if (!existsSync(VAULT)) {
    console.error(VAULT ? `no vault at ${VAULT}` : "VAULT_PATH is not set");
    process.exit(1);
  }
  console.log(`vault: ${VAULT}`);
}

/** A validated `Suggestion` as a `Proposal`. The one place the classifier's
 *  vocabulary is translated into the filer's, so a change to either shows up
 *  here rather than in three scripts. */
const asProposal = (s: Suggestion): Proposal => ({
  title: s.title,
  kind: funnelById(s.funnel)?.id ?? "memo",
  scopes: s.scope ? [s.scope] : [],
  newScope: s.newScope,
  tags: s.tags,
  due: s.due,
  priority: s.priority,
  rationale: s.rationale,
});

/** The vault's day, not UTC's. `toISOString()` rolls over mid-afternoon in the
 *  Americas, which would stamp a receipt with tomorrow — the same trap `TZ`
 *  already exists to close for `/todo`. */
function localISO(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace("Z", "");
}

/** The app's filing convention: a memo is found by its title and its link, so
 *  its filename is a legible slug; a HUB is addressed BY its filename, so it
 *  keeps the typed name. Collision-checked against the DIRECTORY, case-
 *  insensitively — the only test that can answer "would writing this truncate a
 *  note that already exists". */
/** Delete, tolerating a file that is already gone.
 *
 *  `unlinkSync` throwing here is worse than it sounds: by the time the capture
 *  is removed the FILED NOTE HAS ALREADY BEEN WRITTEN, so a throw ends the pass
 *  half-done — a new note created, its capture still in the queue, and every
 *  answer behind it unprocessed. There is always a window (the vault has other
 *  writers and obsidian-git is one of them), and "the file I wanted gone is
 *  gone" is not a failure whichever way it happened. */
function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

function uniqueDest(title: string, asTyped: boolean): string {
  const base = asTyped ? noteName(title) : slug(title);
  const taken = takenRootNames();
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  return `${name}.md`;
}

/** Classify one capture, or record why it could not be.
 *
 *  Every failure is caught HERE rather than at the top of the run. One capture
 *  the classifier chokes on used to take the whole pass down with it — silently,
 *  and for every other capture waiting behind it. */
async function propose(captureRel: string): Promise<void> {
  const key = keyOf(captureRel);
  const out = triageRel(key);
  mkdirSync(abs(TRIAGE_DIR), { recursive: true });
  // Gone between the scan and now — filed by hand, renamed, unsynced. Nothing
  // to classify and nothing worth remembering about it.
  if (!existsSync(abs(captureRel))) { console.log(`skip ${key} — capture is gone`); return; }
  try {
    const text = readFileSync(abs(captureRel), "utf8");
    const p = asProposal(await suggestFor(text, scopeCatalogue()));
    writeFileSync(abs(out), renderProposal(captureRel, p));
    console.log(`proposed → ${out}`);
  } catch (e) {
    const err = e as Error;
    const prior = existsSync(abs(out)) ? parseFailure(readFileSync(abs(out), "utf8")) : null;
    const f = nextFailure(prior, err.message, err instanceof TransientError, err instanceof RefusalError, Date.now());
    writeFileSync(abs(out), renderFailure(captureRel, f));
    console.warn(
      `failed ${key} (attempt ${f.attempts}` +
      `${err instanceof TransientError ? ", service" : `, note ${f.noteAttempts}/${MAX_ATTEMPTS}`}` +
      `${f.dead ? ", giving up" : `, next ${f.nextAt.slice(11, 16)}`}): ${err.message}`,
    );
  }
}

async function pass(dry: boolean, limit: number): Promise<void> {
  let dir: string[];
  try {
    dir = readdirSync(abs(TRIAGE_DIR));
  } catch {
    console.log("nothing waiting"); return;
  }
  const now = localISO();
  reset();
  let done = 0;
  for (const f of dir.filter((n) => n.endsWith(".triage.md"))) {
    if (done >= limit) { console.log(`\ncapped at ${limit} this pass — rerun for the rest`); break; }
    const rel = `${TRIAGE_DIR}/${f}`;
    const key = f.replace(/\.triage\.md$/, "");
    const raw = readFileSync(abs(rel), "utf8");
    const fail = parseFailure(raw);
    const parsed = parseProposal(raw, key);
    // TWO KINDS OF FAILED NOTE share this directory, and they retry differently.
    //
    // A pure failure note never became a proposal — classify itself failed —
    // so there is nothing here to act on and `propose()` owns its retry.
    // A PROPOSAL carrying failure state is one whose answer could not be read;
    // this loop owns that retry, so it must come back when the backoff expires
    // rather than being skipped forever.
    if (!parsed) {
      console.log(fail
        ? `skip ${key} — ${fail.dead ? "given up" : `failed, retry after ${fail.nextAt.slice(11, 16)}`}`
        : `skip ${key} — not a proposal`);
      continue;
    }
    if (fail && !isDue(fail, Date.now())) {
      console.log(`skip ${key} — ${fail.dead ? "given up on this answer" : `answer unread, retry after ${fail.nextAt.slice(11, 16)}`}`);
      continue;
    }

    let text = raw;
    const reply = readReply(text);
    if (!reply) { console.log(`wait ${key} — no answer yet`); continue; }
    // An answer is finished when it says so. Without this, obsidian-git commits
    // a half-typed one within a few minutes and it gets judged as if it were
    // the whole thought.
    if (!isAnswered(text)) { console.log(`wait ${key} — answered, but the marker is still disarmed`); continue; }
    // An answer already judged unreadable costs nothing to skip and a model call
    // to re-read. On a timer that difference is the whole running cost.
    if (alreadyAsked(text, reply)) { console.log(`wait ${key} — already asked about this answer`); continue; }
    console.log(`\n── ${key}\n   reply: ${JSON.stringify(reply)}`);

    // THE CAPTURE MUST STILL EXIST, and this is checked BEFORE the model call
    // rather than after it. An orphaned proposal — capture filed by hand,
    // renamed, or moved in Obsidian — has an armed answer that never changes, so
    // `alreadyAsked` never fires and the intent call was being made on it every
    // single pass. Once a minute. Forever. For a note that cannot be filed.
    //
    // The proposal goes with it: it describes a note that no longer exists, and
    // leaving it would orphan the queue permanently.
    if (!existsSync(abs(parsed.captureRel))) {
      console.log(`gone ${key} — capture ${parsed.captureRel} no longer exists, dropping the proposal`);
      if (!dry) remove(abs(rel));
      continue;
    }

    done += 1;
    const scopes = getIngestableScopesStrict();
    // The vault's day, not UTC's — "friday" has to be resolved against the day
    // the person is living in, and UTC is already tomorrow for half of every
    // evening in the Americas. Same trap as the receipt stamp.
    //
    // Caught per item: a reply the model cannot be asked about must not take
    // down the answers queued behind it. Nothing is written on failure — the
    // proposal and the capture stay exactly as they are, and the next pass
    // tries again, which is right because the person's answer is unchanged and
    // the failure was ours.
    let act;
    try {
      act = validateAction(
        await intentOf(reply, parsed.proposal, scopes, now.slice(0, 10)), scopes, takenRootNames());
    } catch (e) {
      // The classify path has always done this; the answer path used to warn to
      // the journal and drop it, which is a silent failure by any other name.
      const err = e as Error;
      const f = nextFailure(fail, err.message, err instanceof TransientError, err instanceof RefusalError, Date.now());
      if (!dry) writeFileSync(abs(rel), markFailed(text, f));
      console.warn(
        `   ✗ could not read the answer (attempt ${f.attempts}` +
        `${err instanceof TransientError ? ", service" : `, note ${f.noteAttempts}/${MAX_ATTEMPTS}`}` +
        `${f.dead ? ", giving up" : `, next ${f.nextAt.slice(11, 16)}`}): ${err.message}`,
      );
      continue;
    }
    // Got through. Clear any failure this note was carrying, so a recovered
    // proposal does not keep reading `failed` in Obsidian's properties panel.
    if (fail) text = clearFailure(text);
    console.log(`   action: ${act.kind}${act.note ? ` — ${act.note}` : ""}`);
    if (act.kind === "unclear") {
      const q = act.note || "I could not tell what you meant";
      console.log(`   ask again: ${q}`);
      if (!dry) writeFileSync(abs(rel), markUnclear(text, `${q} — say \`yes\`, \`discard\`, or name a hub`, reply));
      continue;
    }
    if (act.kind === "reclassify") { console.log("   left for another pass"); continue; }

    if (act.kind === "discard") {
      console.log(`   discard ${parsed.captureRel} + ${rel}`);
      if (!dry) { remove(abs(parsed.captureRel)); remove(abs(rel)); }
      continue;
    }

    const p = reviseProposal(parsed.proposal, act.revised);
    const body = readFileSync(abs(parsed.captureRel), "utf8");
    const filedUnder = [...(p.newScope ? [p.newScope.name] : []), ...p.scopes];

    // A TODO is not a note with a checklist line in it — in this vault a task
    // IS a note, in TaskNotes' folder, with its metadata in frontmatter. The
    // capture's prose rides in that note's body, so detail that used to need a
    // memo of its own no longer does.
    const isTask = p.kind === "todo";
    const dest = isTask
      ? `${taskConfig().folder}/${noteName(p.title)}.md`
      : uniqueDest(p.title, p.kind === "scope");
    const content = isTask
      ? renderTask({ title: p.title, scopes: filedUnder, due: p.due, priority: p.priority,
                     body: stripMarker(body), createdISO: now })
      : fileNote(p, body).content;

    console.log(`   file  → ${dest}`);
    if (p.newScope) console.log(`   mint  → ${noteName(p.newScope.name)}.md`);
    if (dry) { console.log(content.split("\n").map((l) => "   | " + l).join("\n")); continue; }
    if (p.newScope) writeFileSync(abs(`${noteName(p.newScope.name)}.md`), mintHub(p.newScope.name, p.newScope.why));
    mkdirSync(abs(dest.slice(0, dest.lastIndexOf("/"))), { recursive: true });
    writeFileSync(abs(dest), content);
    remove(abs(parsed.captureRel));
    remove(abs(rel));
    invalidate();
  }
  if (done) console.log(`\n${report()}`);
}

/** Everything ARMED and not yet proposed. The queue is the marker, not a folder:
 *  a capture can be written anywhere Obsidian happens to put it, and nothing is
 *  ever picked up by accident. */
function pending(): { due: string[]; held: number } {
  const now = Date.now();
  const held = new Set<string>();
  try {
    for (const f of readdirSync(abs(TRIAGE_DIR))) {
      if (!f.endsWith(".triage.md")) continue;
      const key = f.replace(/\.triage\.md$/, "");
      const fail = parseFailure(readFileSync(abs(`${TRIAGE_DIR}/${f}`), "utf8"));
      // A proposal holds its capture (it is waiting on a person). A FAILURE
      // holds it only until the backoff expires, and a dead one holds it for
      // good — that is the difference between patient and stuck.
      if (!fail || !isDue(fail, now)) held.add(key);
    }
  } catch { /* no queue yet */ }
  const armed = findCaptures(VAULT);
  return { due: armed.filter((rel) => !held.has(keyOf(rel))), held: armed.filter((rel) => held.has(keyOf(rel))).length };
}

/** How many captures one run may classify. A ceiling rather than a rate: the
 *  worst case is what matters, and the worst case is something arming a hundred
 *  notes at once. Whatever it skips is NAMED — a silent truncation reads as
 *  "handled everything". */
const DEFAULT_LIMIT = 10;

/** Flags out, positionals in. Written because `propose --limit 10` took
 *  `--limit` as the capture to classify and then recorded four patient retries
 *  against a file of that name — a bug that only looks silly until you notice
 *  it wrote a failure note into the vault. */
function parseArgs(args: string[]): { flags: Map<string, string>; rest: string[] } {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) { flags.set(k, inline); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(k, next); i++; }
    else flags.set(k, "true");
  }
  return { flags, rest };
}

const limitOf = (flags: Map<string, string>): number => {
  const n = Number(flags.get("limit"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
};

const [cmd, ...argv] = process.argv.slice(2);
const { flags, rest } = parseArgs(argv);
if (cmd === "propose" && rest[0]) { announceVault(); await propose(rest[0]); }
else if (cmd === "propose") {
  announceVault();
  const limit = limitOf(flags);
  const { due: todo, held } = pending();
  // "nothing is armed" was a lie whenever something WAS armed and simply held by
  // its own backoff — which is the state a failed capture spends most of its
  // time in, and the state you are most likely to be staring at.
  if (!todo.length) {
    console.log(held ? `nothing due — ${held} armed but held (failed, or awaiting an answer)` : "nothing is armed — no #capture waiting");
  }
  for (const rel of todo.slice(0, limit)) await propose(rel);
  if (todo.length > limit) console.log(`\n${todo.length - limit} more waiting — capped at ${limit} this pass`);
  if (todo.length) console.log(`\n${report()}`);
} else if (cmd === "find") {
  announceVault();
  const { due, held } = pending();
  console.log(due.length ? due.join("\n") : "nothing due");
  if (held) console.log(`(${held} armed but held)`);
} else if (cmd === "pass") { announceVault(); await pass(flags.has("dry"), limitOf(flags)); }
else {
  console.error("usage: cli.ts find | propose [<capture-path>] [--limit N] | pass [--dry] [--limit N]");
  process.exit(1);
}
