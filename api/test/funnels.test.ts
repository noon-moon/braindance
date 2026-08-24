// Funnel tests — what a capture TYPE is, and how containment is written.
// Run: `npm run test:funnels`.
//
// This file used to be mostly about `taskLine` and `appendTaskLine`, the
// line-level task contract. Both are gone: a task in this vault is a TaskNotes
// note now, built from the plugin's own configured schema by `tasknotes.ts`,
// and `todo` no longer builds a note here at all. What remains is the part that
// never depended on that — the three types, how a title becomes frontmatter,
// and `parseScopes`, which is the single definition of what a comma-separated
// scope field means to everything that reads one.
import assert from "node:assert/strict";
import { compose, funnelById, parseScopes, containment, FUNNELS } from "../src/funnels.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

console.log("test: funnel registry");
{
  check("the todo funnel exists", funnelById("todo")?.id === "todo");
  check("the retired `task` id still resolves to it", funnelById("task")?.id === "todo");
  check("an unknown id is still undefined", funnelById("nope") === undefined);

  // Memo / Scope / TODO are the desk's three types; media and resource are off
  // the dropdown but must stay resolvable for the JSON /ingest contract.
  check("the dropdown offers exactly the three types",
    ["memo", "scope", "todo"].every((id) => FUNNELS.some((f) => f.id === id)) && FUNNELS.length === 3);
  check("a retired type is still resolvable, and not in the dropdown",
    funnelById("media")?.id === "media" && !FUNNELS.some((f) => f.id === "media"));

  // A TODO NO LONGER BUILDS A NOTE HERE. A task in this vault is a TaskNotes
  // note, written from the plugin's own configured schema by tasknotes.ts, and
  // the applier routes there. Leaving a build that emitted the old
  // `- [ ] … #task` line would have been a shape nothing reads, produced
  // silently by whichever caller forgot — so the absence is the contract, and
  // it is asserted rather than assumed.
  check("todo has no build — TaskNotes owns that shape", funnelById("todo")!.build === undefined);
  check("memo and scope still build", typeof funnelById("memo")!.build === "function"
    && typeof funnelById("scope")!.build === "function");

  const hub = funnelById("scope")!.build({ title: "Bass Practice", body: "Where the woodshedding goes.", containedBy: "Music", contains: "Scales" });
  check("a scope files as a hub, not a memo", JSON.stringify(hub.frontmatter.tags) === '["scope"]');
  check("…carrying both directions of containment",
    JSON.stringify(hub.frontmatter.Contains) === '["\\"[[Scales]]\\""]'
    && JSON.stringify(hub.frontmatter["Contained By"]) === '["\\"[[Music]]\\""]');
  check("…and no heading, like the vault's own hubs", !hub.body.includes("#"));
  check("the ingestable box stacks a tag rather than replacing one",
    JSON.stringify(funnelById("scope")!.build({ title: "X", ingestable: "1" }).frontmatter.tags) === '["scope","ingestable"]');
}

// The scope field stopped being a <select> when it went multi-valued, so this is
// now the boundary between a free-text form field and a wikilink written into the
// vault. Everything that reads or writes a scope goes through these two.
console.log("test: parseScopes / containment");
{
  const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  check("a single scope is the same answer it always was", eq(parseScopes("Home"), ["Home"]));
  check("commas separate, surrounding whitespace doesn't count",
    eq(parseScopes(" Home , Video Games ,Loon "), ["Home", "Video Games", "Loon"]));
  check("order is kept — the first scope is the one a task files into",
    eq(parseScopes("Loon, Home"), ["Loon", "Home"]));
  check("the same scope twice is one scope", eq(parseScopes("Home, Home"), ["Home"]));
  check("empty entries are not scopes", eq(parseScopes("Home,,  , Loon"), ["Home", "Loon"]));
  check("nothing at all is no scopes", eq(parseScopes(""), []) && eq(parseScopes(undefined), []));
  check("an array is accepted too — the JSON API can post one",
    eq(parseScopes(["Home", "Loon"]), ["Home", "Loon"]));

  // The output is interpolated straight into [[…]]. A name that can close its own
  // link can write note body, so the brackets never survive the parse.
  check("a name cannot close its own wikilink",
    eq(parseScopes("Home]] and then [["), ["Home and then"]));
  check("an alias pipe and a heading anchor are stripped, not honoured",
    eq(parseScopes("Home|the house, Loon#Backlog"), ["Home the house", "Loon Backlog"]));
  check("a newline cannot break out of the link",
    eq(parseScopes("Home\nrest of the note"), ["Home rest of the note"]));

  // The two containment fields ARE the desk's output now, so this is where a
  // scope name becomes YAML. A bare [[…]] opens a flow sequence, so every item is
  // quoted; a quote inside a name is escaped rather than dropped, since the note
  // it points at is allowed to be called that.
  const both = containment({ contains: "Scales, Sight Reading", containedBy: "Music" });
  check("each side is a list of quoted wikilinks",
    JSON.stringify(both.Contains) === '["\\"[[Scales]]\\"","\\"[[Sight Reading]]\\""]');
  check("…in the order given", JSON.stringify(both["Contained By"]) === '["\\"[[Music]]\\""]');
  check("a quote in a name is escaped, not stripped",
    JSON.stringify(containment({ containedBy: 'The "Good" Stuff' })["Contained By"])
      === '["\\"[[The \\\\\\"Good\\\\\\" Stuff]]\\""]');

  // An empty relationship must not leave the key behind: `Contains:` with nothing
  // under it is a property Obsidian shows on every note that never had one.
  const none = compose({ title: "t", frontmatter: { tags: ["memo"], ...containment({}) }, body: "x" });
  check("an empty side writes no key at all",
    !none.includes("Contains") && !none.includes("Contained By"));
  const one = compose({ title: "t", frontmatter: { tags: ["memo"], ...containment({ containedBy: "Home" }) }, body: "x" });
  check("the side that has an answer still writes",
    one.includes('Contained By:\n  - "[[Home]]"') && !one.includes("Contains:"));

  const many = funnelById("memo")!.build({ title: "", body: "a thought", containedBy: "Home, Loon" });
  check("a captured memo hangs off every hub it was given",
    JSON.stringify(many.frontmatter["Contained By"]) === '["\\"[[Home]]\\"","\\"[[Loon]]\\""]');
  check("…and its body is the thought, nothing else", many.body.trim() === "a thought");
}

console.log(`\n${passed} checks passed`);
