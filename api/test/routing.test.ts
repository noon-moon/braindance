// Which harness may see which note. Run: `npm run test:routing`.
//
// One assertion here matters more than the rest: a note tagged `#private` with
// no local harness configured must FAIL, not fall back. A privacy control that
// degrades to "send it anyway" when misconfigured is a preference, and the
// failure would be silent and unrecoverable — the two properties this codebase
// treats as disqualifying everywhere else.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bd-routing-"));
process.env.BD_STATE_FILE = join(dir, "spend.json");
delete process.env.BD_LOCAL_HARNESS;

const { isPrivate, PRIVATE, isArmed, renderNoRoute } = await import("../src/approval.js");
const { routeFor, NoRouteError, TransientError } = await import("../src/harness.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
const caught = async (fn: () => Promise<unknown>): Promise<Error | null> => {
  try { await fn(); return null; } catch (e) { return e as Error; }
};

console.log("test: recognising a private note");
{
  check("one keyword, and it is not the loop's", PRIVATE === "private");
  check("a tag in prose marks it", isPrivate("a thought #private"));
  check("a frontmatter tag marks it too", isPrivate("---\ntags: [private]\n---\nbody"));
  check("an ordinary note is not private", !isPrivate("a thought #capture"));
  check("…nor is a note that merely says the word", !isPrivate("this is private business"));
  check("the boundary holds", !isPrivate("#privately") && !isPrivate("#private-ish"));
  check("a quoted one is not a tag", !isPrivate("see `#private` for how"));

  // It must NOT have a disarmed spelling. `##private` in a draft would mean
  // "send it", which is the wrong default for a safety marker.
  check("there is no disarmed spelling to get wrong", !isPrivate("##private"));
  check("private and armed are independent axes", isPrivate("x #private #capture") && isArmed("x #private #capture"));
}

console.log("test: FAIL CLOSED — the rule the whole strategy rests on");
{
  delete process.env.BD_LOCAL_HARNESS;
  const e = await caught(() => routeFor("a thought #private"));
  check("a private note with no local harness REFUSES", e instanceof NoRouteError);
  check("…and does not quietly use the default", !(e === null));
  check("…saying what is missing", (e as Error).message.includes("BD_LOCAL_HARNESS"));

  // Not transient: nothing about this improves by waiting, and a backoff would
  // say otherwise on a note a person is meant to act on.
  check("it is NOT transient — time does not fix a missing deployment",
    !(e instanceof TransientError));

  const e2 = await caught(() => routeFor("an ordinary thought #capture"));
  check("an ordinary note still routes", e2 === null);
}

console.log("test: the held note says what to do");
{
  const t = renderNoRoute("inbox/Thing.md", "note is tagged #private and BD_LOCAL_HARNESS is not set");
  check("it declares itself held", /^bd_state: held$/m.test(t));
  check("it carries NO retry time — nothing is retrying", !/^bd_next:/m.test(t));
  check("…and no attempt count to imply one", !/^bd_attempts:/m.test(t));
  check("it names the three ways out", t.includes("BD_LOCAL_HARNESS") && t.includes("remove the tag") && t.includes("by hand"));
  check("the capture is embedded, not copied", t.includes("![[inbox/Thing]]"));
  check("it cannot forge a reply section", !t.includes("## Your call"));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
