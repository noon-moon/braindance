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

export type TaskStatus = "open" | "done" | "cancelled";
/** Obsidian Tasks' five levels, highest first. `null` = normal (no signifier). */
export type Priority = "highest" | "high" | "medium" | "low" | "lowest";

export interface Task {
  /** Display text: the line with its signifiers, dates and `#task` tag stripped. */
  text: string;
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
  const recurrence = rest.match(RECURRENCE_RE)?.[1]?.trim() || null;

  // Display text = the line minus every signifier, its date, and the global filter.
  let text = rest;
  for (const [, emoji] of DATE_SIGNIFIERS) text = text.replace(DATE_RE(emoji), "");
  text = text.replace(RECURRENCE_RE, "");
  for (const [, emoji] of PRIORITY) text = text.split(emoji).join("");
  text = text.replace(/🆔\s*\S+/u, "").replace(/⛔\s*\S+/u, "");
  text = text.replace(GLOBAL_FILTER, " ").replace(/\s+/g, " ").trim();

  return {
    text,
    status: dates.cancelled && status === "open" ? "cancelled" : status,
    due: dates.due ?? null,
    scheduled: dates.scheduled ?? null,
    start: dates.start ?? null,
    completed: dates.completed ?? null,
    recurrence,
    priority,
    note,
    dir,
    unfiled: dir === "inbox" || dir === "daily",
    line,
  };
}

function scanFile(absPath: string, note: string, dir: string): Task[] {
  let rawFile: string;
  try {
    rawFile = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  // Strip frontmatter so its lines never count, and so line numbers are body-relative.
  // A note whose YAML doesn't parse (an unquoted `:` in a `topic:` value is enough)
  // must not take the whole tab down with it — scan its raw text instead, which
  // still finds every task line. Body-relative numbering is the only casualty.
  let content: string;
  try {
    content = matter(rawFile).content;
  } catch {
    content = rawFile;
  }
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
    return rank(a) - rank(b) || a.note.localeCompare(b.note) || a.line - b.line;
  };
  const inSection = (a: Task, b: Task) =>
    rank(a) - rank(b) || a.note.localeCompare(b.note) || a.line - b.line;

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

/** Completed tasks, most recently done first (undated done tasks last). */
export const completedTasks = (tasks: Task[]): Task[] =>
  tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? "") || a.note.localeCompare(b.note));
