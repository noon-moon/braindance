// Funnel tests — the `#task` atom the task funnel emits, and where filing puts
// it inside an existing note. Run: `npm run test:funnels`.
//
// These two functions are the whole task-ingest contract: `taskLine` decides
// what an atom LOOKS like (it has to survive a round-trip through the /todo
// parser), and `appendTaskLine` decides where filing lands it. Both are pure.
import assert from "node:assert/strict";
import { taskLine, appendTaskLine, funnelById } from "../src/funnels.js";
import { parseTaskLine } from "../src/tasks.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

console.log("test: taskLine");
{
  const bare = taskLine({ title: "Call the vet" });
  check("a bare atom is a checklist line ending in #task", bare === "- [ ] Call the vet #task");

  const full = taskLine({ title: "File taxes", due: "2026-04-15", priority: "medium" });
  check("priority precedes the due date", full === "- [ ] File taxes 🔼 📅 2026-04-15 #task");

  check(
    "an unknown priority is dropped, not emitted raw",
    taskLine({ title: "x", priority: "urgent" }) === "- [ ] x #task",
  );
  check(
    "a multi-line description is flattened",
    taskLine({ title: "line one\nline two" }) === "- [ ] line one line two #task",
  );
  check(
    "a #task the user typed themselves isn't doubled",
    taskLine({ title: "Ship #task now" }) === "- [ ] Ship now #task",
  );
  check(
    "#tasks is left alone — only the exact global filter is stripped",
    taskLine({ title: "Review #tasks doc" }) === "- [ ] Review #tasks doc #task",
  );

  // A description is free text sitting AHEAD of the real fields, so a signifier
  // in it is a field it can forge — into someone else's note, since filing
  // appends the line to a scope note. The words stay, the emoji cannot.
  const forged = taskLine({ title: "chase the landlord 🔁 every day 📅 2020-01-01" });
  check(
    "a signifier typed into the description is stripped, its words kept",
    forged === "- [ ] chase the landlord every day 2020-01-01 #task",
  );
  const reread = parseTaskLine(forged, "Home", "", 1);
  check("…so the atom it produces has no forged recurrence", reread?.recurrence === null);
  check("…and no forged due date", reread?.due === null);
  check(
    "a forged priority can't outrank the empty priority field",
    parseTaskLine(taskLine({ title: "tidy up 🔺" }), "Home", "", 1)?.priority === null,
  );
  check(
    "an emoji-presentation signifier goes with its variation selector",
    taskLine({ title: "ship it ⏳\uFE0F 2026-01-01" }) === "- [ ] ship it 2026-01-01 #task",
  );
  check(
    "the structured fields still set what only they may set",
    taskLine({ title: "chase the landlord 📅 2020-01-01", due: "2026-04-15" })
      === "- [ ] chase the landlord 2020-01-01 📅 2026-04-15 #task",
  );

  // The round trip that matters: whatever we write, /todo must read back.
  const parsed = parseTaskLine(full, "Money", "", 1);
  check("the emitted line parses back as an open atom", parsed?.status === "open");
  check("…with its due date intact", parsed?.due === "2026-04-15");
  check("…its priority intact", parsed?.priority === "medium");
  check("…and a clean display text", parsed?.text === "File taxes");
}

console.log("test: appendTaskLine");
{
  const line = "- [ ] Ship it #task";

  const plain = appendTaskLine("---\ntags:\n  - scope\n---\n\nHub for things.\n", line);
  check("a note with no Tasks section gets the atom at the end", plain.endsWith("Hub for things.\n\n- [ ] Ship it #task\n"));
  check("frontmatter is untouched (raw bytes, never re-serialised)", plain.startsWith("---\ntags:\n  - scope\n---\n"));

  const joined = appendTaskLine("# Loon\n\n- [ ] Existing atom #task\n", line);
  check("a trailing checklist is joined, not split into a second list",
    joined.endsWith("- [ ] Existing atom #task\n- [ ] Ship it #task\n"));
  check("prose still gets a blank line before the atom",
    appendTaskLine("# Loon\n\nSome prose.\n", line).endsWith("Some prose.\n\n- [ ] Ship it #task\n"));

  const sectioned = appendTaskLine(
    ["# Loon", "", "## Tasks", "", "- [ ] Existing atom #task", "", "## References", "", "Some link.", ""].join("\n"),
    line,
  );
  const at = sectioned.split("\n");
  check("a Tasks section takes the atom", at.indexOf(line) > at.indexOf("## Tasks"));
  check("…at the END of that section's list", at.indexOf(line) === at.indexOf("- [ ] Existing atom #task") + 1);
  check("…and above the following heading", at.indexOf(line) < at.indexOf("## References"));
  check("the blank line before the next heading survives", sectioned.includes("#task\n\n## References"));

  const empty = appendTaskLine(["# Loon", "", "## Tasks", "", "## Later", ""].join("\n"), line);
  check("an empty Tasks section still takes it", empty.split("\n").indexOf(line) === 3);

  const trailing = appendTaskLine(["# Loon", "", "## Tasks", "", "- [ ] One #task", "", "", ""].join("\n"), line);
  check("trailing blank lines don't push the atom off the list", trailing.endsWith("- [ ] One #task\n- [ ] Ship it #task\n"));

  check(
    "heading match is case-insensitive and level-agnostic",
    appendTaskLine("# N\n\n### TASKS\n", line).trimEnd().endsWith("### TASKS\n- [ ] Ship it #task"),
  );
  check(
    "a heading that merely starts with Tasks is not a Tasks section",
    appendTaskLine("# N\n\n## Tasks done\n", line).trimEnd().endsWith("## Tasks done\n\n- [ ] Ship it #task"),
  );
}

console.log("test: funnel registry");
{
  check("the task funnel exists", funnelById("task")?.id === "task");
  check("the retired `todo` id still resolves to it", funnelById("todo")?.id === "task");
  check("an unknown id is still undefined", funnelById("nope") === undefined);

  const built = funnelById("task")!.build({ title: "Call the vet", due: "2026-08-05", scope: "Pets", priority: "" });
  check("a captured task carries its scope link", built.body.startsWith("Tags: [[Pets]]\n"));
  check("…and a real atom in the body", built.body.includes("- [ ] Call the vet 📅 2026-08-05 #task"));
  check("…tagged memo, with no legacy status/due frontmatter", JSON.stringify(built.frontmatter) === '{"tags":["memo"]}');
  check("…and no stray blank block when there's no detail", built.body.endsWith("#task"));

  const withDetail = funnelById("task")!.build({ title: "Call the vet", body: "Ask about the limp.", due: "" });
  check("detail rides along BELOW the atom, not inside it",
    withDetail.body.endsWith("- [ ] Call the vet #task\n\nAsk about the limp."));
}

console.log(`\n${passed} checks passed`);
