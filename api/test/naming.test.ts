// What a note is CALLED, and where it lands. Run: `npm run test:naming`.
//
// VAULT_PATH is set BEFORE the first import on purpose: `config.ts` reads it
// into a module-level const, so an import that happens first freezes the wrong
// vault. A version of this test living in applier.test.ts passed against the
// real vault by coincidence — it asked whether `Octavia Butler` was taken, and
// in the author's actual vault it is.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const V = mkdtempSync(join(tmpdir(), "bd-naming-"));
process.env.VAULT_PATH = V;
mkdirSync(join(V, "TaskNotes/Tasks"), { recursive: true });
writeFileSync(join(V, "Octavia Butler.md"), "---\ntags: [memo]\n---\n# Octavia Butler\n");
writeFileSync(join(V, "TaskNotes/Tasks/Buy milk.md"), "---\ntags: [task]\n---\n");

const { uniqueTaskDest, qualify } = await import("../src/applier.js");
const { noteName } = await import("../src/notes.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

console.log("test: the filename IS the title");
{
  // `docs/vault.md` states it as an invariant, and this loop broke it for every
  // memo it filed: `at-proto-llm-mcp-link.md` titled "AT Proto LLM MCP link".
  // Obsidian resolves [[wikilinks]] by basename, so those notes were unlinkable
  // by the name they display.
  check("a typed title survives as typed", noteName("Parable of the Sower") === "Parable of the Sower");
  check("…capitals and all", noteName("AT Proto LLM MCP link") === "AT Proto LLM MCP link");
  check("…and is not slugged", !noteName("Blood Child").includes("-"));
  // Only what a filename or a wikilink genuinely cannot hold is removed.
  check("wikilink and path characters are dropped", noteName("Home/DIY [notes]") === "Home DIY notes");
}

console.log("test: a collision is QUALIFIED, never mangled");
{
  check("the qualifier reads as a name a person would write", qualify("Parable of the Sower", 2) === "Parable of the Sower (2)");

  // Obsidian resolves by basename wherever the file sits, so a task named after
  // a ROOT note makes every link to that name ambiguous. That is what happened
  // to `[[Octavia Butler]]`: the author memo, and a task filed beside it.
  check("a task colliding with a root note is qualified",
    uniqueTaskDest("Octavia Butler") === "TaskNotes/Tasks/Octavia Butler (2).md");
  check("a task colliding with another task is qualified",
    uniqueTaskDest("Buy milk") === "TaskNotes/Tasks/Buy milk (2).md");
  check("an uncontested name is left exactly as typed",
    uniqueTaskDest("Call the dentist") === "TaskNotes/Tasks/Call the dentist.md");
  check("matching is case-insensitive, as Obsidian's resolution is",
    uniqueTaskDest("octavia butler") === "TaskNotes/Tasks/octavia butler (2).md");
  check("the note it collided with is never touched", existsSync(join(V, "Octavia Butler.md")));
}

console.log(`\n${passed} checks passed`);
