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

console.log("test: the scope link is parsed back off the top");
{
  const scoped = write("2026-08-09T10-11-18-345Z", "Tags: [[Home]]\n\nfix the door\n");
  const s = getInboxNote(scoped)!;
  check("the capture-time scope is recovered for the triage dropdown", s.scope === "Home");
  check("…and stripped from the text", s.text === "fix the door");
  check("…leaving the first line as the title", s.title === "fix the door");

  const aliased = write("2026-08-09T10-11-19-345Z", "Tags: [[Home|the house]]\n\nfix the door\n");
  check("an aliased wikilink resolves to its target, matching how vault.ts links",
    getInboxNote(aliased)!.scope === "Home");

  const scopedTitle = write("2026-08-09T10-11-20-345Z-cool", "Tags: [[Home]]\n# Cool\n\nbody");
  check("a scope line above a heading doesn't hide the heading",
    getInboxNote(scopedTitle)!.title === "Cool");
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
