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
import { isCapture, findCaptures, stripCaptureTag } from "../src/applier.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

console.log("test: what asks to be triaged");
{
  check("an inline tag", isCapture("some thought\n\n#capture\n"));
  check("…mid-sentence too", isCapture("a thought #capture and more"));
  check("a frontmatter tag", isCapture("---\ntags:\n  - capture\n---\n\nthing\n"));
  check("…written with the hash", isCapture("---\ntags: ['#capture']\n---\n"));
  check("…as a lone string", isCapture("---\ntags: capture\n---\n"));

  check("an untagged note is invisible — the half-written case", !isCapture("a thought I have not finished"));
  // The tag boundary. These are tags in their own right and must stay out.
  check("#captured is not #capture", !isCapture("thing #captured"));
  check("#capture-ideas is not #capture", !isCapture("thing #capture-ideas"));
  check("#capture/sub is not #capture", !isCapture("thing #capture/sub"));
  check("prose containing the word is not a tag", !isCapture("I should capture this"));
  check("unparseable frontmatter still checks the body",
    isCapture("---\n: : :\n---\n\nthing #capture\n"));
}

console.log("test: THE TAG MUST NOT SURVIVE FILING");
{
  // A capture's body is copied verbatim into the note it becomes. A filed note
  // carrying the tag is one that gets proposed and filed again, every pass,
  // forever.
  check("the tag is removed", !isCapture(stripCaptureTag("a thought\n\n#capture\n")));
  check("…mid-sentence, without eating the words either side",
    stripCaptureTag("a thought #capture and more") === "a thought and more");
  check("…leaving no trailing whitespace behind",
    stripCaptureTag("a thought #capture\nmore") === "a thought\nmore");
  check("neighbouring tags survive — they are the note's own",
    stripCaptureTag("thing #capture #rust") === "thing #rust");
  check("#captured is left alone", stripCaptureTag("thing #captured") === "thing #captured");
}

console.log("test: finding them in a vault");
{
  const V = mkdtempSync(join(tmpdir(), "bd-applier-"));
  const w = (rel: string, body: string) => {
    const dir = rel.includes("/") ? join(V, rel.slice(0, rel.lastIndexOf("/"))) : V;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(V, rel), body);
  };
  w("tagged.md", "a thought #capture");
  w("plain.md", "an ordinary note");
  w("daily/Daily-2026-08-23.md", "log #capture");
  w("_ephemeral/scratch.md", "scratch #capture");
  w("_triage/x.triage.md", "#capture");
  w(".obsidian/x.md", "#capture");
  w("notes.txt", "#capture");

  const found = findCaptures(V);
  check("a tagged note at the root is found", found.includes("tagged.md"));
  check("…and one a level down", found.includes("daily/Daily-2026-08-23.md"));
  check("an untagged note is not", !found.includes("plain.md"));
  // _ephemeral is 264 MB of scratch in the real vault; walking it is not an
  // option, and its contents are non-canonical by definition.
  check("underscore directories are never walked",
    !found.some((f) => f.startsWith("_")));
  check("dot directories likewise", !found.some((f) => f.startsWith(".")));
  check("non-markdown is ignored", !found.some((f) => f.endsWith(".txt")));
  check("the result is stable in order", found.join() === [...found].sort().join());
}

console.log(`\n${passed} checks passed`);
