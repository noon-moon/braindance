// Classifying a subprocess failure using only what the OPERATING SYSTEM says.
//
// `harness.ts` states that the failure taxonomy IS the interface — a
// TransientError never spends one of a note's four lives, a RefusalError is
// fatal at once, and a plain Error is a verdict on the note that spends one.
// Getting that backwards once turned a fifteen-minute outage into a permanently
// dead queue.
//
// A harness reached over the process boundary reports none of those. It reports
// an exit code, possibly a signal, and whatever it wrote. So the question is
// what can be decided WITHOUT knowing which harness it was, and the answer is
// better than it first looks.
//
// ── THE ASYMMETRY THIS RESTS ON ─────────────────────────────────────────────
//
// Blaming the note is the only irreversible judgement here. Four of them and the
// note is abandoned. Being too patient, by contrast, costs retries — and since
// the daily ceiling landed, retries are bounded. The two errors are not
// symmetric, so the classifier should not treat them as though they were.
//
// So the rule is one sentence:
//
//     A NOTE MAY ONLY BE BLAMED FOR OUTPUT WE ACTUALLY RECEIVED AND COULD NOT
//     USE. Everything else — the process failing to start, dying, timing out, or
//     exiting non-zero — is the environment's fault, not the note's.
//
// Every OS-level signal therefore maps to `transient`, and the ONLY route to a
// note-verdict is a clean exit whose output we then judge ourselves. That makes
// this function unable to wrongly kill a note: to reach a verdict, the harness
// has to have run to completion and produced something. The failure mode it
// accepts instead is retrying an unrunnable harness — visible in the vault on
// every note, and capped by `BD_DAILY_TOKENS`.
//
// It is also why this is OS-level and not harness-level: exit codes 1–125 are
// whatever an author decided they mean, and no portable reading of them exists.
// Treating that range as "we cannot tell, so do not blame the note" is the only
// honest thing to do with it, and it happens to be the safe thing too.
import { TransientError } from "./harness.js";

/** What a finished (or never-started) child process left behind. Deliberately
 *  the shape Node's own spawn results already have, so an implementation passes
 *  through what it got rather than translating first — a translation step is
 *  somewhere to lose the distinction this file exists to preserve. */
export interface ExitFacts {
  /** Exit status, or null when the child was killed by a signal. */
  code: number | null;
  /** Signal name when the kernel killed it — `SIGKILL` after an OOM, `SIGTERM`
   *  from a supervisor, `SIGSEGV` from a crash. */
  signal: string | null;
  /** Set when the process never started at all: ENOENT for a binary that is not
   *  there, EACCES for one that is not executable, ECONNREFUSED for a daemon
   *  that is not up. */
  spawnError?: NodeJS.ErrnoException | null;
  /** Set when WE killed it for taking too long. Ours, not the OS's, but it
   *  belongs in the same bucket: no verdict was ever reached about the note. */
  timedOut?: boolean;
}

/** Why a subprocess failure could not be a verdict on the note, in words that
 *  land in `bd_error` and are read on a phone. Returns null when the OS is
 *  telling us nothing is wrong — the caller then judges the output. */
export function transientReason(x: ExitFacts): string | null {
  if (x.spawnError) {
    const c = x.spawnError.code ?? "spawn failed";
    // ENOENT here is the harness binary, never the note. Worth naming: this is
    // the single most likely failure on a fresh deployment and the one whose
    // default reading — "something is wrong with the input" — is furthest off.
    return `harness could not start (${c})`;
  }
  if (x.timedOut) return "harness timed out";
  if (x.signal) return `harness killed by ${x.signal}`;
  if (x.code === null) return "harness ended without an exit status";
  // 126 and 127 are the shell's, not the program's, and they mean the same class
  // of thing as ENOENT: nothing ran.
  if (x.code === 127) return "harness not found (exit 127)";
  if (x.code === 126) return "harness not executable (exit 126)";
  if (x.code !== 0) return `harness exited ${x.code}`;
  return null;
}

/** The OS-level half of the taxonomy.
 *
 *  Throws a TransientError if the operating system reported anything at all
 *  wrong, and otherwise returns — leaving the caller to judge the OUTPUT, where
 *  a plain Error is the right answer and spends a life as it should.
 *
 *  `refine` is the one extension point, and it may only ever make the verdict
 *  HARSHER: an implementation that can recognise a refusal in its own output
 *  passes one, and it is consulted before the transient default. Nothing may
 *  turn a transient failure into silence. */
export function throwIfTransient(x: ExitFacts, refine?: (x: ExitFacts) => Error | null): void {
  const refined = refine?.(x);
  if (refined) throw refined;
  const reason = transientReason(x);
  if (reason !== null) throw new TransientError(reason, x.code);
}
