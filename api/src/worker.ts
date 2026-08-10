// The suggestion worker — the only thing in this app that makes an outbound call.
//
// It scans the inbox on an interval for captures that don't have a suggestion
// yet, asks for one, and writes the answer to a sidecar (suggest.ts). That is the
// whole loop. It holds no durable state of its own: what has been tried, what
// failed, and when to try again all live in the sidecar files.
//
// Those files therefore have to OUTLIVE the container. SUGGESTIONS_DIR is a named
// docker volume (docker-compose.yml) for exactly this reason — mounted nowhere,
// it would land in the container's writable layer, every deploy would wipe every
// `dead` marker, and a restart would re-suggest the whole inbox at full price.
// The cost ceilings below are only real while that volume is.
//
// It is started from index.ts ONLY when AI_SUGGEST=1 and a key is present. With
// either absent this module's tick never runs and the app is byte-for-byte the
// app it was before — no client is constructed, no request is made, and the pane
// renders its empty state.
import { listInbox } from "./inbox.js";
import { aiSuggestConfig, stateDirConflict } from "./config.js";
import {
  RefusalError, TransientError, pruneSidecars, readSidecar, scopeCatalogue, suggestFor, noteBody,
  writeSidecar, type ScopeBlurb, type Sidecar,
} from "./suggest.js";

/** Notes per tick. Small on purpose: the queue is a handful of captures a day,
 *  the work is not urgent, and a burst of parallel calls after a container
 *  restart (when every note looks new) is the one way this could be expensive. */
const BATCH = 3;

/** How many NOTE-LEVEL failures a note may take before it is marked permanently
 *  failed. A capture the model chokes on is rare; a capture the model chokes on
 *  FOREVER, retried every minute for the life of the container, is a bill.
 *
 *  Service-level failures (TransientError) are deliberately not counted: they say
 *  nothing about the note, and counting them meant a fifteen-minute 5xx window
 *  buried every queued capture under a `dead` marker with no expiry and no way to
 *  clear it from the UI. */
const MAX_ATTEMPTS = 4;

const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Ticks never overlap: a slow batch must not have the next interval start a
 *  second one behind it, or a stalled API turns into unbounded concurrency. */
let running = false;

/** Set when a sidecar write fails. Attempt counts and `dead` markers live ONLY in
 *  those files, so a store we cannot write to is a store with no cost ceiling at
 *  all — every note would look unattempted on every tick and be re-submitted at
 *  full price, indefinitely. A disk that is full or read-only does not fix itself
 *  on a timer, so this stops the loop until an operator restarts the container,
 *  which is the loud, terminal failure the alternative is not. */
let persistBroken = false;

/** Logged once per condition, not once per tick: a worker that cannot run has one
 *  thing to say and says it at the interval otherwise. */
const said = new Set<string>();
const sayOnce = (key: string, msg: string): void => {
  if (said.has(key)) return;
  said.add(key);
  console.warn(msg);
};

/** One pass over the queue. Exported for tests, alongside the stop function
 *  below and for the same reason: every decision that costs money or kills a note
 *  lives in here and in `recordFailure`, and a test that could only reach them
 *  through `setInterval` would be a test of the timer. `intervalMs` is a
 *  parameter rather than a re-read of the config because the backoff is derived
 *  from it — one number, passed down, so a tick cannot back off on a different
 *  interval than the one it runs on. */
export async function tick(intervalMs: number): Promise<void> {
  if (running || persistBroken) return;
  running = true;
  try {
    // Newest first (listInbox's order) — the capture you just made is the one
    // you're most likely to open the desk for.
    const inbox = listInbox();
    await pruneSidecars(new Set(inbox.map((n) => n.name))).catch(() => undefined);

    // Read the scope catalogue once per tick, not once per note: it is the same
    // list for every note in the batch, and re-deriving it would re-walk the
    // vault index for no reason.
    //
    // Read BEFORE any work is selected, because an empty catalogue means no work
    // at all. The names in it are what leaves the box; when the vault marks
    // nothing ingestable there is no allowlist, and a run with no allowlist is
    // not a cheaper run, it is the wrong run. Nothing is sent and no sidecar is
    // written, so the moment a tag comes back the queue picks up where it was.
    const scopes = scopeCatalogue();
    if (!scopes.length) {
      sayOnce("no-scopes", "suggest: no scopes tagged `ingestable` — sending nothing until one is");
      return;
    }
    said.delete("no-scopes"); // it came back; say it again if it goes away again

    const now = Date.now();
    const todo: { note: (typeof inbox)[number]; prior: Sidecar | null }[] = [];
    for (const note of inbox) {
      if (todo.length >= BATCH) break;
      const sc = await readSidecar(note.name);
      // No sidecar = never attempted. `retry` = attempted and failed, eligible
      // once its backoff elapses. `ok` and `dead` are both terminal — one has an
      // answer, the other never will.
      if (sc === null || (sc.state === "retry" && Date.parse(sc.nextAttemptAt) <= now)) todo.push({ note, prior: sc });
    }
    if (!todo.length) return;

    const { model } = aiSuggestConfig();

    for (const { note, prior } of todo) {
      // One note's failure is one note's failure. Everything below this line runs
      // inside a per-note boundary so that a single bad note — or a single failed
      // WRITE, which used to escape from inside the error handler itself — cannot
      // drop the rest of the batch on the floor, leaving notes that were never
      // attempted looking exactly like notes that were.
      try {
        await handleNote(note.name, noteBody(note), prior, scopes, model, intervalMs);
      } catch (e) {
        console.warn(`suggest: ${note.name} could not be processed: ${(e as Error).message}`);
      }
      if (persistBroken) break; // the ceiling is gone; stop spending
    }
  } catch (e) {
    // A thrown tick must not take the interval — or the server — with it.
    console.warn(`suggest: tick failed: ${(e as Error).message}`);
  } finally {
    running = false;
  }
}

/** One note, start to finish: ask, then record what happened. Every exit writes a
 *  sidecar, because a note whose outcome isn't recorded is a note that will be
 *  asked about again at full price on the next tick. */
async function handleNote(
  name: string,
  body: string,
  prior: Sidecar | null,
  scopes: ScopeBlurb[],
  model: string,
  intervalMs: number,
): Promise<void> {
  const at = new Date().toISOString();
  const suggestion = await suggestFor(body, scopes).catch(async (e: Error) => {
    await recordFailure(name, at, prior, e, intervalMs);
    return null;
  });
  if (suggestion) await persist({ v: 1, note: name, at, state: "ok", model, suggestion });
}

/** Turn a failure into the sidecar that decides whether this note is ever asked
 *  about again. The only judgement here is which counter the failure lands in. */
async function recordFailure(
  name: string, at: string, prior: Sidecar | null, e: Error, intervalMs: number,
): Promise<void> {
  const attempts = (prior?.state === "retry" ? prior.attempts : 0) + 1;
  // A refusal is a verdict on the note, and so is an answer we couldn't use. A
  // TransientError is a verdict on nothing — the service was unreachable, rate
  // limited, or misconfigured — so it moves the backoff but never the counter
  // that kills the note.
  const transient = e instanceof TransientError;
  const noteAttempts = (prior?.state === "retry" ? prior.noteAttempts : 0) + (transient ? 0 : 1);
  const error = e.message;

  // The marker exists so "never again" is true — without one the note would look
  // untried on the next tick and be re-submitted forever.
  const dead = e instanceof RefusalError || noteAttempts >= MAX_ATTEMPTS;
  if (dead) {
    await persist({ v: 1, note: name, at, state: "dead", attempts, error });
  } else {
    // Exponential on TOTAL attempts, so an outage backs off to the hourly ceiling
    // and sits there instead of hammering — patient rather than dead.
    const backoff = Math.min(intervalMs * 2 ** attempts, MAX_BACKOFF_MS);
    await persist({
      v: 1, note: name, at, state: "retry", attempts, noteAttempts, error,
      nextAttemptAt: new Date(Date.now() + backoff).toISOString(),
    });
  }
  console.warn(
    `suggest: ${name} failed (attempt ${attempts}${transient ? ", service" : `, note ${noteAttempts}/${MAX_ATTEMPTS}`}${dead ? ", giving up" : ""}): ${error}`,
  );
}

/** Write a sidecar, or declare the worker unable to bound its own cost. */
async function persist(sc: Sidecar): Promise<void> {
  try {
    await writeSidecar(sc);
  } catch (e) {
    persistBroken = true;
    console.error(
      `suggest: STOPPING — cannot write the sidecar for ${sc.note} (${(e as Error).message}). ` +
      "Attempt counts live in these files; without them every note re-submits at full cost each tick. " +
      "Fix the suggestions volume and restart the container.",
    );
    throw e; // the per-note boundary logs it; the batch loop stops on the flag
  }
}

/** Start the scan loop. Returns a stop function (the api runs until the process
 *  ends, so nothing calls it today — it exists so a test can). */
export function startSuggestWorker(): () => void {
  const { model, intervalMs } = aiSuggestConfig();
  // Refuse rather than degrade. Pointed at the proposals directory the store's
  // prune sweep is a mass delete of somebody else's queue; that is a
  // configuration error to shout about at boot, not to survive at runtime.
  const conflict = stateDirConflict();
  if (conflict) {
    console.error(`suggest worker: NOT STARTING — ${conflict}. Set SUGGESTIONS_DIR to its own directory.`);
    return () => undefined;
  }
  const timer = setInterval(() => void tick(intervalMs), intervalMs);
  // The worker is a background nicety; it must never be the reason the process
  // refuses to exit.
  timer.unref();
  void tick(intervalMs); // don't make the first capture after a boot wait a full interval
  console.log(`suggest worker: ${model}, every ${Math.round(intervalMs / 1000)}s`);
  return () => clearInterval(timer);
}
