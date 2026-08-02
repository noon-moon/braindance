// Task index — every open `#task` atom in the vault, one flat list.
//
// The vault's task model (see [[Tags]]) is LINE-level: a task is a checklist line
// tagged `#task` (Obsidian Tasks' global filter), and it belongs to the scope whose
// note it physically lives in. Filed tasks sit in a root scope note; still-loose
// ones sit in `inbox/` or a daily note. There is no task NOTE and no `status`
// frontmatter — so this module scans note bodies for lines, not notes for tags.
//
// Read-only, like the rest of the viewer: this renders the /todo tab, it does not
// complete anything. Checking a box off is a vault write and stays in Obsidian.
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { REPO_PATH, VAULT_SUBDIR } from "./config.js";

// Same resolution as vault.ts / inbox.ts: <REPO_PATH>/<VAULT_SUBDIR>, VAULT_PATH overrides.
const VAULT_DIR = process.env.VAULT_PATH ?? join(REPO_PATH, VAULT_SUBDIR);
const TTL_MS = 3000;

/** Obsidian Tasks' *global filter* — only lines carrying it are tasks, so ordinary
 *  prose checkboxes stay out of the database. Word-boundary so `#tasks` misses. */
const GLOBAL_FILTER = /(?:^|\s)#task(?![\w/-])/;

/** Time of day for an atom, `HH:MM` in the vault's own timezone (TZ).
 *
 *  The vault's DATE fields stay day-granular, because that's Obsidian Tasks'
 *  emoji format and breaking it would cost us the plugin. A time therefore lives
 *  in the task's DESCRIPTION, where Tasks treats it as ordinary text: `@14:00`,
 *  or `@14:00-14:30` for an explicit end. Marked with `@` rather than a bare
 *  `14:00` because ordinary prose false-positives — `John 3:16` is a valid
 *  HH:MM. It exists for the calendar surfaces; nothing else depends on it. */
export interface TaskTime {
  start: string;
  /** Explicit end, or null when only a start was given. */
  end: string | null;
}

export type TaskStatus = "open" | "done" | "cancelled";
/** Obsidian Tasks' five levels, highest first. `null` = normal (no signifier). */
export type Priority = "highest" | "high" | "medium" | "low" | "lowest";

export interface Task {
  /** Display text: the line with its signifiers, dates and `#task` tag stripped. */
  text: string;
  /** The line verbatim. Completing an atom rewrites this exact string in place,
   *  and matching on it is what stops a stale page from ticking the wrong line. */
  raw: string;
  status: TaskStatus;
  /** `📅` due date, `YYYY-MM-DD`, or null. */
  due: string | null;
  /** `⏳` scheduled date — the bucketing fallback when there's no due date. */
  scheduled: string | null;
  /** `🛫` start date. */
  start: string | null;
  /** `✅` done date (auto-stamped by Obsidian on completion). */
  completed: string | null;
  /** `🔁` recurrence rule, verbatim (e.g. "every day when done"). */
  recurrence: string | null;
  /** `@HH:MM[-HH:MM]` parsed out of the description, or null for an all-day atom. */
  time: TaskTime | null;
  priority: Priority | null;
  /** Note the line lives in — its scope, by containment. Basename, no `.md`. */
  note: string;
  /** Vault-relative dir: "" for a root (filed) note, else "inbox" / "daily". */
  dir: string;
  /** True while the atom is still loose in `inbox/` or a daily note (untriaged). */
  unfiled: boolean;
  /** 1-indexed line number within the note body. */
  line: number;
}

// Every Tasks signifier we recognise. Order matters only for stripping.
const DATE_SIGNIFIERS: Array<[key: "due" | "scheduled" | "start" | "completed" | "cancelled" | "created", emoji: string]> = [
  ["due", "📅"],
  ["scheduled", "⏳"],
  ["start", "🛫"],
  ["completed", "✅"],
  ["cancelled", "❌"],
  ["created", "➕"],
];
const PRIORITY: Array<[Priority, string]> = [
  ["highest", "🔺"],
  ["high", "⏫"],
  ["medium", "🔼"],
  ["low", "🔽"],
  ["lowest", "⏬"],
];
// Any signifier — terminates a free-text field (recurrence) that runs to EOL.
const ANY_SIGNIFIER = "📅⏳🛫✅❌➕🔺⏫🔼🔽⏬🔁🆔⛔";

const DATE_RE = (emoji: string) => new RegExp(`${emoji}\\s*(\\d{4}-\\d{2}-\\d{2})`, "u");
const RECURRENCE_RE = new RegExp(`🔁\\s*([^${ANY_SIGNIFIER}]*)`, "u");
// A checklist line: any indent, -/*/+ bullet, single-char status box.
const CHECKLIST_RE = /^\s*[-*+]\s+\[(.)\]\s*(.*)$/;

const STATUS: Record<string, TaskStatus> = { " ": "open", x: "done", X: "done", "-": "cancelled" };

/** `@14:00` or `@14:00-14:30`, as its own token. Hours are validated below —
 *  the regex can't express 0–23 without becoming unreadable. */
const TIME_RE = /(^|\s)@(\d{1,2}):([0-5]\d)(?:\s*-\s*(\d{1,2}):([0-5]\d))?(?=\s|$)/u;

const hhmm = (h: number, m: number): string => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** Pull `@HH:MM[-HH:MM]` out of a description. Returns null (and leaves the text
 *  alone) for an out-of-range hour, so `@99:00` stays visible as the typo it is
 *  rather than silently vanishing from the line. */
function parseTime(rest: string): TaskTime | null {
  const m = rest.match(TIME_RE);
  if (!m) return null;
  const [, , h1, m1, h2, m2] = m;
  const sh = Number(h1);
  if (sh > 23) return null;
  const start = hhmm(sh, Number(m1));
  if (h2 === undefined) return { start, end: null };
  const eh = Number(h2);
  if (eh > 23) return { start, end: null };
  const end = hhmm(eh, Number(m2));
  // An end at or before the start is not a range we can honour; keep the start.
  return { start, end: end > start ? end : null };
}

/** Parse one line into a Task, or null if it isn't a `#task` checklist line.
 *  Exported for tests — the scan is thin glue over this. */
export function parseTaskLine(raw: string, note: string, dir: string, line: number): Task | null {
  const m = raw.match(CHECKLIST_RE);
  if (!m) return null;
  const [, box, rest] = m;
  if (!GLOBAL_FILTER.test(rest)) return null;

  // Anything not in the map (e.g. Tasks' custom `[/]` in-progress) counts as open —
  // it is not done, so it belongs on the list.
  const status = STATUS[box] ?? "open";

  const dates: Partial<Record<string, string>> = {};
  for (const [key, emoji] of DATE_SIGNIFIERS) {
    dates[key] = rest.match(DATE_RE(emoji))?.[1];
  }
  const priority = PRIORITY.find(([, emoji]) => rest.includes(emoji))?.[0] ?? null;
  // The rule runs to EOL or the next signifier — and `#task` is neither, so when
  // `🔁` is the LAST field the capture swallows the global filter (and anything
  // trailing it). Strip it back off, or the rule reads as "every 2 days #task"
  // and matches nothing.
  const recurrence = rest.match(RECURRENCE_RE)?.[1]?.replace(GLOBAL_FILTER, " ").trim() || null;
  const time = parseTime(rest);

  // Display text = the line minus every signifier, its date, and the global filter.
  let text = rest;
  for (const [, emoji] of DATE_SIGNIFIERS) text = text.replace(DATE_RE(emoji), "");
  text = text.replace(RECURRENCE_RE, "");
  for (const [, emoji] of PRIORITY) text = text.split(emoji).join("");
  text = text.replace(/🆔\s*\S+/u, "").replace(/⛔\s*\S+/u, "");
  if (time) text = text.replace(TIME_RE, "$1");
  text = text.replace(GLOBAL_FILTER, " ").replace(/\s+/g, " ").trim();

  return {
    text,
    raw,
    status: dates.cancelled && status === "open" ? "cancelled" : status,
    due: dates.due ?? null,
    scheduled: dates.scheduled ?? null,
    start: dates.start ?? null,
    completed: dates.completed ?? null,
    recurrence,
    time,
    priority,
    note,
    dir,
    unfiled: dir === "inbox" || dir === "daily",
    line,
  };
}

/** A note's body — frontmatter stripped, so its lines never count as tasks and
 *  line numbers are body-relative. A note whose YAML doesn't parse (an unquoted
 *  `:` in a `topic:` value is enough) must not take the whole tab down with it,
 *  so it falls back to the raw text, which still finds every task line.
 *  Body-relative numbering is the only casualty. */
function bodyOf(rawFile: string): string {
  try {
    return matter(rawFile).content;
  } catch {
    return rawFile;
  }
}

function scanFile(absPath: string, note: string, dir: string): Task[] {
  let rawFile: string;
  try {
    rawFile = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const content = bodyOf(rawFile);
  const out: Task[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = parseTaskLine(lines[i], note, dir, i + 1);
    if (t) out.push(t);
  }
  return out;
}

let cache: { at: number; tasks: Task[] } | null = null;

/** Every task line in the vault: root notes (filed) plus one level of subdirs,
 *  which is where `inbox/` and `daily/` atoms live. Underscore/dot dirs are
 *  skipped — `_meta`, `_templates` and `_ephemeral` hold *example* task lines
 *  (docs and scratch), which must never show up as real work. */
export function listTasks(): Task[] {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.tasks;

  const tasks: Task[] = [];
  const readDir = (abs: string, dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) {
        tasks.push(...scanFile(join(abs, e.name), e.name.slice(0, -3), dir));
      } else if (e.isDirectory() && dir === "" && !e.name.startsWith("_") && !e.name.startsWith(".")) {
        readDir(join(abs, e.name), e.name); // depth 1 only — the vault is flat
      }
    }
  };
  readDir(VAULT_DIR, "");

  cache = { at: now, tasks };
  return tasks;
}

/** Drop the cached scan (called after a commit, like vault.invalidate()). */
export const invalidateTasks = (): void => {
  cache = null;
};

// ── Grouping (Apple Reminders' Scheduled list) ───────────────────────────────

export type BucketKind = "overdue" | "today" | "tomorrow" | "future" | "undated";

export interface TaskGroup {
  kind: BucketKind;
  /** Section heading — "Overdue", "Today", "Tomorrow", "Friday, July 31", "No date". */
  label: string;
  /** The bucket's date (`YYYY-MM-DD`), or null for overdue/undated. */
  date: string | null;
  tasks: Task[];
}

/** The effective date a task is bucketed by: its due date, else its scheduled
 *  date. Obsidian Tasks keeps the two distinct; Reminders has one date column,
 *  so a scheduled-only atom lands on its scheduled day rather than in "No date"
 *  (where it would be invisible). Flagged in the UI with a `⏳` chip. */
export const effectiveDate = (t: Task): string | null => t.due ?? t.scheduled ?? null;

const PRIORITY_RANK: Record<Priority, number> = { highest: 0, high: 1, medium: 2, low: 4, lowest: 5 };
const rank = (t: Task): number => (t.priority ? PRIORITY_RANK[t.priority] : 3); // no signifier = normal

/** How long a timed atom lasts when it names only a start. 30 minutes suits a
 *  task list; set `TASK_DEFAULT_DURATION_MIN` in `/srv/.env` to taste. */
const DEFAULT_DURATION_MIN = Math.max(1, Number(process.env.TASK_DEFAULT_DURATION_MIN ?? 30) || 30);

const toMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** A timed atom's span with the default duration applied, or null if all-day.
 *  The end clamps to 23:59 rather than spilling into the next day — an atom
 *  belongs to the day its date names. */
export function timeSpan(t: Task): { start: string; end: string } | null {
  if (!t.time) return null;
  if (t.time.end) return { start: t.time.start, end: t.time.end };
  const end = Math.min(toMinutes(t.time.start) + DEFAULT_DURATION_MIN, 23 * 60 + 59);
  return {
    start: t.time.start,
    end: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
  };
}

/** Within one day, a timed atom comes before an all-day one and they run in
 *  clock order — a day reads as a schedule. Untimed atoms fall back to priority.
 *  Returns 0 when neither is timed, so callers keep their own tie-breaks. */
const byTime = (a: Task, b: Task): number => {
  if (a.time && b.time) return a.time.start.localeCompare(b.time.start);
  return a.time ? -1 : b.time ? 1 : 0;
};

/** Today in the server's timezone as `YYYY-MM-DD`. Set `TZ` in the deploy env
 *  (`/srv/.env`) or the container's UTC day boundary decides what "today" means. */
export function todayISO(now: Date = new Date()): string {
  const tz = process.env.TZ;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz && tz.length ? tz : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Shift a `YYYY-MM-DD` by whole days. UTC arithmetic — no DST edge cases. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/** "Friday, July 31" — and with the year once the date leaves the current one. */
function dateLabel(iso: string, today: string): string {
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** Group open tasks into Reminders-style date sections, ascending: Overdue →
 *  Today → Tomorrow → one section per later date → No date. Empty sections are
 *  omitted; within a section, higher priority first, then note, then line. */
export function groupByDue(tasks: Task[], today: string = todayISO()): TaskGroup[] {
  const open = tasks.filter((t) => t.status === "open");
  const tomorrow = addDays(today, 1);

  const overdue: Task[] = [];
  const undated: Task[] = [];
  const byDate = new Map<string, Task[]>();
  for (const t of open) {
    const d = effectiveDate(t);
    if (!d) undated.push(t);
    else if (d < today) overdue.push(t);
    else (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(t);
  }

  const bySort = (a: Task, b: Task) => {
    const d = (effectiveDate(a) ?? "") .localeCompare(effectiveDate(b) ?? "");
    if (d) return d;
    return byTime(a, b) || rank(a) - rank(b) || a.note.localeCompare(b.note) || a.line - b.line;
  };
  const inSection = (a: Task, b: Task) =>
    byTime(a, b) || rank(a) - rank(b) || a.note.localeCompare(b.note) || a.line - b.line;

  const groups: TaskGroup[] = [];
  if (overdue.length) {
    groups.push({ kind: "overdue", label: "Overdue", date: null, tasks: overdue.sort(bySort) });
  }
  for (const date of [...byDate.keys()].sort()) {
    const kind: BucketKind = date === today ? "today" : date === tomorrow ? "tomorrow" : "future";
    const label = kind === "today" ? "Today" : kind === "tomorrow" ? "Tomorrow" : dateLabel(date, today);
    groups.push({ kind, label, date, tasks: byDate.get(date)!.sort(inSection) });
  }
  if (undated.length) {
    groups.push({ kind: "undated", label: "No date", date: null, tasks: undated.sort(inSection) });
  }
  return groups;
}

// ── Completing an atom ───────────────────────────────────────────────────────
//
// Ticking a box is a vault WRITE, so it goes through the git store like every
// other change and shows up in /history with one-click revert (which is also the
// undo for a mis-tap — there is deliberately no un-complete button).

// Recurrence rules we roll forward ourselves. Obsidian Tasks is rrule-backed and
// its grammar is larger still (`every 3rd Thursday`, …); we parse the shapes real
// obligations actually take and REFUSE the rest rather than guess, because a
// silently wrong schedule is worse than one the plugin has to handle.
//
//   every [N] day|week|month|year [when done]
//   every [N] week[s] on <weekday>[, <weekday> …]     ── also `every Sunday`
//   every weekday                                     ── Mon–Fri
//   every [N] month[s] on the <1st…31st|last> [day]
//
// Projection (occurrencesBetween) is what makes a calendar possible: the vault
// holds only the CURRENT instance of a recurring atom, so a weekly chore exists
// exactly once on disk and would otherwise appear on a calendar exactly once.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7 };

const WEEKDAY: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

type Recur =
  | { kind: "interval"; step: number; unit: "day" | "week" | "month" | "year"; whenDone: boolean }
  | { kind: "weekday"; days: number[]; step: number; whenDone: boolean }
  /** `day` is 1–31, or 0 meaning "last day of the month". */
  | { kind: "monthday"; day: number; step: number; whenDone: boolean };

const INTERVAL_RE = /^every\s+(?:(\d+)\s+)?(day|week|month|year)s?$/i;
const WEEK_ON_RE = /^every\s+(?:(\d+)\s+)?weeks?\s+on\s+(.+)$/i;
const BARE_WEEKDAY_RE = /^every\s+(.+)$/i;
const MONTH_ON_RE = /^every\s+(?:(\d+)\s+)?months?\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+day)?$/i;
const MONTH_LAST_RE = /^every\s+(?:(\d+)\s+)?months?\s+on\s+the\s+last(?:\s+day)?$/i;

/** Split `monday, wednesday and friday` into weekday numbers, or null if any
 *  token isn't a weekday — so a rule we half-understand is refused whole. */
function parseWeekdays(list: string): number[] | null {
  const parts = list.split(/\s*(?:,|and|&)\s*/i).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  const days: number[] = [];
  for (const p of parts) {
    const d = WEEKDAY[p];
    if (d === undefined) return null;
    if (!days.includes(d)) days.push(d);
  }
  return days.sort((a, b) => a - b);
}

/** Parse a `🔁` rule, or null when it isn't one we handle. */
export function parseRecurrence(rule: string): Recur | null {
  let s = rule.trim().replace(/\s+/g, " ");
  const whenDone = /\s+when\s+done$/i.test(s);
  if (whenDone) s = s.replace(/\s+when\s+done$/i, "");

  const step = (n?: string) => {
    const v = Number(n ?? 1);
    return Number.isFinite(v) && v >= 1 ? v : null;
  };

  let m = s.match(MONTH_LAST_RE);
  if (m) {
    const k = step(m[1]);
    return k === null ? null : { kind: "monthday", day: 0, step: k, whenDone };
  }
  m = s.match(MONTH_ON_RE);
  if (m) {
    const k = step(m[1]);
    const day = Number(m[2]);
    return k === null || day < 1 || day > 31 ? null : { kind: "monthday", day, step: k, whenDone };
  }
  m = s.match(WEEK_ON_RE);
  if (m) {
    const k = step(m[1]);
    const days = parseWeekdays(m[2]);
    return k === null || !days ? null : { kind: "weekday", days, step: k, whenDone };
  }
  m = s.match(INTERVAL_RE);
  if (m) {
    const k = step(m[1]);
    return k === null ? null : { kind: "interval", step: k, unit: m[2].toLowerCase() as "day", whenDone };
  }
  // `every weekday` (Mon–Fri) and the bare `every Sunday` / `every mon and fri`.
  m = s.match(BARE_WEEKDAY_RE);
  if (m) {
    if (/^weekdays?$/i.test(m[1].trim())) return { kind: "weekday", days: [1, 2, 3, 4, 5], step: 1, whenDone };
    const days = parseWeekdays(m[1]);
    if (days) return { kind: "weekday", days, step: 1, whenDone };
  }
  return null;
}

/** Whether a `🔁` rule is one we roll forward. Drives both the write and the
 *  UI — an atom we'd refuse gets no button rather than a button that fails. */
export const recurrenceSupported = (rule: string): boolean => parseRecurrence(rule) !== null;

/** Shift a `YYYY-MM-DD` by whole months, clamping a day-of-month the target
 *  month doesn't have (Jan 31 + 1 month → Feb 28) rather than rolling over. */
function addMonths(iso: string, months: number, dayOfMonth?: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const want = dayOfMonth ?? d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(want === 0 ? last : Math.min(want, last));
  return d.toISOString().slice(0, 10);
}

const dayOfWeek = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** The first occurrence strictly AFTER `from`. Pure date arithmetic — `from` is
 *  the previous occurrence (or, for `when done`, the completion date). */
function advance(r: Recur, from: string): string {
  if (r.kind === "interval") {
    if (r.unit === "day" || r.unit === "week") return addDays(from, r.step * UNIT_DAYS[r.unit]);
    return addMonths(from, r.unit === "month" ? r.step : r.step * 12);
  }
  if (r.kind === "weekday") {
    // Every matching weekday within a week, then a step-week gap. With step 1
    // that's simply "the next matching weekday"; with step N the gap is measured
    // from the previous occurrence, which is what `from` is.
    let d = r.step > 1 ? addDays(from, (r.step - 1) * 7) : from;
    for (let i = 0; i < 7; i++) {
      d = addDays(d, 1);
      if (r.days.includes(dayOfWeek(d))) return d;
    }
    return d;
  }
  // monthday: the target day in this month if it's still ahead, else step months on.
  const same = addMonths(from, 0, r.day);
  return same > from ? same : addMonths(from, r.step, r.day);
}

/** The next occurrence of `rule` after `base` (`YYYY-MM-DD`), or null when the
 *  rule isn't one we handle. `when done` means the interval runs from the
 *  completion date rather than from the date the atom carried — as does a base
 *  that isn't a real date, which is the undated-recurring case. */
export function nextRecurrence(rule: string, base: string, today: string): string | null {
  const r = parseRecurrence(rule);
  if (!r) return null;
  return advance(r, r.whenDone || !ISO_DATE.test(base) ? today : base);
}

/** Can this atom be completed from the web at all? A recurring atom whose rule
 *  we can't roll forward is left to Obsidian — completing it here would drop the
 *  recurrence on the floor, which is worse than not offering the button. */
export const canComplete = (t: Task): boolean =>
  t.status === "open" && (!t.recurrence || recurrenceSupported(t.recurrence));

// ── Projection ───────────────────────────────────────────────────────────────

export interface Occurrence {
  task: Task;
  /** `YYYY-MM-DD` this occurrence falls on. */
  date: string;
  /** False for the instance that actually exists in the vault; true for every
   *  one we computed. Only the real one can be ticked — completing a projection
   *  would write a line that isn't there. */
  projected: boolean;
}

/** Every occurrence of `t` landing in `[from, to]`, real instance included.
 *
 *  The vault holds only the current instance of a recurring atom (Obsidian Tasks
 *  writes the next one when you complete it), so without this a weekly chore
 *  appears on a calendar exactly once. Non-recurring atoms yield their own date;
 *  a rule we can't parse yields only the real instance, which is the honest
 *  answer — we don't know when it next falls.
 *
 *  `when done` rules are projected on their nominal cadence: the true next date
 *  depends on when you actually finish, but a calendar is asking about the
 *  PATTERN, and "every day when done" genuinely means roughly daily.
 *
 *  `cap` bounds a pathological rule (`every day` over a decade); hitting it
 *  truncates rather than hangs. */
export function occurrencesBetween(t: Task, from: string, to: string, cap = 400): Occurrence[] {
  const start = effectiveDate(t);
  if (!start || t.status !== "open") return [];
  const out: Occurrence[] = [];
  if (start >= from && start <= to) out.push({ task: t, date: start, projected: false });

  const r = t.recurrence ? parseRecurrence(t.recurrence) : null;
  if (!r) return out;

  let d = start;
  for (let i = 0; i < cap && d <= to; i++) {
    d = advance(r, d);
    if (d > to) break;
    if (d >= from) out.push({ task: t, date: d, projected: true });
  }
  return out;
}

/** Every occurrence of every open atom in the window, grouped by date. Undated
 *  atoms are absent by construction — a calendar can't place them. */
export function occurrencesByDate(tasks: Task[], from: string, to: string): Map<string, Occurrence[]> {
  const byDate = new Map<string, Occurrence[]>();
  for (const t of tasks) {
    for (const o of occurrencesBetween(t, from, to)) {
      (byDate.get(o.date) ?? byDate.set(o.date, []).get(o.date)!).push(o);
    }
  }
  for (const list of byDate.values()) {
    list.sort((a, b) =>
      byTime(a.task, b.task) || rank(a.task) - rank(b.task) ||
      a.task.note.localeCompare(b.task.note) || a.task.line - b.task.line);
  }
  return byDate;
}

/** Dates a new recurrence instance carries forward. `➕ created` stays put — it
 *  records when the atom was written, not when it next comes round. */
const SHIFTABLE: Array<[key: "due" | "scheduled" | "start", emoji: string]> = [
  ["due", "📅"], ["scheduled", "⏳"], ["start", "🛫"],
];

export interface Completion {
  /** The line, marked done and stamped `✅ today`. */
  done: string;
  /** The next instance, for a `🔁` atom — inserted ABOVE the completed line, the
   *  way Obsidian Tasks does it. null for a one-shot. */
  next: string | null;
}

/** Rewrite one raw task line as completed. Returns null if the line isn't an
 *  open atom, or carries a recurrence rule we decline to roll forward. */
export function completeLine(raw: string, today: string): Completion | null {
  const t = parseTaskLine(raw, "", "", 0);
  if (!t || t.status !== "open") return null;

  // `- [ ]` → `- [x]`, first box only.
  let done = raw.replace(/^(\s*[-*+]\s+\[)[^\]]?(\])/, "$1x$2");
  // The done date sits just before the trailing `#task`, matching the shape the
  // vault documents in [[Tags]]; a line that tags elsewhere gets it appended.
  const stamp = `✅ ${today}`;
  done = /#task\s*$/u.test(done)
    ? done.replace(/(\s*)#task(\s*)$/u, ` ${stamp} #task`)
    : `${done} ${stamp}`;

  if (!t.recurrence) return { done, next: null };
  const base = effectiveDate(t) ?? today;
  const nextDue = nextRecurrence(t.recurrence, base, today);
  if (!nextDue) return null;

  // Roll every date the atom carries by the same delta, so a start/scheduled
  // date keeps its offset from the due date instead of being left behind.
  const shift = daysBetween(base, nextDue);
  let next = raw;
  for (const [key, emoji] of SHIFTABLE) {
    const cur = t[key];
    if (!cur) continue;
    next = next.replace(DATE_RE(emoji), `${emoji} ${addDays(cur, shift)}`);
  }
  // A recurring atom with no date at all still needs one, or the new instance is
  // indistinguishable from the old and never comes due.
  if (!effectiveDate(t)) next = next.replace(/(\s*)#task(\s*)$/u, ` 📅 ${nextDue} #task`);
  return { done, next };
}

/** The note a task lives in, read straight off the working tree. `dir` is "" for
 *  a filed atom, else the one-level subdir the scan allows (`inbox`, `daily`).
 *  Rejects anything that could escape the vault — these come off a form. */
export function readTaskFile(dir: string, note: string): { rel: string; text: string } | null {
  if (!note || !/^[^/\\]+$/.test(note) || note === "." || note === "..") return null;
  if (dir && !/^[\w-]+$/.test(dir)) return null;
  const rel = [dir, `${note}.md`].filter(Boolean).join("/");
  try {
    return { rel, text: readFileSync(join(VAULT_DIR, rel), "utf8") };
  } catch {
    return null;
  }
}

/** Apply a completion to a note's full text, locating the atom by its BODY line
 *  number and verifying the line still reads exactly as the page rendered it.
 *  Returns null when it doesn't — the note changed in Obsidian since the page
 *  loaded, and ticking a box must never fall through onto a different atom.
 *  Falls back to a unique full-line match so an edit ABOVE the atom (which
 *  shifts every number below it) doesn't spuriously refuse. */
export function completeInFile(file: string, bodyLine: number, rawLine: string, today: string): string | null {
  const lines = file.split("\n");
  const offset = lines.length - bodyOf(file).split("\n").length;
  const at = offset + bodyLine - 1;
  let idx = lines[at] === rawLine ? at : -1;
  if (idx === -1) {
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] === rawLine) hits.push(i);
    if (hits.length !== 1) return null; // gone, edited, or duplicated — refuse
    idx = hits[0];
  }
  const c = completeLine(lines[idx], today);
  if (!c) return null;
  // A new instance goes ABOVE the completed line, where Obsidian Tasks puts it.
  lines.splice(idx, 1, ...(c.next ? [c.next, c.done] : [c.done]));
  return lines.join("\n");
}

// ── Grouping (the scope lens) ────────────────────────────────────────────────

export interface ScopeGroup {
  /** The note the atoms live in — which IS their scope, by containment. */
  note: string;
  /** True for the single bucket of atoms still loose in `inbox/` or `daily/`. */
  unfiled: boolean;
  /** How many of them are past due — the "this area needs attention" signal. */
  overdue: number;
  tasks: Task[];
}

/** The same open atoms, grouped by the note they live in — the "by area" view
 *  [[TODO]] builds with `group by filename`. It answers a different question
 *  than the date lens ("what's on this area's plate", not "what's due when"),
 *  so scopes are listed ALPHABETICALLY: a stable, scannable order rather than a
 *  second urgency ranking. Urgency shows up inside a section, where atoms sort
 *  by date, and in the per-section overdue count.
 *
 *  Every unfiled atom collapses into ONE leading bucket — it's the task-level
 *  inbox, and one section per timestamped capture file would be noise. */
export function groupByScope(tasks: Task[], today: string = todayISO()): ScopeGroup[] {
  const open = tasks.filter((t) => t.status === "open");
  const byNote = new Map<string, Task[]>();
  const unfiled: Task[] = [];
  for (const t of open) {
    if (t.unfiled) unfiled.push(t);
    else (byNote.get(t.note) ?? byNote.set(t.note, []).get(t.note)!).push(t);
  }

  // Undated atoms sit at the bottom of their section — a section is a plate, and
  // the dated work on it is what's actually next.
  const byDate = (a: Task, b: Task) => {
    const [x, y] = [effectiveDate(a), effectiveDate(b)];
    if (x && y && x !== y) return x.localeCompare(y);
    if (x !== null && y === null) return -1;
    if (x === null && y !== null) return 1;
    return byTime(a, b) || rank(a) - rank(b) || a.note.localeCompare(b.note) || a.line - b.line;
  };
  const countOverdue = (ts: Task[]) => ts.filter((t) => (effectiveDate(t) ?? "") < today && effectiveDate(t)).length;

  const groups: ScopeGroup[] = [];
  if (unfiled.length) {
    groups.push({ note: "Unfiled", unfiled: true, overdue: countOverdue(unfiled), tasks: unfiled.sort(byDate) });
  }
  for (const note of [...byNote.keys()].sort((a, b) => a.localeCompare(b))) {
    const ts = byNote.get(note)!.sort(byDate);
    groups.push({ note, unfiled: false, overdue: countOverdue(ts), tasks: ts });
  }
  return groups;
}

/** Completed tasks, most recently done first (undated done tasks last). */
export const completedTasks = (tasks: Task[]): Task[] =>
  tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? "") || a.note.localeCompare(b.note));
