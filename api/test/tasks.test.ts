// Task index tests — line parsing, the vault scan (what counts as a task and
// what must NOT), and Reminders-style date bucketing. Run: `npm run test:tasks`.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// tasks.ts resolves its vault at import time — point it at a fixture first.
const vault = mkdtempSync(join(tmpdir(), "bd-tasks-"));
process.env.VAULT_PATH = vault;
process.env.TZ = "UTC"; // deterministic "today"
const {
  parseTaskLine, listTasks, groupByDue, completedTasks, addDays, daysBetween, todayISO,
  completeLine, completeInFile, nextRecurrence, canComplete, recurrenceSupported,
} = await import("../src/tasks.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

function seed() {
  const w = (rel: string, body: string) => {
    const abs = join(vault, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };
  // A filed scope note: frontmatter, a real task, a prose checkbox, a bare bullet.
  w("Loon.md", [
    "---", "tags:", "  - scope", "---", "",
    "# Loon", "",
    "- [ ] Ship the wgpu CI fix 📅 2026-07-20 ⏫ #task",
    "- [ ] not a task — no global filter",
    "- [x] Land the parser ✅ 2026-07-25 #task",
    "- [-] Abandoned approach #task",
    "- [ ] Nested atom 📅 2026-08-02 #task",
    "",
  ].join("\n"));
  // Unfiled atoms — still loose in the capture queue and a daily note.
  w("inbox/2026-07-28T06-00-00-000Z-buy-cable.md", "- [ ] Buy the DP cable #task\n");
  w("daily/2026-07-29.md", "---\ntags:\n  - daily\n---\n- [ ] Call the dentist ⏳ 2026-07-30 #task\n");
  // Docs + scratch: these hold EXAMPLE task lines and must never be indexed.
  w("_meta/Tags.md", "- [ ] File 2025 taxes 📅 2026-04-15 🔼 #task\n");
  w("_ephemeral/draft.md", "- [ ] Example atom 📅 2026-07-29 #task\n");
  w(".obsidian/junk.md", "- [ ] Hidden 📅 2026-07-29 #task\n");
  // Unparseable YAML (an unquoted `:` in a value) — real notes do this. Its atoms
  // must still surface rather than 500 the tab.
  w("Broken.md", "---\ntags:\n  - memo\ntopic: a seam: with a colon\n---\n- [ ] Survives bad frontmatter #task\n");
}

async function main() {
  console.log("test: parseTaskLine");
  const t = parseTaskLine("- [ ] File 2025 taxes 📅 2026-04-15 🔼 #task", "N", "", 3);
  check("parses an open task", t?.status === "open");
  check("extracts the due date", t?.due === "2026-04-15");
  check("extracts the priority", t?.priority === "medium");
  check("strips signifiers and the tag from the text", t?.text === "File 2025 taxes");
  check("records note + line", t?.note === "N" && t?.line === 3);

  const rec = parseTaskLine("- [ ] Process inbox 🔁 every day when done 📅 2026-07-29 #task", "N", "", 1);
  check("captures a recurrence rule verbatim", rec?.recurrence === "every day when done");
  check("recurrence does not swallow the following date", rec?.due === "2026-07-29");
  check("recurrence is stripped from the text", rec?.text === "Process inbox");

  const done = parseTaskLine("- [x] Renew domain ✅ 2026-07-20 #task", "N", "", 1);
  check("parses a done task with its done date", done?.status === "done" && done?.completed === "2026-07-20");
  check("cancelled box is status cancelled", parseTaskLine("- [-] Dropped #task", "N", "", 1)?.status === "cancelled");
  check("unknown box (e.g. [/]) counts as open", parseTaskLine("- [/] Doing #task", "N", "", 1)?.status === "open");
  check("indented + asterisk bullets parse", parseTaskLine("   * [ ] Sub-atom #task", "N", "", 1)?.text === "Sub-atom");
  check("a checkbox without the global filter is not a task", parseTaskLine("- [ ] just prose", "N", "", 1) === null);
  check("#tasks does not satisfy the global filter", parseTaskLine("- [ ] plural #tasks", "N", "", 1) === null);
  check("a non-checklist line is not a task", parseTaskLine("Some prose #task", "N", "", 1) === null);
  check("inbox/daily atoms are flagged unfiled", parseTaskLine("- [ ] x #task", "N", "inbox", 1)?.unfiled === true);
  check("root atoms are filed", parseTaskLine("- [ ] x #task", "N", "", 1)?.unfiled === false);

  console.log("test: listTasks (vault scan)");
  seed();
  const all = listTasks();
  const texts = all.map((x) => x.text).sort();
  check("finds atoms in root notes", texts.includes("Ship the wgpu CI fix"));
  check("finds atoms in inbox/", texts.includes("Buy the DP cable"));
  check("finds atoms in daily/", texts.includes("Call the dentist"));
  check("skips prose checkboxes", !texts.includes("not a task — no global filter"));
  check("skips _meta/ example lines", !texts.includes("File 2025 taxes"));
  check("skips _ephemeral/ scratch lines", !texts.includes("Example atom"));
  check("skips dotfile dirs", !texts.includes("Hidden"));
  check("a note with unparseable frontmatter still yields its atoms", texts.includes("Survives bad frontmatter"));
  // 4 in Loon.md (open, done, cancelled, dated) + 1 inbox + 1 daily + 1 broken-YAML.
  check("indexes exactly the 7 real atoms", all.length === 7);
  // Body-relative: gray-matter replaces the frontmatter block with one blank line,
  // so the body is ["", "# Loon", "", "- [ ] Ship…"].
  check("line numbers are body-relative (frontmatter excluded)", all.find((x) => x.text === "Ship the wgpu CI fix")?.line === 4);

  console.log("test: groupByDue");
  const groups = groupByDue(all, "2026-07-29");
  const labels = groups.map((g) => g.label);
  check("sections are ascending: overdue → today → tomorrow → later → undated",
    JSON.stringify(labels) === JSON.stringify(["Overdue", "Tomorrow", "Sunday, August 2", "No date"]));
  check("the overdue atom lands in Overdue", groups[0].tasks[0].text === "Ship the wgpu CI fix");
  check("a scheduled-only atom buckets on its scheduled date", groups[1].tasks[0].text === "Call the dentist");
  check("an undated atom lands in No date", groups[3].tasks[0].text === "Buy the DP cable");
  check("done atoms are excluded from the open sections",
    groups.every((g) => g.tasks.every((x) => x.status === "open")));
  check("cancelled atoms are excluded too",
    !groups.some((g) => g.tasks.some((x) => x.text === "Abandoned approach")));

  const todayG = groupByDue(all, "2026-07-20");
  check("a due-today atom is labelled Today", todayG[0].label === "Today");
  check("nothing is overdue when today IS the due date", todayG[0].kind === "today");

  console.log("test: completedTasks + date helpers");
  const cd = completedTasks(all);
  check("completed list holds only done atoms", cd.length === 1 && cd[0].text === "Land the parser");
  check("addDays crosses a month boundary", addDays("2026-07-31", 1) === "2026-08-01");
  check("addDays goes backwards", addDays("2026-08-01", -1) === "2026-07-31");
  check("daysBetween counts whole days", daysBetween("2026-07-20", "2026-07-29") === 9);
  check("daysBetween is negative backwards", daysBetween("2026-07-29", "2026-07-20") === -9);
  check("todayISO returns a YYYY-MM-DD date", /^\d{4}-\d{2}-\d{2}$/.test(todayISO()));
  check("todayISO honours TZ (UTC fixture)", todayISO(new Date("2026-07-29T23:30:00Z")) === "2026-07-29");

  console.log("test: nextRecurrence");
  check("every day steps one day", nextRecurrence("every day", "2026-07-20", "2026-07-25") === "2026-07-21");
  check("…from the COMPLETION date when the rule says when done",
    nextRecurrence("every day when done", "2026-07-20", "2026-07-25") === "2026-07-26");
  check("every 3 weeks steps 21 days", nextRecurrence("every 3 weeks", "2026-07-20", "x") === "2026-08-10");
  check("every month shifts the month, not 30 days", nextRecurrence("every month", "2026-01-15", "x") === "2026-02-15");
  check("a day-of-month that doesn't exist clamps", nextRecurrence("every month", "2026-01-31", "x") === "2026-02-28");
  check("every year shifts the year", nextRecurrence("every year", "2026-02-28", "x") === "2027-02-28");
  check("an undated recurring atom falls back to today",
    nextRecurrence("every week", "", "2026-07-25") === "2026-08-01");
  check("a rule we don't handle is refused, not guessed", nextRecurrence("every Sunday", "2026-07-20", "x") === null);
  check("…and recurrenceSupported agrees", !recurrenceSupported("every 3rd Thursday") && recurrenceSupported("every 2 days"));

  console.log("test: completeLine");
  const done1 = completeLine("- [ ] Renew domain 📅 2026-07-20 #task", "2026-07-25");
  check("the box is ticked", done1!.done.startsWith("- [x] Renew domain"));
  check("the done date lands before the trailing #task",
    done1!.done === "- [x] Renew domain 📅 2026-07-20 ✅ 2026-07-25 #task");
  check("a one-shot atom spawns no next instance", done1!.next === null);
  check("indentation and bullet style survive",
    completeLine("  * [ ] Sub-atom #task", "2026-07-25")!.done === "  * [x] Sub-atom ✅ 2026-07-25 #task");
  check("a line that tags mid-text still gets its done date",
    completeLine("- [ ] #task with trailing prose", "2026-07-25")!.done === "- [x] #task with trailing prose ✅ 2026-07-25");
  check("an already-done atom is refused", completeLine("- [x] Done ✅ 2026-07-01 #task", "2026-07-25") === null);
  check("a non-task line is refused", completeLine("- [ ] just a checkbox", "2026-07-25") === null);

  const recDone = completeLine("- [ ] Process inbox 🔁 every day when done 📅 2026-07-20 #task", "2026-07-25");
  check("a recurring atom is completed", recDone!.done.includes("✅ 2026-07-25"));
  check("…and spawns the next instance", recDone!.next === "- [ ] Process inbox 🔁 every day when done 📅 2026-07-26 #task");
  const multi = completeLine("- [ ] Backup 🔁 every week ⏳ 2026-07-18 📅 2026-07-20 #task", "2026-07-25");
  check("every date shifts by the same delta, keeping its offset",
    multi!.next === "- [ ] Backup 🔁 every week ⏳ 2026-07-25 📅 2026-07-27 #task");
  const undatedRec = completeLine("- [ ] Water plants 🔁 every 2 days #task", "2026-07-25");
  check("an undated recurring atom gains a date, or it'd never come due",
    undatedRec!.next === "- [ ] Water plants 🔁 every 2 days 📅 2026-07-27 #task");
  check("a rule we won't roll forward blocks completion entirely",
    completeLine("- [ ] Church 🔁 every Sunday #task", "2026-07-25") === null);
  check("canComplete gates the UI on the same rule",
    !canComplete(parseTaskLine("- [ ] Church 🔁 every Sunday #task", "n", "", 1)!) &&
    canComplete(parseTaskLine("- [ ] Plain #task", "n", "", 1)!));

  console.log("test: completeInFile");
  const file = ["---", "tags:", "  - scope", "---", "", "# Loon", "", "- [ ] Alpha #task", "- [ ] Beta #task", ""].join("\n");
  const atoms = parseTaskLine("- [ ] Beta #task", "Loon", "", 4)!;
  const out = completeInFile(file, 4, atoms.raw, "2026-07-25");
  check("the right line is rewritten, by body-relative number",
    out!.includes("- [ ] Alpha #task\n- [x] Beta ✅ 2026-07-25 #task"));
  check("frontmatter is left alone", out!.startsWith("---\ntags:\n  - scope\n---"));
  check("a line number that no longer matches falls back to a unique text match",
    completeInFile(file, 99, "- [ ] Beta #task", "2026-07-25")!.includes("- [x] Beta"));
  check("an atom that changed under us is refused",
    completeInFile(file, 4, "- [ ] Beta rewritten in Obsidian #task", "2026-07-25") === null);
  const dupes = ["- [ ] Same #task", "- [ ] Same #task", ""].join("\n");
  check("an ambiguous duplicate line is refused rather than guessed",
    completeInFile(dupes, 9, "- [ ] Same #task", "2026-07-25") === null);
  check("…but the recorded line number resolves the duplicate",
    completeInFile(dupes, 1, "- [ ] Same #task", "2026-07-25") === "- [x] Same ✅ 2026-07-25 #task\n- [ ] Same #task\n");
  const recFile = ["- [ ] Daily 🔁 every day 📅 2026-07-20 #task", ""].join("\n");
  check("a new instance is inserted ABOVE the completed line",
    completeInFile(recFile, 1, "- [ ] Daily 🔁 every day 📅 2026-07-20 #task", "2026-07-25")!.split("\n")[0]
      === "- [ ] Daily 🔁 every day 📅 2026-07-21 #task");

  console.log(`\n${passed} checks passed`);
}

await main();
