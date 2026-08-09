// iCalendar feed over the task index — `GET /todo.ics`.
//
// The point is visibility somewhere you already look: subscribe once in Apple
// Calendar (or anything else that speaks iCalendar) and every dated `#task`
// atom shows up next to real events, with no app to open and nothing to
// maintain. Read-only by construction — a subscribed calendar can't write back,
// which suits a vault whose source of truth is Markdown in git.
//
// Two deliberate choices worth knowing:
//
//   - **Recurrence is emitted as RRULE, not expanded.** The client does the
//     expansion, so the series is unbounded and a rule change re-expands
//     everywhere instead of leaving stale copies behind. A rule we can't parse
//     (see parseRecurrence) emits a single event rather than a guess.
//   - **Timed events are FLOATING local time** — no TZID, no `Z`. A floating
//     time means "14:00 wherever the viewer is", which is what an atom written
//     `@14:00` in a personal vault means. It also avoids shipping a VTIMEZONE
//     block, which is the usual source of feed bugs.
import { createHash } from "node:crypto";
import { effectiveDate, timeSpan, parseRecurrence, addDays, type Task } from "./tasks.js";

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newline are special. */
const esc = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 §3.1: content lines are folded at 75 OCTETS, continuations starting
 *  with a space. Folding by UTF-8 byte length (not characters) matters here —
 *  task text is full of emoji and non-ASCII punctuation. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte sequence: back off to a lead byte.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return out.join("\r\n ");
}

const stamp = (d: Date): string => `${d.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
const dateOnly = (iso: string): string => iso.replace(/-/g, "");
const dateTime = (iso: string, hhmm: string): string => `${dateOnly(iso)}T${hhmm.replace(":", "")}00`;

/** A stable identity for an atom, so re-fetching the feed UPDATES its event
 *  rather than duplicating it. Derived from the note plus the task text: the
 *  line number would churn on every edit above it, and the text is what the
 *  event actually shows. Editing the text does mint a new UID — by then it is,
 *  reasonably, a different obligation. */
export const uid = (t: Task): string =>
  `${createHash("sha1").update(`${t.note}\u0000${t.text}`).digest("hex").slice(0, 24)}@braindance`;

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Translate a `🔁` rule into an RRULE, or null when we can't express it — in
 *  which case the event is emitted once, on its own date. Never guess: a wrong
 *  RRULE quietly fills someone's calendar with wrong days. */
export function rrule(rule: string): string | null {
  const r = parseRecurrence(rule);
  if (!r) return null;
  const every = r.step > 1 ? `;INTERVAL=${r.step}` : "";
  if (r.kind === "interval") {
    const freq = { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" }[r.unit];
    return `FREQ=${freq}${every}`;
  }
  if (r.kind === "weekday") return `FREQ=WEEKLY${every};BYDAY=${r.days.map((d) => BYDAY[d]).join(",")}`;
  // day 0 is our "last day of the month"; iCalendar spells that -1.
  return `FREQ=MONTHLY${every};BYMONTHDAY=${r.day === 0 ? -1 : r.day}`;
}

export interface IcsOptions {
  /** Base URL of this viewer, so an event links back to its note. */
  baseUrl?: string;
  /** Minutes BEFORE a timed atom (`@14:00`) to alert. Several = several alarms.
   *  Empty/undefined = silent, which is the default. */
  alarmsMin?: number[];
  /** Times of day (`HH:MM`) to alert on an ALL-DAY atom's own day.
   *
   *  All-day events start at midnight, so a "15 minutes before" trigger fires at
   *  23:45 the night before — reliably the worst moment to be told about
   *  tomorrow. These triggers are positive offsets from that midnight instead,
   *  so the alert lands during the day the task is actually due. */
  alldayAlarmsAt?: string[];
  /** Injected for tests; DTSTAMP is required and must be a real instant. */
  now?: Date;
}

/** An iCalendar duration for a whole number of minutes from DTSTART. Negative
 *  is before, positive after; RFC 5545 wants a zero offset spelled `PT0S`. */
function trigger(minutes: number): string {
  if (minutes === 0) return "PT0S";
  const sign = minutes < 0 ? "-" : "";
  const m = Math.abs(minutes);
  const h = Math.floor(m / 60);
  return `${sign}PT${h ? `${h}H` : ""}${m % 60 ? `${m % 60}M` : ""}`;
}

const alarm = (text: string, offsetMin: number): string[] => [
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  `DESCRIPTION:${esc(text)}`,
  `TRIGGER:${trigger(offsetMin)}`,
  "END:VALARM",
];

/** `HH:MM` → minutes past midnight, or null if it isn't a time. */
export function minutesIntoDay(hhmm: string): number | null {
  const m = hhmm.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m || Number(m[1]) > 23) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Resolve the feed's options from the environment.
 *
 *  This is the ONLY place these variables are read, so the feed and the
 *  `/health` diagnostic can never disagree about what is configured — a status
 *  report derived separately from the behaviour it describes is worse than no
 *  report at all.
 *
 *  Both alarm knobs take a comma-separated list, so one task can nag more than
 *  once. Setting only the timed one still gives all-day atoms an alert, defaulted
 *  to 09:00: the alternative (inheriting a minutes-BEFORE offset) fires the night
 *  before, which is nobody's intent. Unparseable entries are dropped here rather
 *  than at emit time, so `/health` reports exactly what the feed will do. */
export function icsOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): IcsOptions {
  const list = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const alarmsMin = list(env.TODO_ICS_ALARM_MIN).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  const allday = list(env.TODO_ICS_ALLDAY_ALARM_AT).filter((t) => minutesIntoDay(t) !== null);
  return {
    baseUrl: env.PUBLIC_BASE_URL || undefined,
    alarmsMin,
    alldayAlarmsAt: allday.length ? allday : alarmsMin.length ? ["09:00"] : [],
  };
}

function event(t: Task, date: string, o: IcsOptions): string[] {
  const span = timeSpan(t);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid(t)}`,
    `DTSTAMP:${stamp(o.now ?? new Date())}`,
    // All-day events use exclusive DTEND, so a one-day event ends the NEXT day.
    ...(span
      ? [`DTSTART:${dateTime(date, span.start)}`, `DTEND:${dateTime(date, span.end)}`]
      : [`DTSTART;VALUE=DATE:${dateOnly(date)}`, `DTEND;VALUE=DATE:${dateOnly(addDays(date, 1))}`]),
    `SUMMARY:${esc(t.text || "task")}`,
  ];
  const rule = t.recurrence ? rrule(t.recurrence) : null;
  if (rule) lines.push(`RRULE:${rule}`);
  // The scope a task is filed in is genuinely a category.
  lines.push(`CATEGORIES:${esc(t.note)}`);
  if (t.priority) {
    // RFC 5545 priority: 1 highest, 9 lowest, 0 undefined.
    const p = { highest: 1, high: 2, medium: 5, low: 7, lowest: 9 }[t.priority];
    lines.push(`PRIORITY:${p}`);
  }
  if (o.baseUrl) lines.push(`URL:${esc(`${o.baseUrl.replace(/\/$/, "")}/vault/${encodeURIComponent(t.note)}`)}`);
  // A timed atom alerts BEFORE it starts; an all-day one alerts DURING its day,
  // because "before midnight" means the night before (see IcsOptions).
  const text = t.text || "task";
  if (span) for (const m of o.alarmsMin ?? []) lines.push(...alarm(text, -Math.abs(Math.round(m))));
  else for (const at of o.alldayAlarmsAt ?? []) {
    const mins = minutesIntoDay(at);
    if (mins !== null) lines.push(...alarm(text, mins));
  }
  lines.push("END:VEVENT");
  return lines;
}

/** The whole feed. Open, dated atoms only: a completed task isn't an obligation,
 *  and an undated one has no day to sit on — it lives in `/todo`'s "No date"
 *  bucket, which is the right place to notice it. */
export function buildICS(tasks: Task[], o: IcsOptions = {}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//braindance//todo//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:braindance",
    "X-WR-CALDESC:Open #task atoms from the vault",
  ];
  for (const t of tasks) {
    if (t.status !== "open") continue;
    const date = effectiveDate(t);
    if (!date) continue;
    lines.push(...event(t, date, o));
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
