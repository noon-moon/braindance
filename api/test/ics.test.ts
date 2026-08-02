// iCalendar feed tests — RRULE translation, all-day vs timed events, folding,
// escaping, and what the feed deliberately leaves out. Run: `npm run test:ics`.
//
// The feed is consumed by Apple Calendar, which fails quietly: a malformed line
// yields an empty or partial calendar with no error. So these tests assert the
// wire format fairly literally.
import assert from "node:assert/strict";
import { buildICS, rrule, fold, uid } from "../src/ics.js";
import { parseTaskLine, type Task } from "../src/tasks.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

const T = (line: string, note = "Home"): Task => parseTaskLine(line, note, "", 1)!;
const NOW = new Date("2026-08-02T12:00:00Z");
const build = (lines: string[], o = {}) =>
  buildICS(lines.map((l) => T(l)), { now: NOW, ...o });
/** Unfold before asserting — a long line is split across continuations. */
const unfold = (s: string) => s.replace(/\r\n /g, "");

console.log("test: rrule");
{
  check("daily", rrule("every day") === "FREQ=DAILY");
  check("every N days carries an interval", rrule("every 3 days") === "FREQ=DAILY;INTERVAL=3");
  check("weekly", rrule("every week") === "FREQ=WEEKLY");
  check("monthly", rrule("every month") === "FREQ=MONTHLY");
  check("yearly", rrule("every year") === "FREQ=YEARLY");
  check("a bare weekday becomes BYDAY", rrule("every tuesday") === "FREQ=WEEKLY;BYDAY=TU");
  check("multiple weekdays", rrule("every week on monday and friday") === "FREQ=WEEKLY;BYDAY=MO,FR");
  check("every weekday is Mon-Fri", rrule("every weekday") === "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  check("a fortnightly weekday keeps both", rrule("every 2 weeks on monday") === "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
  check("a month day becomes BYMONTHDAY", rrule("every month on the 15th") === "FREQ=MONTHLY;BYMONTHDAY=15");
  check("the last day of the month is -1", rrule("every month on the last") === "FREQ=MONTHLY;BYMONTHDAY=-1");
  check("a rule we can't parse yields no RRULE at all", rrule("every 3rd thursday") === null);
}

console.log("test: events");
{
  const allDay = build(["- [ ] File taxes 📅 2026-04-15 #task"]);
  check("an atom with no time is an all-day event", allDay.includes("DTSTART;VALUE=DATE:20260415"));
  check("…whose DTEND is exclusive (the next day)", allDay.includes("DTEND;VALUE=DATE:20260416"));
  check("the summary is the display text, signifiers stripped", allDay.includes("SUMMARY:File taxes"));
  check("the note becomes a category", allDay.includes("CATEGORIES:Home"));
  check("no RRULE on a one-shot", !allDay.includes("RRULE"));
  check("no alarm unless asked for", !allDay.includes("VALARM"));
  check("no URL unless a base is configured", !allDay.includes("URL:"));

  const timed = build(["- [ ] Dentist @14:00 📅 2026-08-05 #task"]);
  check("a timed atom is a floating local-time event", timed.includes("DTSTART:20260805T140000"));
  check("…with the default duration applied", timed.includes("DTEND:20260805T143000"));
  check("…and no TZID, which is what floating means", !/DTSTART;TZID/.test(timed));
  check("an explicit range wins",
    build(["- [ ] Standup @09:30-09:45 📅 2026-08-05 #task"]).includes("DTEND:20260805T094500"));

  const rec = build(["- [ ] Bins out 🔁 every tuesday 📅 2026-08-04 #task"]);
  check("a recurring atom carries an RRULE rather than repeated events",
    rec.includes("RRULE:FREQ=WEEKLY;BYDAY=TU") && rec.split("BEGIN:VEVENT").length === 2);
  const unparseable = build(["- [ ] Book club 🔁 every 3rd thursday 📅 2026-08-20 #task"]);
  check("an unparseable rule emits a single dated event, not a guess",
    !unparseable.includes("RRULE") && unparseable.includes("DTSTART;VALUE=DATE:20260820"));

  check("priority maps onto the iCalendar scale",
    build(["- [ ] Rent ⏫ 📅 2026-08-01 #task"]).includes("PRIORITY:2"));
  const withUrl = build(["- [ ] Thing 📅 2026-08-01 #task"], { baseUrl: "http://box:3000/" });
  check("a configured base URL links the event back to its note",
    unfold(withUrl).includes("URL:http://box:3000/vault/Home"));
  const alarmed = build(["- [ ] Thing 📅 2026-08-01 #task"], { alarmMin: 15 });
  check("an alarm is emitted when configured", alarmed.includes("TRIGGER:-PT15M"));
}

console.log("test: what the feed leaves out");
{
  check("a completed atom is not an obligation",
    !build(["- [x] Done ✅ 2026-08-01 📅 2026-08-01 #task"]).includes("BEGIN:VEVENT"));
  check("a cancelled atom likewise",
    !build(["- [-] Dropped 📅 2026-08-01 #task"]).includes("BEGIN:VEVENT"));
  check("an undated atom has no day to sit on",
    !build(["- [ ] Someday #task"]).includes("BEGIN:VEVENT"));
  check("a scheduled-only atom still lands, on its scheduled day",
    build(["- [ ] Soon ⏳ 2026-08-09 #task"]).includes("DTSTART;VALUE=DATE:20260809"));
}

console.log("test: wire format");
{
  const ics = build(["- [ ] Thing 📅 2026-08-01 #task"]);
  check("every line ends CRLF", !/[^\r]\n/.test(ics));
  check("the calendar is wrapped", ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  check("it names itself", ics.includes("X-WR-CALNAME:braindance"));
  check("DTSTAMP is a UTC instant", ics.includes("DTSTAMP:20260802T120000Z"));

  const commas = build(["- [ ] Buy milk, eggs; and bread 📅 2026-08-01 #task"]);
  check("commas and semicolons are escaped", unfold(commas).includes("SUMMARY:Buy milk\\, eggs\\; and bread"));

  const long = build([`- [ ] ${"x".repeat(200)} 📅 2026-08-01 #task`]);
  check("a long line is folded", long.includes("\r\n "));
  check("…to 75 octets or fewer", long.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75));
  check("…and unfolds back to the original", unfold(long).includes(`SUMMARY:${"x".repeat(200)}`));

  const emoji = fold(`SUMMARY:${"🎧".repeat(40)}`);
  check("folding never splits a multi-byte character",
    emoji.replace(/\r\n /g, "") === `SUMMARY:${"🎧".repeat(40)}`);
  check("…and still respects the octet limit",
    emoji.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75));
}

console.log("test: identity");
{
  const a = T("- [ ] Thing 📅 2026-08-01 #task");
  const b = T("- [ ] Thing 📅 2026-09-01 ⏫ #task");
  check("the UID survives a date or priority change, so the event updates", uid(a) === uid(b));
  check("a different note is a different event", uid(a) !== uid(T("- [ ] Thing 📅 2026-08-01 #task", "Work")));
  check("different text is a different event", uid(a) !== uid(T("- [ ] Other 📅 2026-08-01 #task")));
  check("the UID is domain-qualified", /@braindance$/.test(uid(a)));
}

console.log(`\n${passed} checks passed`);
