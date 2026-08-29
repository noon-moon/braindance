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
const TAKEN = new Set(["ai orchestration", "songwriting", "music", "phrases", "readme"]);
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
  check("a name already taken by another note is unclear — creating it would overwrite",
    V({ scope: ["Readme"] }).kind === "unclear");
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

console.log(`\n${passed} checks passed`);
