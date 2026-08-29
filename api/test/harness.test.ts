// The seam — what a second implementation is actually promised, and held to.
// Run: `npm run test:harness`.
//
// The interface is two methods and would be dull to test. What is worth testing
// is everything an implementation CANNOT opt out of, because those are the
// properties that make adding one safe rather than merely possible.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bd-harness-"));
process.env.BD_STATE_FILE = join(dir, "spend.json");
process.env.BD_DAILY_TOKENS = "1000";

const { withBudget, harness, BudgetError, TransientError, RefusalError } = await import("../src/harness.js");
const { __resetLedgerForTests, record } = await import("../src/usage.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
const caught = async (fn: () => Promise<unknown>): Promise<Error | null> => {
  try { await fn(); return null; } catch (e) { return e as Error; }
};

// A harness that knows nothing about budgets, usage, or good manners. Exactly
// what a first draft of a second implementation looks like.
let calls = 0;
const naive = {
  name: "naive",
  classify: async () => { calls++; return {} as never; },
  readIntent: async () => { calls++; return {}; },
};

console.log("test: the ceiling is not something an implementation can forget");
{
  __resetLedgerForTests();
  const h = withBudget(naive);

  calls = 0;
  await h.classify("note", []);
  check("under budget, the call goes through", calls === 1);

  record("classify", { input_tokens: 900, output_tokens: 200 });
  calls = 0;
  const e1 = await caught(() => h.classify("note", []));
  check("over budget, classify is refused", e1 instanceof BudgetError);
  // THE POINT. `naive` never checks anything; the seam does it for it.
  check("…and the implementation was never reached", calls === 0);

  const e2 = await caught(() => h.readIntent("yes", {} as never, [], "2026-08-29"));
  check("readIntent is refused too", e2 instanceof BudgetError);
  check("…still without reaching the implementation", calls === 0);
  check("the refusal says how to lift it", (e1 as Error).message.includes("BD_DAILY_TOKENS"));
  check("the wrapper keeps the implementation's name for logs", h.name === "naive");
}

console.log("test: the failure taxonomy, which is the real interface");
{
  // `nextFailure` spends a note's four lives on exactly this distinction, so
  // these relationships are load-bearing rather than tidy.
  check("a budget stop is transient — it is not a verdict on any note",
    new BudgetError(1, 2) instanceof TransientError);
  check("a refusal is NOT transient — it is a verdict, and retrying buys another no",
    !(new RefusalError("cyber") instanceof TransientError));
  check("a transient failure is not a refusal", !(new TransientError("api 500", 500) instanceof RefusalError));
  // The third kind is a bare Error, and its defining property is being neither.
  const verdict = new Error("model output failed validation");
  check("a verdict on the note is neither transient nor a refusal",
    !(verdict instanceof TransientError) && !(verdict instanceof RefusalError));
  check("a transient failure carries the status when there was one",
    new TransientError("api 429", 429).status === 429);
  check("…and null when the call never got that far", new TransientError("connection reset", null).status === null);
}

console.log("test: the registry");
{
  __resetLedgerForTests();
  const h = await harness("anthropic");
  check("the default implementation resolves", h.name === "anthropic");
  check("…and comes back already metered", typeof h.classify === "function");

  const e = await caught(() => harness("polytoken"));
  check("an unknown harness fails loudly", e instanceof Error);
  check("…naming what it looked for and what it knows",
    (e as Error).message.includes("polytoken") && (e as Error).message.includes("anthropic"));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
