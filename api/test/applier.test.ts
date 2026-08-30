// Applier tests — what marks a capture, and what must not survive filing.
// Run: `npm run test:applier`.
//
// The queue is a TAG, not a folder and not an age. That was chosen over every
// automatic marker for one reason — nothing may be picked up by accident — so
// the tests worth having are the ones that try to get something into the queue
// that does not belong there, and the one that stops a filed note re-entering it
// forever.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCapture, findCaptures } from "../src/applier.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

console.log("test: what asks to be triaged");
{
  check("an armed marker on its own line", isCapture("some thought\n\n#capture\n"));
  check("…mid-sentence too", isCapture("a thought #capture and more"));
  // Armed, it IS a real Obsidian tag, so frontmatter is the same signal in
  // another spelling and must count. (Only the INLINE form can be disarmed —
  // frontmatter strips hashes — which is why a template uses the inline one.)
  check("a frontmatter tag counts", isCapture("---\ntags:\n  - capture\n---\n\nthing\n"));

  // A RETIRED spelling, kept working: nothing writes it now, but notes made
  // every new note without queueing a single one.
  check("the retired double-hash spelling is invisible", !isCapture("a thought I have not finished\n\n##capture\n"));
  check("an unmarked note is invisible", !isCapture("a thought I have not finished"));
  check("the boundary holds", !isCapture("thing #captured") && !isCapture("thing #capture-ideas"));
  check("prose containing the word is not a marker", !isCapture("I should capture this"));
  check("a marker quoted in code does not queue a note about braindance",
    !isCapture("the marker is `#capture`"));
}

console.log("test: finding them in a vault");
{
  const V = mkdtempSync(join(tmpdir(), "bd-applier-"));
  const w = (rel: string, body: string) => {
    const dir = rel.includes("/") ? join(V, rel.slice(0, rel.lastIndexOf("/"))) : V;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(V, rel), body);
  };
  w("armed.md", "a thought #capture");
  w("plain.md", "an ordinary note");
  w("disarmed.md", "half a thought\n\n##capture\n");
  w("daily/Daily-2026-08-23.md", "log #capture");
  w("_ephemeral/scratch.md", "scratch #capture");
  w("_triage/x.triage.md", "#capture");
  w(".obsidian/x.md", "#capture");
  w("notes.txt", "#capture");

  const found = findCaptures(V);
  check("an armed note at the root is found", found.includes("armed.md"));
  check("…and one a level down", found.includes("daily/Daily-2026-08-23.md"));
  check("an unmarked note is not", !found.includes("plain.md"));
  check("a note carrying only the retired spelling is not", !found.includes("disarmed.md"));
  // _ephemeral is 264 MB of scratch in the real vault; walking it is not an
  // option, and its contents are non-canonical by definition.
  check("underscore directories are never walked",
    !found.some((f) => f.startsWith("_")));
  check("dot directories likewise", !found.some((f) => f.startsWith(".")));
  check("non-markdown is ignored", !found.some((f) => f.endsWith(".txt")));
  check("the result is stable in order", found.join() === [...found].sort().join());
}

console.log(`\n${passed} checks passed`);
