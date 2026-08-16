// Inbox reader tests — filename parsing and the title fallback chain.
// Run: `npm run test:inbox`.
//
// Both shapes of capture filename live at once and have to keep doing so: the
// web form names by timestamp alone, while JSON `/ingest` (the iOS Share Sheet
// Shortcut) still posts a title and gets a `-slug` suffix. `createdISO` is the
// ONLY place a capture's instant survives — nothing else records it — so a
// filename the stamp regex doesn't match silently loses the capture time.
//
// The title chain is the other half: heading → filename slug → first line of the
// body. The last link is what an ordinary one-tap capture actually renders as,
// in the queue row and in the capture toast, and the two share the rule so a note
// can't read one way as it lands and another when it comes back up.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolved at module load, so it is set before the import.
const VAULT = mkdtempSync(join(tmpdir(), "bd-inbox-"));
mkdirSync(join(VAULT, "inbox"));
process.env.VAULT_PATH = VAULT;

const { listInbox, getInboxNote, firstLine } = await import("../src/inbox.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const write = (name: string, body: string) => {
  writeFileSync(join(VAULT, "inbox", `${name}.md`), body);
  return name;
};

console.log("test: firstLine");
{
  check("the first non-blank line wins", firstLine("\n\n  hello  \nworld") === "hello");
  check("an empty body has no first line", firstLine("   \n\n") === "");
  check("a long line is cut with an ellipsis", firstLine("x".repeat(80)) === `${"x".repeat(59)}…`);
  check("…to exactly the cap, ellipsis included", firstLine("x".repeat(80)).length === 60);
  check("a line at the cap is left alone", firstLine("x".repeat(60)) === "x".repeat(60));
  check("the cap is caller-settable — the toast is tighter than the queue row",
    firstLine("x".repeat(80), 48).length === 48);
}

console.log("test: the bare-timestamp filename still yields its instant");
{
  // The one-tap capture path: no title typed, so no `-slug` suffix.
  const bare = write("2026-08-09T10-11-12-345Z", "Order a soldering iron\n\nthe cheap one");
  const n = getInboxNote(bare)!;
  check("a bare stamp parses", n.createdISO === "2026-08-09T10:11:12.345Z");
  check("…and with no heading or slug the title falls through to the first line",
    n.title === "Order a soldering iron");
  check("the text is the whole body — the title is derived, not consumed",
    n.text === "Order a soldering iron\n\nthe cheap one");

  // The JSON /ingest path (the iOS Shortcut): a title was posted, so it slugged.
  const titled = write("2026-08-09T10-11-14-345Z-cool-article", "# Cool article\n\nworth a read");
  const t = getInboxNote(titled)!;
  check("a slugged stamp parses the same instant format", t.createdISO === "2026-08-09T10:11:14.345Z");
  check("…and its heading is the title", t.title === "Cool article");
  check("…with the heading stripped from the text", t.text === "worth a read");
}

console.log("test: the title fallback chain, in order");
{
  const slugOnly = write("2026-08-09T10-11-15-345Z-order-a-soldering-iron", "the cheap one");
  check("with no heading the filename slug is humanised into the title",
    getInboxNote(slugOnly)!.title === "order a soldering iron");

  const headingWins = write("2026-08-09T10-11-16-345Z-some-slug", "# Real title\n\nbody");
  check("a heading outranks the slug", getInboxNote(headingWins)!.title === "Real title");

  const empty = write("2026-08-09T10-11-17-345Z", "   \n\n");
  check("a capture with nothing in it is 'untitled' rather than blank",
    getInboxNote(empty)!.title === "untitled");

  // Not a stamp at all — a file dropped in by hand. It must still list.
  const hand = write("some-note", "# Hand written\n\nbody");
  const h = getInboxNote(hand)!;
  check("an unstamped filename yields no capture time rather than a wrong one", h.createdISO === null);
  check("…and still resolves a title", h.title === "Hand written");
}

// The LEGACY scope line. Nothing writes one any more — containment lives in
// frontmatter — but the inbox is a synced directory, so a capture made by an
// older client (or one that was already in the queue) still has to give its pick
// back to the desk rather than have it silently dropped.
console.log("test: the legacy scope link is parsed back off the top");
{
  const scoped = write("2026-08-09T10-11-18-345Z", "Tags: [[Home]]\n\nfix the door\n");
  const s = getInboxNote(scoped)!;
  check("the capture-time scope is recovered for the triage picker", eq(s.containedBy, ["Home"]));
  check("…and stripped from the text", s.text === "fix the door");
  check("…leaving the first line as the title", s.title === "fix the door");

  const aliased = write("2026-08-09T10-11-19-345Z", "Tags: [[Home|the house]]\n\nfix the door\n");
  check("an aliased wikilink resolves to its target, matching how vault.ts links",
    eq(getInboxNote(aliased)!.containedBy, ["Home"]));

  const scopedTitle = write("2026-08-09T10-11-20-345Z-cool", "Tags: [[Home]]\n# Cool\n\nbody");
  check("a scope line above a heading doesn't hide the heading",
    getInboxNote(scopedTitle)!.title === "Cool");

  // A note belongs to as many hubs as it belongs to. Order is meaning — the FIRST
  // is the one a task files into — so it has to survive the round trip.
  const many = write("2026-08-09T10-11-21-345Z", "Tags: [[Home]] [[Loon]] [[Music]]\n\nfix the door\n");
  const m = getInboxNote(many)!;
  check("every scope on the line comes back, in the order written",
    eq(m.containedBy, ["Home", "Loon", "Music"]));
  check("…and the whole line is still stripped from the text", m.text === "fix the door");

  const dupes = write("2026-08-09T10-11-22-345Z", "Tags: [[Home]] [[Home|the house]]\n\nfix the door\n");
  check("the same hub twice is one scope", eq(getInboxNote(dupes)!.containedBy, ["Home"]));

  const none = write("2026-08-09T10-11-23-345Z", "fix the door\n");
  check("a note with no scope line has no scopes rather than a null one",
    eq(getInboxNote(none)!.containedBy, []));

  // The regex has to END at the last link. A sentence that opens with "Tags:" is
  // prose, and eating it would silently delete a line of the note.
  const prose = write("2026-08-09T10-11-24-345Z", "Tags: [[Home]] and also the shed\n\nfix the door\n");
  const p = getInboxNote(prose)!;
  check("a Tags: line that trails off into prose is not a scope line", eq(p.containedBy, []));
  check("…and that line is left in the note", p.text.startsWith("Tags: [[Home]] and also the shed"));
}

// The convention captures write NOW: both relationships, in frontmatter, so the
// desk can pre-fill each picker from its own side.
console.log("test: containment comes back off the frontmatter");
{
  const fm = (body: string, extra = "") =>
    `---\ntags:\n  - memo\n${extra}---\n\n${body}`;

  const both = write("2026-08-09T11-00-01-000Z", fm("fix the door\n",
    'Contains:\n  - "[[Latches]]"\nContained By:\n  - "[[Home]]"\n  - "[[Loon]]"\n'));
  const b = getInboxNote(both)!;
  check("contained by comes back in the order written", eq(b.containedBy, ["Home", "Loon"]));
  check("…and contains is its own, separate answer", eq(b.contains, ["Latches"]));
  check("…with the body untouched by either", b.text === "fix the door");

  const bare = write("2026-08-09T11-00-02-000Z", fm("x\n", "Contained By:\n  - Home\n"));
  check("a hand-typed name with no brackets is still a scope",
    eq(getInboxNote(bare)!.containedBy, ["Home"]));

  const emptied = write("2026-08-09T11-00-03-000Z", fm("x\n", "Contained By:\nContains: []\n"));
  const e2 = getInboxNote(emptied)!;
  check("an emptied Obsidian property is no scopes, not a crash",
    eq(e2.containedBy, []) && eq(e2.contains, []));

  // A note somebody hand-edited can carry both. The field is the convention, so
  // it leads; the legacy line follows, and neither is dropped.
  const mixed = write("2026-08-09T11-00-04-000Z", fm("Tags: [[Loon]]\n\nx\n", 'Contained By:\n  - "[[Home]]"\n'));
  check("frontmatter leads, the legacy line follows, nothing is lost",
    eq(getInboxNote(mixed)!.containedBy, ["Home", "Loon"]));
}

console.log("test: listing and path safety");
{
  write("README.md".slice(0, -3), "# not a capture");
  const names = listInbox().map((n) => n.name);
  check("the inbox README is not a capture", !names.includes("README"));
  check("filenames sort chronologically, so the list is newest first",
    names[0] === "some-note" && names.indexOf("2026-08-09T10-11-20-345Z") < names.indexOf("2026-08-09T10-11-12-345Z"));

  check("a traversing name resolves nothing", getInboxNote("../../etc/passwd") === null);
  check("an empty name resolves nothing", getInboxNote("") === null);
  check("a name that isn't there resolves nothing", getInboxNote("2026-01-01T00-00-00-000Z") === null);
}

console.log(`\n${passed} checks passed`);
