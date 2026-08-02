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
  completeLine, completeInFile, nextRecurrence, canComplete, recurrenceSupported, groupByScope,
  parseRecurrence, occurrencesBetween, occurrencesByDate, timeSpan, monthWindow, shiftMonth,
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
  check("a rule we don't handle is refused, not guessed", nextRecurrence("every 3rd Thursday", "2026-07-20", "x") === null);
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
    completeLine("- [ ] Book club 🔁 every 3rd thursday #task", "2026-07-25") === null);
  check("…but a weekday rule now completes and rolls forward",
    completeLine("- [ ] Church 🔁 every sunday #task", "2026-07-25")!.next
      === "- [ ] Church 🔁 every sunday 📅 2026-07-26 #task");
  check("canComplete gates the UI on the same rule",
    !canComplete(parseTaskLine("- [ ] Book club 🔁 every 3rd thursday #task", "n", "", 1)!) &&
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

  console.log("test: groupByScope");
  const sg = groupByScope(all, "2026-07-25");
  check("unfiled atoms lead, in one bucket", sg[0].note === "Unfiled" && sg[0].unfiled);
  check("…collapsing inbox/ and daily/ together", sg[0].tasks.length === 2);
  check("filed scopes follow, alphabetically",
    sg.slice(1).map((g) => g.note).join(",") === "Broken,Loon");
  check("a section holds only its own note's atoms",
    sg.find((g) => g.note === "Loon")!.tasks.every((t) => t.note === "Loon"));
  check("done and cancelled atoms are excluded, like the date lens",
    sg.every((g) => g.tasks.every((t) => t.status === "open")));
  check("atoms sort by date within a section",
    sg.find((g) => g.note === "Loon")!.tasks.map((t) => t.text).join(",")
      === "Ship the wgpu CI fix,Nested atom");
  check("a section counts its own overdue atoms", sg.find((g) => g.note === "Loon")!.overdue === 1);
  check("…and reports zero when nothing is late", sg.find((g) => g.note === "Broken")!.overdue === 0);
  const undatedLast = groupByScope(
    [
      parseTaskLine("- [ ] No date #task", "N", "", 1)!,
      parseTaskLine("- [ ] Dated 📅 2026-08-01 #task", "N", "", 2)!,
    ],
    "2026-07-25",
  )[0];
  check("undated atoms sink to the bottom of a section",
    undatedLast.tasks.map((t) => t.text).join(",") === "Dated,No date");
  check("every open atom appears in exactly one section",
    sg.reduce((n, g) => n + g.tasks.length, 0) === all.filter((x) => x.status === "open").length);

  console.log("test: recurrence grammar");
  // 2026-08-02 is a Sunday; 2026-08-03 a Monday.
  check("every Sunday lands on the next Sunday", nextRecurrence("every Sunday", "2026-08-02", "x") === "2026-08-09");
  check("a bare weekday from mid-week finds that weekday",
    nextRecurrence("every Sunday", "2026-08-04", "x") === "2026-08-09");
  check("abbreviations parse", nextRecurrence("every mon", "2026-08-03", "x") === "2026-08-10");
  check("every weekday skips the weekend",
    nextRecurrence("every weekday", "2026-08-07", "x") === "2026-08-10"); // Fri -> Mon
  check("…and steps one day inside the week",
    nextRecurrence("every weekday", "2026-08-03", "x") === "2026-08-04");
  check("a multi-day rule hits each listed day",
    nextRecurrence("every week on monday and friday", "2026-08-03", "x") === "2026-08-07");
  check("…then wraps to the next week", nextRecurrence("every week on monday and friday", "2026-08-07", "x") === "2026-08-10");
  check("every 2 weeks on monday leaves a fortnight",
    nextRecurrence("every 2 weeks on monday", "2026-08-03", "x") === "2026-08-17");
  check("every month on the 1st", nextRecurrence("every month on the 1st", "2026-08-01", "x") === "2026-09-01");
  check("…from mid-month it's the coming 1st", nextRecurrence("every month on the 1st", "2026-08-15", "x") === "2026-09-01");
  check("every month on the 15th", nextRecurrence("every month on the 15th", "2026-08-15", "x") === "2026-09-15");
  check("every month on the last day clamps per month",
    nextRecurrence("every month on the last", "2026-01-31", "x") === "2026-02-28");
  check("every 3 months on the 10th", nextRecurrence("every 3 months on the 10th", "2026-08-10", "x") === "2026-11-10");
  check("interval rules still work", nextRecurrence("every 2 days", "2026-08-01", "x") === "2026-08-03");
  check("when done still reads from the completion date",
    nextRecurrence("every monday when done", "2026-01-01", "2026-08-03") === "2026-08-10");
  check("a rule we still can't parse is refused",
    nextRecurrence("every 3rd thursday", "2026-08-01", "x") === null);
  check("…and a half-understood day list is refused whole",
    parseRecurrence("every week on monday and blursday") === null);
  check("garbage is refused", parseRecurrence("whenever I feel like it") === null);
  check("canComplete now accepts a weekday rule",
    canComplete(parseTaskLine("- [ ] Bins out 🔁 every tuesday 📅 2026-08-04 #task", "N", "", 1)!));

  console.log("test: occurrencesBetween");
  const weekly = parseTaskLine("- [ ] Bins out 🔁 every tuesday 📅 2026-08-04 #task", "N", "", 1)!;
  const occ = occurrencesBetween(weekly, "2026-08-01", "2026-08-31");
  check("a weekly atom projects across the month", occ.map((o) => o.date).join(",")
    === "2026-08-04,2026-08-11,2026-08-18,2026-08-25");
  check("only the vault's own instance is real", occ.filter((o) => !o.projected).length === 1);
  check("…and it's the first one", occ[0].date === "2026-08-04" && !occ[0].projected);
  check("occurrences before the window are excluded",
    occurrencesBetween(weekly, "2026-08-12", "2026-08-31").map((o) => o.date).join(",")
      === "2026-08-18,2026-08-25");
  const once = parseTaskLine("- [ ] File taxes 📅 2026-08-10 #task", "N", "", 1)!;
  check("a one-shot yields exactly itself", occurrencesBetween(once, "2026-08-01", "2026-08-31").length === 1);
  check("…and nothing outside the window", occurrencesBetween(once, "2026-09-01", "2026-09-30").length === 0);
  const undated = parseTaskLine("- [ ] Someday #task", "N", "", 1)!;
  check("an undated atom can't be placed on a calendar", occurrencesBetween(undated, "2026-08-01", "2026-08-31").length === 0);
  const unparseable = parseTaskLine("- [ ] Book club 🔁 every 3rd thursday 📅 2026-08-20 #task", "N", "", 1)!;
  check("an unparseable rule still shows its real instance, and only that",
    occurrencesBetween(unparseable, "2026-08-01", "2026-12-31").map((o) => o.date).join(",") === "2026-08-20");
  const daily = parseTaskLine("- [ ] Ping 🔁 every day 📅 2026-08-01 #task", "N", "", 1)!;
  check("the cap truncates a runaway projection rather than hanging",
    occurrencesBetween(daily, "2026-08-01", "2036-08-01", 10).length === 11);
  check("a done atom projects nothing",
    occurrencesBetween(parseTaskLine("- [x] Done 🔁 every day ✅ 2026-08-01 📅 2026-08-01 #task", "N", "", 1)!,
      "2026-08-01", "2026-08-31").length === 0);

  const grid = occurrencesByDate([weekly, once], "2026-08-01", "2026-08-31");
  check("occurrences group by day", grid.get("2026-08-04")!.length === 1 && grid.get("2026-08-10")!.length === 1);
  check("…and a day with nothing on it is simply absent", !grid.has("2026-08-05"));

  console.log("test: time of day");
  const timed = parseTaskLine("- [ ] Dentist @14:00 📅 2026-08-05 #task", "N", "", 1)!;
  check("a start time parses", timed.time?.start === "14:00" && timed.time?.end === null);
  check("…and is stripped from the display text", timed.text === "Dentist");
  check("…with the default duration applied", JSON.stringify(timeSpan(timed)) === '{"start":"14:00","end":"14:30"}');
  const ranged = parseTaskLine("- [ ] Standup @09:30-10:00 #task", "N", "", 1)!;
  check("an explicit range parses", JSON.stringify(timeSpan(ranged)) === '{"start":"09:30","end":"10:00"}');
  check("…and leaves clean text", ranged.text === "Standup");
  check("a single-digit hour normalises", parseTaskLine("- [ ] Gym @7:05 #task", "N", "", 1)!.time?.start === "07:05");
  check("an all-day atom has no time", parseTaskLine("- [ ] Whenever #task", "N", "", 1)!.time === null);
  check("a bare clock time in prose is NOT a time",
    parseTaskLine("- [ ] Read John 3:16 #task", "N", "", 1)!.time === null);
  check("…and stays in the text", parseTaskLine("- [ ] Read John 3:16 #task", "N", "", 1)!.text === "Read John 3:16");
  check("an @mention is not a time", parseTaskLine("- [ ] Email @bob #task", "N", "", 1)!.time === null);
  const bad = parseTaskLine("- [ ] Typo @99:00 #task", "N", "", 1)!;
  check("an impossible hour is left visible as the typo it is", bad.time === null && bad.text.includes("@99:00"));
  check("an end before the start is dropped, not inverted",
    parseTaskLine("- [ ] Backwards @14:00-09:00 #task", "N", "", 1)!.time?.end === null);
  check("the day's last minutes don't spill into tomorrow",
    timeSpan(parseTaskLine("- [ ] Late @23:50 #task", "N", "", 1)!)!.end === "23:59");
  check("a time survives the round trip through the completion rewrite",
    completeLine("- [ ] Dentist @14:00 📅 2026-08-05 #task", "2026-08-05")!.done
      === "- [x] Dentist @14:00 📅 2026-08-05 ✅ 2026-08-05 #task");

  const dayOrder = groupByDue([
    parseTaskLine("- [ ] All-day thing ⏫ 📅 2026-08-05 #task", "N", "", 1)!,
    parseTaskLine("- [ ] Dentist @14:00 📅 2026-08-05 #task", "N", "", 2)!,
    parseTaskLine("- [ ] Standup @09:30 📅 2026-08-05 #task", "N", "", 3)!,
  ], "2026-08-05")[0];
  check("a day reads as a schedule: timed atoms in clock order, all-day last",
    dayOrder.tasks.map((t) => t.text).join(",") === "Standup,Dentist,All-day thing");

  console.log("test: monthWindow");
  const w = monthWindow("2026-08", "2026-08-02");
  check("the month's own bounds", w.first === "2026-08-01" && w.last === "2026-08-31");
  check("the grid starts on the Sunday on or before the 1st", w.gridFrom === "2026-07-26");
  check("…and ends on the Saturday on or after the last", w.gridTo === "2026-09-05");
  check("the grid is a whole number of weeks",
    (daysBetween(w.gridFrom, w.gridTo) + 1) % 7 === 0);
  const feb = monthWindow("2026-02", "2026-08-02");
  check("February's length is its own", feb.last === "2026-02-28");
  const leap = monthWindow("2028-02", "2026-08-02");
  check("…and a leap February gets its 29th", leap.last === "2028-02-29");
  check("a month that already starts on Sunday doesn't grow a blank week",
    monthWindow("2026-11", "2026-08-02").gridFrom === "2026-11-01");
  check("garbage falls back to today's month", monthWindow("nope", "2026-08-02").month === "2026-08");
  check("…as does an impossible month", monthWindow("2026-13", "2026-08-02").month === "2026-08");
  check("shiftMonth crosses a year boundary", shiftMonth("2026-12", 1) === "2027-01");
  check("…backwards too", shiftMonth("2026-01", -1) === "2025-12");

  console.log(`\n${passed} checks passed`);
}

await main();
