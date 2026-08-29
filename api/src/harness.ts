// The seam between this loop and whatever answers its two questions.
//
// Everything else here is harness-independent already: `validate` and
// `validateAction` check values against the live vault, `nextFailure` decides
// what a failure costs a note, and every write goes through `approval.ts`. What
// is NOT independent is two calls, and this file is their contract.
//
// ── THE TWO QUESTIONS ───────────────────────────────────────────────────────
//
//   classify(note, scopes)                  →  where does this belong?
//   readIntent(reply, proposal, scopes, day) →  what did they just tell me to do?
//
// Both are text in, structured data out, and neither may touch the vault. That
// is the whole surface. A second implementation — a different provider, a local
// model, an agent harness — implements these two and nothing else.
//
// ── WHAT AN IMPLEMENTATION ACTUALLY OWES ────────────────────────────────────
//
// The signatures are the easy part and the least of it. Three obligations
// matter more, and each one is a thing this loop has already been broken by:
//
//  1. THE FAILURE TAXONOMY IS THE INTERFACE. Every failure must arrive as
//     exactly one of three kinds, because `nextFailure` spends a note's four
//     lives based on which:
//
//       TransientError   nothing to do with the note — a 5xx, a rate limit, a
//                        refused connection, a key the deployment got wrong, a
//                        subprocess that died. Never spends a life. Getting this
//                        wrong in the other direction is what once turned a
//                        fifteen-minute outage into a permanently dead queue.
//       RefusalError     the provider declined this note. Fatal immediately —
//                        retrying buys another no.
//       plain Error      a verdict ON THE NOTE: unparseable output, output that
//                        failed validation, a truncated response. Spends a life,
//                        and four of them gives up.
//
//     A harness that reports failure as an exit code and a line of stderr has to
//     MAP that onto these three. That mapping is the risky part of any new
//     implementation, and it is the part to write tests for first.
//
//  2. USAGE MUST BE COUNTED, AND SAID TO BE WHAT IT IS. Call `record()` with
//     what the provider reported. Look harder than seems necessary before
//     concluding a harness cannot tell you: `polytoken exec` prints nothing
//     about usage on stdout and reports it in full on stderr under
//     `--print-session-logs`, as `agent.invocation.usage`. A harness that is
//     genuinely silent may be estimated with `estimateUsage`, passing
//     `estimated: true` so the pass report marks it `≈` — an estimate that
//     looks like a measurement makes the ceiling a guess without saying so.
//     Estimates round UP, because this number feeds a cap: guessing low means
//     the cap trips late, which is the failure it exists to prevent.
//
//  3. SEND ONLY WHAT THE CALLER GAVE YOU. No ambient context — no project
//     files, no repo conventions, no working-directory-dependent preamble.
//     `classify` gets a note and a scope catalogue, and anything else in that
//     request is something nobody chose to put there.
//
//     Not hypothetical. Polytoken injects `AGENTS.md` from the project root on
//     every turn (falling back to `CLAUDE.md`, then `GEMINI.md`), and this repo
//     has both. Those files instruct a CODING agent about worktree discipline
//     and commit conventions; in a prompt whose job is choosing which hub a note
//     belongs under they are noise at best, and the damage would be invisible —
//     the classifications would simply get slightly worse. Measured cost of a
//     harness's own preamble on a trivial classify: 14467 cache-creation tokens
//     from a directory containing nothing at all, against ~3350 total for the
//     same work through a direct API call.
//
//  4. UNTRUSTED TEXT STAYS DATA. `classify` receives a capture someone may have
//     pasted from the internet; it must reach the model fenced and neutralised,
//     and nothing in the response may be trusted before `validate`. `readIntent`
//     must NOT be handed the capture at all — it is the call whose output can
//     delete a note, and keeping the untrusted bytes out of that request is a
//     stated property of this design, not an accident of the current prompt.
//
// ── WHAT THIS SEAM DELIBERATELY DOES NOT ABSTRACT ───────────────────────────
//
// The daily ceiling. It is enforced HERE, in `withBudget`, so it applies to
// every implementation rather than being something each one remembers. A
// harness cannot opt out of being metered by being new.
import { spentToday } from "./usage.js";
import type { ScopeBlurb, Suggestion } from "./suggest.js";
import type { Proposal } from "./approval.js";

/** The provider declined this note outright. A verdict, not a fault: retrying
 *  buys another no, so it is fatal on the first occurrence. */
export class RefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`refused${category ? ` (${category})` : ""}`);
    this.name = "RefusalError";
  }
}

/** The call failed for a reason with NOTHING to do with the note: a 5xx, a rate
 *  limit, a refused connection, a timeout, a key the deployment got wrong, a
 *  subprocess that would not start.
 *
 *  The distinction is load-bearing rather than cosmetic. Attempts against a fixed
 *  ceiling are the right answer to "this note always fails" and exactly the wrong
 *  one to "the service was down for a quarter of an hour", where they would bury
 *  the whole queue permanently for an outage that fixed itself. */
export class TransientError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "TransientError";
  }
}

/** The day's token ceiling is reached, so this call was never made.
 *
 *  A TransientError SUBCLASS, and that is the design: being over budget is not a
 *  verdict on the note in hand, so it must not spend one of its four lives. It
 *  inherits the backoff and the never-kills-a-note rule, and every existing
 *  `instanceof TransientError` is already correct about it.
 *
 *  Unlike its parent it costs nothing, because no request is sent at all. Every
 *  other guard here reacts to a call that already happened; this is the only one
 *  that stops one. */
export class BudgetError extends TransientError {
  constructor(readonly spent: number, readonly cap: number) {
    super(`daily token budget reached: ${spent}/${cap} — raise BD_DAILY_TOKENS or wait for UTC midnight`, null);
    this.name = "BudgetError";
  }
}

/** The two questions, and nothing else.
 *
 *  `readIntent` returns `unknown` rather than a typed Action on purpose: the
 *  caller runs it through `validateAction` against the LIVE vault, and handing
 *  back a typed value here would imply a promise this layer cannot make. The
 *  asymmetry with `classify` (which validates internally) is inherited from the
 *  code this was extracted from, and is the first thing worth tidying if a second
 *  implementation makes it awkward. */
export interface Harness {
  /** For logs and failure messages — which harness answered, or didn't. */
  readonly name: string;
  classify(noteText: string, scopes: ScopeBlurb[]): Promise<Suggestion>;
  readIntent(reply: string, proposal: Proposal, liveScopes: string[], today: string): Promise<unknown>;
}

/** Wrap a harness so the day's ceiling applies to it whether or not it thought
 *  about the day's ceiling. Applied by `harness()` to everything it returns, so
 *  being a new implementation is not a way to become unmetered. */
export function withBudget(h: Harness): Harness {
  const guard = (): void => {
    const day = spentToday();
    if (day.over) throw new BudgetError(day.tokens, day.cap);
  };
  return {
    name: h.name,
    classify: (note, scopes) => { guard(); return h.classify(note, scopes); },
    readIntent: (reply, p, scopes, today) => { guard(); return h.readIntent(reply, p, scopes, today); },
  };
}


/** Which harness this deployment uses. One name today, and the registry exists
 *  so adding the second is an entry here rather than an edit at two call sites.
 *
 *  Resolved lazily and per call rather than cached: a wrong `BD_HARNESS` should
 *  fail on the pass that used it, naming what it looked for, not at import time
 *  where the message lands in whatever log happened to be open. */
export async function harness(name = process.env.BD_HARNESS?.trim() || "anthropic"): Promise<Harness> {
  switch (name) {
    case "anthropic": {
      const { anthropicHarness } = await import("./harness-anthropic.js");
      return withBudget(anthropicHarness());
    }
    default:
      throw new Error(`unknown BD_HARNESS "${name}" — known: anthropic`);
  }
}

// The OS-level half of obligation 1 lives in `harness-subprocess.ts`, and is
// worth reading before writing any harness reached over a process boundary: it
// establishes that every signal the operating system gives is `transient`, so
// the only route to blaming a note is output that actually arrived. That makes
// a subprocess harness unable to kill a note by accident, which is the failure
// worth designing against — being too patient merely costs retries, and the
// daily ceiling bounds those.
export { throwIfTransient, transientReason, type ExitFacts } from "./harness-subprocess.js";
