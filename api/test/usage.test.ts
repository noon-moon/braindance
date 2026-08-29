// The daily ceiling — the one guard that lives outside the vault.
// Run: `npm run test:usage`.
//
// Everything else in this loop bounds a note: `bd_asked` stops one being
// re-read, the failure backoff stops one being re-classified, the per-pass cap
// bounds one queue. All three persist INTO THE VAULT, and all three vanished at
// once when the vault's notes became unwritable — 3189 billed calls over 56
// hours, ending only when the account hit zero.
//
// So the assertions that matter here are the ones about independence: this
// counter needs nothing from the vault, and being over it is never a verdict on
// a note.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bd-usage-"));
const STATE = join(dir, "spend.json");
process.env.BD_STATE_FILE = STATE;
process.env.BD_DAILY_TOKENS = "1000";

const { record, reset, report, spentToday, dailyCap, ledger, __resetLedgerForTests } = await import("../src/usage.js");
const { BudgetError, TransientError, RefusalError } = await import("../src/suggest.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
const today = () => new Date().toISOString().slice(0, 10);

console.log("test: the ledger counts a day, not a pass");
{
  __resetLedgerForTests();
  check("a fresh day is zero", spentToday().tokens === 0 && spentToday().calls === 0);
  check("the cap comes from the environment", dailyCap() === 1000);

  record("suggest", { input_tokens: 100, output_tokens: 20 });
  check("a call is charged to the day", spentToday().tokens === 120);
  check("…and counted", spentToday().calls === 1);

  // THE POINT. `reset()` clears the PASS tally; the day survives it, because
  // the runaway was 1440 passes each of which looked entirely reasonable.
  reset();
  check("a new pass does not clear the day", spentToday().tokens === 120);
  check("…while the pass tally itself does clear", report() === "no model calls");

  record("intent", { input_tokens: 800, output_tokens: 100 });
  check("the day accumulates across passes", spentToday().tokens === 1020);
  check("over the cap is over", spentToday().over);
}

console.log("test: being over budget is not a verdict on any note");
{
  const e = new BudgetError(1020, 1000);
  // LOAD-BEARING. `nextFailure` spends one of a note's four lives unless the
  // error is transient. A budget stop that counted would bury the whole queue
  // after four passes, for a reason that has nothing to do with any note in it.
  check("BudgetError IS a TransientError", e instanceof TransientError);
  check("…and so can never kill a note", e instanceof TransientError && !(e instanceof RefusalError));
  check("it says how to lift it", e.message.includes("BD_DAILY_TOKENS"));
  check("…and what it counted", e.message.includes("1020/1000"));
}

console.log("test: the ledger survives what the vault could not");
{
  writeFileSync(STATE, "{ not json at all");
  check("a corrupt ledger reads as zero rather than throwing", spentToday().tokens === 0);

  writeFileSync(STATE, JSON.stringify({ day: "1999-01-01", calls: 9, tokens: 999_999 }));
  check("yesterday's ledger does not spend today's budget", spentToday().tokens === 0);
  check("…and today is today", ledger().day === today());

  // The failure that started all this was a write it could not make. This one
  // warns and keeps going: refusing to work because the odometer is broken is
  // its own outage.
  process.env.BD_STATE_FILE = "/proc/nonexistent/spend.json";
  const { record: r2, spentToday: s2 } = await import(`../src/usage.js?nowrite=${Date.now()}`);
  r2("suggest", { input_tokens: 5, output_tokens: 5 });
  check("an unwritable ledger does not throw", s2().tokens === 0);
  process.env.BD_STATE_FILE = STATE;
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
