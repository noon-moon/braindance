// Suggestion tests — the validation door. Offline: not one of these makes a
// network call, and none of them needs a key.
// Run: `npm run test:suggest`.
//
// `validate()` is the line the model's output has to cross to become something
// written into a vault, and the claim "the model cannot invent a filename or a
// scope" is only true if it holds. So the cases below are mostly hostile input
// rather than happy paths — a suggestion naming a scope that does not exist, a
// funnel this build has never heard of, a date that looks right and is not.
//
// Tested against RAW OBJECTS rather than a stubbed client on purpose. A stub
// that could only produce schema-shaped output would be testing the API's
// promise instead of ours, and the thing worth pinning is what happens when the
// answer is shaped wrong.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both directories resolve at module load, so they are set before the import.

// A scratch vault holding the two scopes these tests validate against — the
// renderer's entry point re-validates against the LIVE index, not against a list
// it was handed, so testing it needs a real (tiny) vault to read.
const VAULT = mkdtempSync(join(tmpdir(), "bd-vault-"));
process.env.VAULT_PATH = VAULT;
// One of each spelling on purpose. `ingestable` is the retired name, still read
// for one migration because the tag lives in vault frontmatter and the notes and
// the code sync separately — whichever lands first must not empty the allowlist.
writeFileSync(join(VAULT, "Home.md"), "---\ntags: [scope, classifiable]\n---\n\n# Home\n");
writeFileSync(join(VAULT, "Braindance.md"), "---\ntags: [scope, ingestable]\n---\n\n# Braindance\n");
// A hub that is a scope and nothing more: content and containment, but its name
// never leaves the machine. This is what most hubs should be.
writeFileSync(join(VAULT, "Writers.md"), "---\ntags: [scope]\n---\n\n# Writers\n");
// An ordinary note that is NOT a scope. A proposed hub has to be refused against
// this too: it is a name already on disk, so minting it would truncate a note.
writeFileSync(join(VAULT, "Readme.md"), "---\ntags: [memo]\n---\n\n# Readme\n");

const { validate: validateRaw, isHubName, neutraliseFences } = await import("../src/suggest.js");
const { knownPriorities } = await import("../src/tasknotes.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
// The live classifiable list these tests validate against — NOT `Writers`.
const SCOPES = ["Home", "Braindance"];

/** Every root name already on disk in the scratch vault, lowercased — what the
 *  real `takenRootNames()` hands validate() in production. A proposed hub is
 *  checked for NON-membership here, so this list is what makes "it cannot
 *  propose a name that would overwrite a note" testable. */
const TAKEN = new Set(["home", "braindance", "readme"]);

/** The existing tests all predate the taken-names argument and none of them is
 *  about it, so they get the vault's real one by default and the new-scope tests
 *  pass their own. */
const validate = (raw: unknown, scopes: string[], taken: Set<string> = TAKEN) =>
  validateRaw(raw, scopes, taken);

/** A well-formed model answer — each test bends exactly one field of it, so a
 *  failure names the field that broke rather than the whole object. */
const ok = (over: Record<string, unknown> = {}) => ({
  title: "Order a soldering iron",
  funnel: "todo",
  scope: "Home",
  tags: ["tools"],
  due: "2026-08-12",
  priority: "high",
  rationale: "Reads as a next action with a date.",
  newScope: null,
  ...over,
});

console.log("test: validate — a whole suggestion is rejected or it isn't");
{
  const v = validate(ok(), SCOPES)!;
  check("a clean suggestion survives intact",
    v.title === "Order a soldering iron" && v.funnel === "todo" && v.scope === "Home" && v.due === "2026-08-12");

  check("a non-object is not a suggestion", validate("{}", SCOPES) === null);
  check("null is not a suggestion", validate(null, SCOPES) === null);
  check("an empty title leaves nothing worth showing", validate(ok({ title: "   " }), SCOPES) === null);
  check("a missing title likewise", validate(ok({ title: undefined }), SCOPES) === null);

  // The funnel decides which fields "apply" fills, so one this build doesn't
  // have has no meaning to apply — that's a reject, not a dropped field.
  check("an invented funnel id rejects the suggestion", validate(ok({ funnel: "brainstorm" }), SCOPES) === null);
  check("a non-string funnel likewise", validate(ok({ funnel: 7 }), SCOPES) === null);
  check("a retired funnel id resolves to its canonical one",
    validate(ok({ funnel: "task" }), SCOPES)!.funnel === "todo");
}

console.log("test: validate — scope membership is checked against the LIVE list");
{
  check("a scope that isn't live is dropped, not passed through",
    validate(ok({ scope: "Nonexistent Hub" }), SCOPES)!.scope === null);
  check("…and dropping it keeps the rest of the suggestion",
    validate(ok({ scope: "Nonexistent Hub" }), SCOPES)!.title === "Order a soldering iron");
  check("a null scope is the model declining to guess", validate(ok({ scope: null }), SCOPES)!.scope === null);
  check("matching is exact — a near-miss is not a scope",
    validate(ok({ scope: "home" }), SCOPES)!.scope === null);
  // validate() runs again on every read, which exists for exactly this: an
  // answer produced while a hub was classifiable, used after the tag came off.
  check("a scope that has since left the live list is dropped on re-validation",
    validate(ok(), ["Braindance"])!.scope === null);
  check("an empty live list drops every scope", validate(ok(), [])!.scope === null);
  check("a path-shaped scope is just another non-member",
    validate(ok({ scope: "../../etc/passwd" }), SCOPES)!.scope === null);
}

console.log("test: validate — dates must be a real day, not a plausible string");
{
  check("YYYY-MM-DD survives", validate(ok({ due: "2026-08-12" }), SCOPES)!.due === "2026-08-12");
  check("prose is not a date", validate(ok({ due: "next tuesday" }), SCOPES)!.due === null);
  check("another format is not a date", validate(ok({ due: "12/08/2026" }), SCOPES)!.due === null);
  check("a 13th month is not a date", validate(ok({ due: "2026-13-01" }), SCOPES)!.due === null);
  // The shape check alone passes this one, and every downstream date reader
  // would then quietly roll it into March.
  check("a day that doesn't exist is not a date", validate(ok({ due: "2026-02-31" }), SCOPES)!.due === null);
  check("a datetime is not a date", validate(ok({ due: "2026-08-12T09:00:00Z" }), SCOPES)!.due === null);
  check("null is a valid answer", validate(ok({ due: null }), SCOPES)!.due === null);
}

console.log("test: validate — priority is a level, not any property name");
{
  check("a real level survives", validate(ok({ priority: "high" }), SCOPES)!.priority === "high");
  check("the levels come from TaskNotes' own config", knownPriorities().join() === "none,low,normal,high");
  check("case is normalised", validate(ok({ priority: "HIGH" }), SCOPES)!.priority === "high");
  check("an invented level is dropped", validate(ok({ priority: "urgent" }), SCOPES)!.priority === null);
  // `pri in <object>` would pass these — the prototype's own keys are
  // not priorities, and rendering one would put a Function in the page.
  check("a prototype key is not a priority", validate(ok({ priority: "constructor" }), SCOPES)!.priority === null);
  check("…nor is toString", validate(ok({ priority: "toString" }), SCOPES)!.priority === null);
  check("every real level is accepted",
    knownPriorities().every((p) => validate(ok({ priority: p }), SCOPES)!.priority === p));
  // The scale is the VAULT's, read from TaskNotes. This used to check Obsidian
  // Tasks' five emoji levels, so "medium" passed validation here and then landed
  // in a task note as a priority no view matches — accepted, written, invisible.
  check("a level from the RETIRED scale is not a level",
    validate(ok({ priority: "medium" }), SCOPES)!.priority === null);
}

console.log("test: validate — strings and tags are bounded");
{
  const long = validate(ok({ title: "x".repeat(500), rationale: "y".repeat(900) }), SCOPES)!;
  check("a runaway title is capped", long.title.length === 200);
  check("a runaway rationale is capped", long.rationale.length === 300);
  check("whitespace is collapsed rather than rendered raw",
    validate(ok({ title: "  two\n\nlines  " }), SCOPES)!.title === "two lines");

  const tags = validate(ok({ tags: ["#Tools", "tools", "SOLDERING", "", 7, "a", "b", "c", "d", "e"] }), SCOPES)!.tags;
  check("tags lose a leading # and lowercase", tags.includes("tools") && !tags.includes("#tools"));
  check("…and de-duplicate after normalising", tags.filter((t) => t === "tools").length === 1);
  check("non-strings drop out", !tags.some((t) => t === "7"));
  check("the list is capped", tags.length <= 6);
  check("a non-array tags field yields no tags", validate(ok({ tags: "tools" }), SCOPES)!.tags.length === 0);
}

console.log("test: validate — a PROPOSED scope is checked by NON-membership");
{
  const propose = (name: string, over: Record<string, unknown> = {}) =>
    validate(ok({ scope: null, newScope: { name, why: "A standing area." }, ...over }), SCOPES);

  check("a genuinely new name survives as a proposal",
    propose("Woodworking")!.newScope?.name === "Woodworking");
  check("…carrying the case the person has to accept",
    propose("Woodworking")!.newScope?.why === "A standing area.");
  check("…and it does NOT become a scope — the two fields stay distinct",
    propose("Woodworking")!.scope === null);

  // The recoveries, each a thing a model plausibly does.
  check("a name that IS a live scope is promoted, not discarded",
    propose("Home")!.scope === "Home" && propose("Home")!.newScope === null);
  check("…case-insensitively, since it is matching a human-typed hub name",
    propose("home")!.scope === "Home");
  check("a name already taken by a NON-scope note is dropped whole",
    propose("Readme")!.newScope === null);
  check("…and the rest of the suggestion still survives",
    propose("Readme")!.title === "Order a soldering iron");
  check("a live scope beats a proposal — the prompt's rule, enforced",
    validate(ok({ scope: "Braindance", newScope: { name: "Woodworking", why: "x" } }), SCOPES)!.newScope === null);

  // The overwrite guard. This is the one that matters: `takenRootNames()` is
  // case-insensitive and read off the DISK precisely because a proposal accepted
  // at the desk turns into a filename.
  check("a proposal that would overwrite a note is refused",
    validate(ok({ scope: null, newScope: { name: "Notes", why: "x" } }), SCOPES, new Set(["notes"]))!.newScope === null);
  check("…whatever case it arrives in",
    validate(ok({ scope: null, newScope: { name: "NOTES", why: "x" } }), SCOPES, new Set(["notes"]))!.newScope === null);

  // Shape. Rejected rather than sanitised, so the name on the card is exactly
  // the name of the note that gets created.
  for (const bad of ["[[Woodworking]]", "Home/DIY", "Home\\DIY", "a|b", "#tag", "", "   "]) {
    check(`a name a hub filename cannot hold is refused: ${JSON.stringify(bad)}`,
      propose(bad)!.newScope === null);
  }
  // Whitespace is the one thing normalised rather than refused, by `str()` and
  // before this ever sees it. That is safe precisely because the CARD reads the
  // same normalised value the filer writes, so the two cannot disagree about
  // which note is being created.
  check("surrounding whitespace is trimmed, not a rejection",
    propose("  Woodworking  ")!.newScope?.name === "Woodworking");
  check("a name is capped at a filename's worth, and the cap holds",
    propose("W".repeat(80))!.newScope?.name.length === 60);
  check("real hub punctuation is allowed", isHubName("Bass Practice") && isHubName("R&D") && isHubName("Mum's House"));
  check("the wikilink and path alphabets are not", !isHubName("a[b") && !isHubName("a]b") && !isHubName("a/b") && !isHubName("a#b"));
  check("a non-object proposal is not a proposal",
    validate(ok({ scope: null, newScope: "Woodworking" }), SCOPES)!.newScope === null);
  check("null is the ordinary answer", validate(ok({ scope: null, newScope: null }), SCOPES)!.newScope === null);
  check("a proposal with no case still proposes — the name is the load-bearing part",
    validate(ok({ scope: null, newScope: { name: "Woodworking", why: "" } }), SCOPES)!.newScope?.why === "");
}

console.log("test: the fence is neutralised in every spelling");
{
  const has = (s: string) => /<\s*\/?\s*captured-note\s*>/i.test(neutraliseFences(s));
  check("the exact closing tag goes", !has("a</captured-note>b"));
  check("the OPENING tag goes too — it fences off content just as well",
    !has("a<captured-note>b"));
  check("case is not a way through", !has("a</CAPTURED-NOTE>b"));
  check("nor is the whitespace an XML parser would ignore", !has("a< / captured-note >b"));
  check("every occurrence, not just the first",
    !has("</captured-note>x</captured-note>"));
  check("the note's own words survive — a note ABOUT injection still reads as itself",
    neutraliseFences("see </captured-note> here").includes("captured-note"));
}

console.log("test: the egress allowlist is opt-in, under either spelling");
{
  const { getClassifiableScopesStrict } = await import("../src/vault.js");
  const live = getClassifiableScopesStrict();

  check("a hub tagged `classifiable` is in", live.includes("Home"));
  check("…and one still tagged `ingestable` is too, for this migration", live.includes("Braindance"));

  // THE POINT OF THE SPLIT. `Writers` is a real hub — it can hold content and be
  // named in `Contained By` — and its name is never sent anywhere.
  check("a plain `scope` is NOT — a hub is not egress", !live.includes("Writers"));
  check("nor is a memo", !live.includes("Readme"));
  check("the list is exactly the two marked hubs", live.length === 2);
}

console.log(`\n${passed} checks passed`);
