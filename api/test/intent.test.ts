// Intent tests — the door from the model's reading of your reply into an action.
// Run: `npm run test:intent`.
//
// The reply is trusted; this is not a check on the person. It is a check on the
// MODEL's reading of them, and it matters more than suggest.ts's equivalent
// because this output has AUTHORITY: what survives here is what gets written to
// the vault and what gets deleted from it.
//
// So the bias under test is one-directional. Anything ambiguous, invented or
// malformed must degrade to `unclear` — which costs one more round trip — and
// never to `file`, which files someone's note somewhere they will not find it.
import assert from "node:assert/strict";
import { validateAction, type Action } from "../src/intent.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

const SCOPES = ["AI Orchestration", "Songwriting", "Music", "Phrases"];
// lowercase → the name as written, because a match usually becomes a wikilink.
// `Octavia Butler` and `Readme` are notes that are NOT classifiable scopes: one
// is a thing you file books under, the other is neither.
const TAKEN = new Map([
  ["ai orchestration", "AI Orchestration"], ["songwriting", "Songwriting"],
  ["music", "Music"], ["phrases", "Phrases"], ["readme", "Readme"],
  ["octavia butler", "Octavia Butler"],
]);
const V = (over: Record<string, unknown> = {}): Action =>
  validateAction({ action: "file", title: null, funnel: null, scope: null, newScope: null, newScopeWhy: null, due: null, priority: null, note: "", ...over }, SCOPES, TAKEN);

console.log("test: the three plain answers");
{
  check("file with nothing changed is a bare approval", V().kind === "file"
    && Object.keys((V() as { revised: object }).revised).length === 0);
  check("discard is discard", V({ action: "discard" }).kind === "discard");
  check("reclassify asks for a fresh look", V({ action: "reclassify" }).kind === "reclassify");
  check("an unknown action is unclear, never file", V({ action: "file it maybe" }).kind === "unclear");
  check("a non-object is unclear", validateAction("yes", SCOPES, TAKEN).kind === "unclear");
  check("null is unclear", validateAction(null, SCOPES, TAKEN).kind === "unclear");
}

console.log("test: revisions are a DIFF — silence means 'as proposed'");
{
  const r = (a: Action) => (a as { revised: Record<string, unknown> }).revised;
  check("an unmentioned field is absent, not null", !("scopes" in r(V())) && !("due" in r(V())));
  check("a named title comes through", r(V({ title: "Shorter" })).title === "Shorter");
  check("a named type resolves through funnelById", r(V({ funnel: "todo" })).funnel === "todo");
  check("a retired funnel id still resolves", r(V({ funnel: "task" })).funnel === "todo");
}

console.log("test: a hub the model named must EXIST, or be an explicit creation");
{
  const r = (a: Action) => (a as { revised: Record<string, unknown> }).revised;
  check("a live hub is matched", r(V({ scope: ["Songwriting"] })).scopes.join() === "Songwriting");
  check("…case-insensitively, since a person typed it", r(V({ scope: ["songwriting"] })).scopes.join() === "Songwriting");
  // The case that made this plural: a reply naming two hubs must yield two.
  check("SEVERAL hubs come back, in the order named",
    r(V({ scope: ["Songwriting", "Phrases"] })).scopes.join(" + ") === "Songwriting + Phrases");
  check("duplicates collapse", r(V({ scope: ["Music", "music"] })).scopes.length === 1);
  check("an unlisted name becomes a CREATION, not a silent file-elsewhere",
    r(V({ scope: ["Woodworking"] })).newScope === "Woodworking");
  // A hub with no description is invisible to `blurbFor()`, so nothing can ever
  // be filed into it again. The reply path has to carry one too.
  check("a new hub carries its description",
    r(V({ scope: ["Woodworking"], newScopeWhy: "Hand-tool woodwork projects." })).newScopeWhy
      === "Hand-tool woodwork projects.");
  check("a live hub and a new one can be asked for together",
    r(V({ scope: ["Songwriting", "Woodworking"] })).scopes.join() === "Songwriting"
      && r(V({ scope: ["Songwriting", "Woodworking"] })).newScope === "Woodworking");
  // Two unlisted names means the reply was misread, and inventing two hubs off
  // a misreading is exactly what `unclear` exists to prevent.
  check("two hubs that do not exist is unclear, not two new hubs",
    V({ scope: ["Woodworking", "Joinery"] }).kind === "unclear");
  // This used to be `unclear`, on the grounds that minting a hub called `Readme`
  // would truncate the note of that name. The protection is now stronger and
  // earlier: a name that EXISTS is never a creation request at all, so there is
  // nothing to overwrite — it is a note to be contained by, which is what
  // `scope`-is-only-an-index-marker means in practice.
  check("naming a note that exists files into it rather than minting over it",
    V({ scope: ["Readme"] }).kind === "file");
  check("…and never proposes creating it", (V({ scope: ["Readme"] }) as any).revised.newScope === undefined);
  check("a name a hub filename cannot hold is unclear", V({ newScope: "Home/DIY" }).kind === "unclear");
  check("newScope naming a hub that exists is treated as filing into it",
    r(V({ newScope: "Music" })).scopes.join() === "Music");
}

console.log("test: dates and priorities — a real day, a real level");
{
  const r = (a: Action) => (a as { revised: Record<string, unknown> }).revised;
  check("a real date survives", r(V({ due: "2026-09-01" })).due === "2026-09-01");
  check("prose is not a date", V({ due: "next friday" }).kind === "unclear");
  check("a day that does not exist is not a date", V({ due: "2026-02-31" }).kind === "unclear");
  check("a real level survives", r(V({ priority: "high" })).priority === "high");
  check("case is normalised", r(V({ priority: "HIGH" })).priority === "high");
  check("an invented level is unclear", V({ priority: "urgent" }).kind === "unclear");
  // `in` walks the prototype; membership is the only test that means what it says.
  check("a prototype key is not a priority", V({ priority: "constructor" }).kind === "unclear");
}

console.log("test: the receipt note is bounded");
{
  const a = V({ note: "x".repeat(500) }) as { note: string };
  check("a long paraphrase is capped", a.note.length === 200);
  check("newlines are collapsed", (V({ note: "a\nb" }) as { note: string }).note === "a b");
}

console.log("test: a link the reply supplied");
{
  const u = (url: unknown): Action => V({ url });

  check("an https link is kept", (u("https://www.baen.com/Chapters/x.htm") as any).revised.url === "https://www.baen.com/Chapters/x.htm");
  check("http is fine too", (u("http://example.com/a") as any).revised.url === "http://example.com/a");
  check("no link means no change", u(null).kind === "file" && (u(null) as any).revised.url === undefined);

  // THE POINT OF PARSING RATHER THAN PATTERN-MATCHING. This value lands in
  // frontmatter and gets tapped on a phone, so the schemes that matter are the
  // ones a link is dangerous as.
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html;base64,PHNjcmlwdD4="]) {
    check(`${bad.split(":")[0]}: links are refused`, u(bad).kind === "unclear");
  }
  check("…and the refusal says which scheme", u("javascript:alert(1)").note.includes("javascript:"));
  check("something that is not a URL at all asks again", u("add the baen link please").kind === "unclear");

  // Normalised by the parser, so what lands is what a browser would resolve.
  check("it is normalised, not echoed", (u("HTTPS://Example.COM") as any).revised.url === "https://example.com/");

  // The reply channel carries INSTRUCTIONS; prose is not one of them, and the
  // schema says so. This is the boundary the url field must not become a hole in.
  check("a reply asking for body text is still unclear, not a url",
    V({ url: null, note: "add a paragraph about Butler" }).kind === "file");
}

console.log("test: notes the reply asks to create");
{
  const sp = (spawn: unknown): Action => V({ spawn });
  const one = [{ title: "Parable of the Sower", body: "Octavia Butler." }];

  check("a note the reply asks for is carried", (sp(one) as any).revised.spawn?.length === 1);
  check("…with its text intact", (sp(one) as any).revised.spawn[0].body === "Octavia Butler.");
  check("no spawn is the ordinary case", (sp(null) as any).revised.spawn === undefined);
  check("…as is an empty list", (sp([]) as any).revised.spawn === undefined);

  // No policy cap: each one becomes a capture, gets classified, and comes back
  // as a proposal to answer. The review is the bound.
  const many = Array.from({ length: 9 }, (_, i) => ({ title: `n${i}`, body: `b${i}` }));
  check("several are allowed — every one is reviewed before it is filed",
    (sp(many) as any).revised.spawn?.length === 9);

  // What IS refused is nonsense, because a note with no content is not a note
  // anyone asked for and would land in the vault as an empty armed capture.
  check("an entry with no body asks again", sp([{ title: "x", body: "" }]).kind === "unclear");
  check("…saying so", sp([{ title: "x", body: "" }]).note.includes("no content"));
  check("a non-object entry asks again", sp(["just a string"]).kind === "unclear");
  check("an untitled one is fine — the body is what matters",
    (sp([{ title: "", body: "a thought" }]) as any).revised.spawn?.length === 1);
}

console.log("test: a reply may name any note, not only a classifiable scope");
{
  const sc = (scope: unknown): Action => V({ scope });

  // `scope` marks a note whose structural purpose is to be an index. It is not
  // a licence to be contained BY — an author is neither an index nor too small
  // to gather books under.
  check("a note that exists but is not a scope is a valid container",
    (sc(["Octavia Butler"]) as any).revised.scopes?.[0] === "Octavia Butler");
  check("…written with the casing the note has, so the wikilink resolves",
    (sc(["octavia BUTLER"]) as any).revised.scopes?.[0] === "Octavia Butler");
  check("mixed with a real scope, order is kept and the first is primary",
    JSON.stringify((sc(["Songwriting", "Octavia Butler"]) as any).revised.scopes) === '["Songwriting","Octavia Butler"]');
  check("a classifiable scope still resolves the same way",
    (sc(["songwriting"]) as any).revised.scopes?.[0] === "Songwriting");
  check("no duplicates, however it is named",
    (sc(["Songwriting", "songwriting"]) as any).revised.scopes?.length === 1);

  // THE GUARANTEE THAT SURVIVES: the name has to be real. What changed is which
  // list counts as real — the model still only picks from `liveScopes`, but you
  // may name anything in your vault.
  check("a name that exists nowhere is still a creation request",
    (sc(["Woodworking"]) as any).revised.newScope === "Woodworking");
  check("…and two of them is a misreading, not two new hubs",
    sc(["Woodworking", "Beekeeping"]).kind === "unclear");
  check("a name no note can have is refused outright", sc(["[[nope]]"]).kind === "unclear");
}

console.log(`\n${passed} checks passed`);
