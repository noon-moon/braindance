// The OS-level failure taxonomy. Run: `npm run test:subprocess`.
//
// One property carries this file: THE CLASSIFIER CANNOT BLAME A NOTE. Reaching a
// verdict requires a clean exit and output that arrived, so nothing the kernel
// reports can spend one of a note's four lives. The failure it accepts instead
// is retrying a harness that will never work — visible on every note, and capped.
import assert from "node:assert/strict";
import { throwIfTransient, transientReason, type ExitFacts } from "../src/harness-subprocess.js";
import { TransientError, RefusalError } from "../src/harness.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
const ok: ExitFacts = { code: 0, signal: null };
const threw = (x: ExitFacts, refine?: (x: ExitFacts) => Error | null): Error | null => {
  try { throwIfTransient(x, refine); return null; } catch (e) { return e as Error; }
};

console.log("test: everything the OS reports is transient");
{
  const cases: Array<[string, ExitFacts]> = [
    ["a binary that is not there", { code: null, signal: null, spawnError: Object.assign(new Error("x"), { code: "ENOENT" }) }],
    ["a binary that is not executable", { code: null, signal: null, spawnError: Object.assign(new Error("x"), { code: "EACCES" }) }],
    ["a daemon that is not up", { code: null, signal: null, spawnError: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }],
    ["killed by the OOM killer", { code: null, signal: "SIGKILL" }],
    ["killed by a supervisor", { code: null, signal: "SIGTERM" }],
    ["crashed", { code: null, signal: "SIGSEGV" }],
    ["timed out", { code: null, signal: null, timedOut: true }],
    ["command not found", { code: 127, signal: null }],
    ["not executable", { code: 126, signal: null }],
    ["a plain non-zero exit", { code: 1, signal: null }],
    ["some other app-defined code", { code: 64, signal: null }],
  ];
  for (const [label, x] of cases) {
    const e = threw(x);
    check(`${label} → transient, never a verdict`, e instanceof TransientError);
  }
  // The whole point, stated once as a property rather than case by case.
  check("NONE of them can spend one of a note's four lives",
    cases.every(([, x]) => threw(x) instanceof TransientError));
}

console.log("test: a clean exit is the only route to blaming the note");
{
  check("exit 0 throws nothing — the caller judges the output", threw(ok) === null);
  check("…and has no transient reason to give", transientReason(ok) === null);
  // This is what makes the asymmetry real: the caller's own `throw new Error(...)`
  // on unparseable output is the ONLY thing that reaches `nextFailure` as a
  // verdict, and it can only happen after a successful exit.
}

console.log("test: the messages are read on a phone, in bd_error");
{
  check("a missing binary says so, and says ENOENT", (threw({ code: null, signal: null,
    spawnError: Object.assign(new Error("x"), { code: "ENOENT" }) }) as Error).message.includes("could not start (ENOENT)"));
  check("a signal is named", (threw({ code: null, signal: "SIGKILL" }) as Error).message.includes("SIGKILL"));
  check("a timeout says timeout", (threw({ code: null, signal: null, timedOut: true }) as Error).message.includes("timed out"));
  check("an unknown exit code is quoted rather than interpreted",
    (threw({ code: 64, signal: null }) as Error).message === "harness exited 64");
  check("the status rides along for whoever wants it",
    (threw({ code: 64, signal: null }) as TransientError).status === 64);
}

console.log("test: refine may only make the verdict harsher");
{
  const asRefusal = (): Error => new RefusalError("cyber");
  check("an implementation may upgrade its own output to a refusal",
    threw({ code: 3, signal: null }, asRefusal) instanceof RefusalError);
  check("…even on a clean exit, where nothing would otherwise throw",
    threw(ok, asRefusal) instanceof RefusalError);
  // The direction that must NOT be available: silencing a real failure.
  check("declining to refine leaves the transient default intact",
    threw({ code: 1, signal: null }, () => null) instanceof TransientError);
  check("…and a clean exit still throws nothing", threw(ok, () => null) === null);
}

console.log(`\n${passed} checks passed`);
