// What a pass cost. Nothing here changes behaviour; it makes behaviour visible.
//
// Every design in this loop guards against the same failure — a bill with no
// symptom. `bd_asked` stops an unreadable answer being re-read forever; the
// failure backoff stops a bad capture being re-classified forever; the per-pass
// cap bounds a runaway queue. All three are guesses until something counts.
//
// So every model call reports what it used, and a pass ends by saying what it
// spent. Not an estimate from token arithmetic — the numbers the API returned.
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface Tally { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }

const byLabel = new Map<string, Tally>();

export function record(label: string, u: Usage | undefined): void {
  if (!u) return;
  const t = byLabel.get(label) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  t.calls += 1;
  t.input += u.input_tokens ?? 0;
  t.output += u.output_tokens ?? 0;
  t.cacheRead += u.cache_read_input_tokens ?? 0;
  t.cacheWrite += u.cache_creation_input_tokens ?? 0;
  byLabel.set(label, t);
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
    lines.push(`  ${label.padEnd(10)} ${String(t.calls).padStart(3)} calls  ${String(t.input).padStart(7)} in  ${String(t.output).padStart(6)} out${t.cacheRead ? `  ${t.cacheRead} cached` : ""}`);
  }
  lines.push(`  ${"total".padEnd(10)} ${String(calls).padStart(3)} calls  ${String(input).padStart(7)} in  ${String(output).padStart(6)} out${cacheRead ? `  ${cacheRead} cached` : ""}`);
  return lines.join("\n");
}

export const reset = (): void => { byLabel.clear(); };
