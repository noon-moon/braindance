// What a pass cost. Nothing here changes behaviour; it makes behaviour visible.
//
// Every design in this loop guards against the same failure — a bill with no
// symptom. `bd_asked` stops an unreadable answer being re-read forever; the
// failure backoff stops a bad capture being re-classified forever; the per-pass
// cap bounds a runaway queue. All three are guesses until something counts.
//
// So every model call reports what it used, and a pass ends by saying what it
// spent. Not an estimate from token arithmetic — the numbers the API returned.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface Tally { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; estimated: boolean }

const byLabel = new Map<string, Tally>();

/** Record what a call used.
 *
 *  `estimated` is for a harness that cannot report real numbers. It is allowed,
 *  and it is MARKED — an estimate that looks like a measurement is worse than no
 *  number, because the ceiling is computed from these and a silent guess makes
 *  the ceiling a guess too. Estimates must also be generous: see `estimateUsage`.
 *  Prefer real numbers wherever the harness will give them, which is more often
 *  than it looks — a CLI that says nothing on stdout may still be reporting
 *  usage on stderr. */
export function record(label: string, u: Usage | undefined, estimated = false): void {
  if (!u) return;
  const t = byLabel.get(label) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: false };
  if (estimated) t.estimated = true;
  t.calls += 1;
  t.input += u.input_tokens ?? 0;
  t.output += u.output_tokens ?? 0;
  t.cacheRead += u.cache_read_input_tokens ?? 0;
  t.cacheWrite += u.cache_creation_input_tokens ?? 0;
  byLabel.set(label, t);
  charge(u);
}

/** One line per kind of call, plus a total. Printed at the end of a pass.
 *
 *  No dollar figure: prices change (Sonnet 5's introductory rate ends
 *  2026-08-31) and a number baked in here would be quietly wrong forever. Tokens
 *  are the thing this code can actually know. */
export function report(): string {
  if (!byLabel.size) return "no model calls";
  const lines: string[] = [];
  let calls = 0, input = 0, output = 0, cacheRead = 0;
  for (const [label, t] of [...byLabel].sort()) {
    calls += t.calls; input += t.input; output += t.output; cacheRead += t.cacheRead;
    lines.push(`  ${label.padEnd(10)} ${String(t.calls).padStart(3)} calls  ${t.estimated ? "≈" : " "}${String(t.input).padStart(6)} in  ${t.estimated ? "≈" : " "}${String(t.output).padStart(5)} out${t.cacheRead ? `  ${t.cacheRead} cached` : ""}`);
  }
  lines.push(`  ${"total".padEnd(10)} ${String(calls).padStart(3)} calls  ${String(input).padStart(7)} in  ${String(output).padStart(6)} out${cacheRead ? `  ${cacheRead} cached` : ""}`);
  // THE DAY, on every pass. A per-pass figure is what made the runaway
  // invisible: each individual pass looked entirely reasonable, and there were
  // 1440 of them. A number you have to integrate over three days by hand is not
  // a number anybody reads.
  lines.push(`  ${"today".padEnd(10)} ${dayLine()}`);
  return lines.join("\n");
}

/** The day's running total against the ceiling, as one readable fragment. */
export function dayLine(): string {
  const d = spentToday();
  const pct = Math.round((d.tokens / d.cap) * 100);
  return `${d.calls} calls  ${d.tokens} tokens  ${pct}% of the ${d.cap} daily cap${d.over ? "  ← REACHED, no further calls until UTC midnight" : ""}`;
}

export const reset = (): void => { byLabel.clear(); };


// ── THE DAILY CEILING ───────────────────────────────────────────────────────
//
// Everything above this line COUNTS. Nothing above it STOPS anything, and the
// header says why that was thought sufficient: three guards already bound the
// loop — `bd_asked`, the failure backoff, the per-pass cap.
//
// All three failed together, for one reason. Something ran as root in the vault
// and left the notes owned by root. Every write then failed with EACCES, so
// `bd_asked` could not be recorded and the marker could not be disarmed — and a
// guard that cannot persist is not a guard. The per-pass cap held perfectly and
// was irrelevant: it bounds a pass, and the problem was 1440 passes a day. 3189
// billed calls over 56 hours, ending when the account hit zero.
//
// The lesson is not "add a fourth guard of the same kind". It is that every
// guard up to now lived in the vault, and the vault was exactly what had broken.
// This one lives OUTSIDE it, holds no opinion about any note, and needs nothing
// to be writable except its own state file. It is the backstop for the case
// where the other three are gone.

/** Outside the vault ON PURPOSE — see above. Also outside the repo, so a
 *  redeploy does not reset the day's ledger and hand a runaway a fresh budget. */
const STATE_FILE = process.env.BD_STATE_FILE?.trim()
  || join(process.env.BD_STATE_DIR?.trim() || join(process.env.HOME || "/tmp", ".local/state/braindance"), "spend.json");

/** UTC, matching the box, and matching what `journalctl` prints. A ledger whose
 *  day boundary disagrees with the logs is one you cannot reconcile by eye. */
const today = (): string => new Date().toISOString().slice(0, 10);

/** Tokens per day, input + output summed. Not dollars: prices change (this file
 *  already says so about the report), and a cap that goes quietly wrong when a
 *  rate does is worse than one expressed in the unit the code can actually know.
 *
 *  500k is roughly a hundred captures a day — far above real use, and far below
 *  a runaway. It would have stopped the incident above at about $1 rather than
 *  $20, on the first day rather than the third. */
export const dailyCap = (): number => {
  const n = Number(process.env.BD_DAILY_TOKENS ?? 500_000);
  return Number.isFinite(n) && n > 0 ? n : 500_000;
};

interface Ledger { day: string; calls: number; tokens: number }

const emptyLedger = (): Ledger => ({ day: today(), calls: 0, tokens: 0 });

/** Read the day's ledger. A new day, an unreadable file, or a corrupt one all
 *  mean the same thing: start from zero. This must never throw — a budget
 *  backstop that can crash the pass is a liability, not a guard. */
export function ledger(): Ledger {
  try {
    const l = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<Ledger>;
    if (l && l.day === today() && typeof l.tokens === "number" && typeof l.calls === "number") {
      return { day: l.day, calls: l.calls, tokens: l.tokens };
    }
  } catch { /* absent, unreadable, or yesterday's — all mean zero */ }
  return emptyLedger();
}

/** Add a call to the day's ledger. Best-effort by design: if this cannot be
 *  written the loop still runs, because refusing to work when the ODOMETER is
 *  broken is its own outage. The `warn` is the symptom — silence is what this
 *  whole file exists to prevent. */
function persist(l: Ledger): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(l));
  } catch (e) {
    console.warn(`warning: could not write the spend ledger at ${STATE_FILE}: ${(e as Error).message}`);
  }
}

/** How much of today is gone. */
export const spentToday = (): { calls: number; tokens: number; cap: number; over: boolean } => {
  const l = ledger();
  const cap = dailyCap();
  return { calls: l.calls, tokens: l.tokens, cap, over: l.tokens >= cap };
};

/** Charge a completed call against the day. Called from `record()`, so every
 *  path that reports usage also pays for it — there is no way to make a call
 *  that counts for the pass report and not for the day. */
function charge(u: Usage): void {
  const l = ledger();
  l.calls += 1;
  l.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  persist(l);
}

/** Only for tests, and named so nobody reaches for it by accident. */
export const __resetLedgerForTests = (): void => persist(emptyLedger());


/** A DELIBERATELY GENEROUS token estimate, for a harness that will not report
 *  real usage.
 *
 *  Four characters per token is the usual rule of thumb and it is an average;
 *  code, punctuation and non-Latin scripts all run denser. An estimate that
 *  averages correctly is the wrong tool here, because this number feeds a
 *  CEILING: guessing low means the cap trips late, which is precisely the
 *  failure it exists to prevent, while guessing high means it trips early and
 *  says so in the vault. So this rounds up and adds a third again.
 *
 *  It is a governor, not an accounting record. Anyone reconciling against a bill
 *  should use the provider's numbers. */
export const estimateUsage = (promptChars: number, replyChars: number): Usage => ({
  input_tokens: Math.ceil((promptChars / 4) * 1.33),
  output_tokens: Math.ceil((replyChars / 4) * 1.33),
});
