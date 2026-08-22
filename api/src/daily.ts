// Daily notes — the vault's day-stamped journal, and what the Today tab edits.
//
// The convention is NOT this app's to invent. Obsidian's core Daily Notes plugin
// already owns it, and its settings live IN THE VAULT at
// `.obsidian/daily-notes.json` — the folder, the filename format, the template.
// So that file is the source of truth here too: read it, and the app names,
// files and templates a daily note exactly as Obsidian would.
//
// That is the whole design. A daily note has two writers (Obsidian at the desk,
// this app on a phone) and they must land on the SAME FILE or the day is split
// in two — a "today" that disagrees with the one you opened in Obsidian is worse
// than no Today tab at all. Hard-coding `daily/YYYY-MM-DD` would have made that
// agreement a coincidence that holds until someone changes a setting; reading the
// plugin's own config makes it structural, and makes the feature generic: any
// instance's configuration just works, including the vault that keeps its daily
// notes at the root, or names them `Daily-2026-08-22`.
//
// The format is a moment.js pattern, of which this understands the date/time
// subset a daily note can actually use (see `TOKEN`) plus `[literal]` escapes.
// An unsupported token is left verbatim and warned about ONCE, because a silent
// disagreement here shows up as a duplicate note nobody notices for a week.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_PATH, VAULT_SUBDIR } from "./config.js";

// Same resolution as vault.ts / inbox.ts: <REPO_PATH>/<VAULT_SUBDIR>, with
// VAULT_PATH overriding for standalone setups.
const VAULT_DIR = process.env.VAULT_PATH ?? join(REPO_PATH, VAULT_SUBDIR);
const CONFIG_REL = ".obsidian/daily-notes.json";
const TTL_MS = 3000;

export interface DailyConfig {
  /** Vault-relative folder the notes live in. "" means the vault root — which is
   *  the plugin's own default, so an unconfigured vault behaves like Obsidian. */
  folder: string;
  /** moment.js filename pattern, e.g. `[Daily-]YYYY-MM-DD`. */
  format: string;
  /** Vault-relative template path WITHOUT `.md`, or "" for none. */
  template: string;
}

/** Obsidian's own defaults, so a vault with no `.obsidian/daily-notes.json`
 *  still resolves to the same file the plugin would create on first use. */
const DEFAULTS: DailyConfig = { folder: "", format: "YYYY-MM-DD", template: "" };

/** A vault-relative path off untrusted JSON, or null if it could escape the
 *  vault. `""` (the root) is a legitimate answer and is NOT null. */
function safeRel(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
  if (!s) return "";
  if (s.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return s;
}

let cache: { at: number; cfg: DailyConfig } | null = null;

/** The plugin's settings, or Obsidian's defaults for anything missing or unsafe.
 *  Cached on the same short TTL the vault index uses, so editing the setting in
 *  Obsidian takes effect without a restart. */
export function dailyConfig(): DailyConfig {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.cfg;

  let cfg = DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(join(VAULT_DIR, CONFIG_REL), "utf8")) as Record<string, unknown>;
    const folder = safeRel(raw.folder);
    const template = safeRel(raw.template);
    cfg = {
      folder: folder ?? DEFAULTS.folder,
      format: typeof raw.format === "string" && raw.format.trim() ? raw.format : DEFAULTS.format,
      template: template ?? DEFAULTS.template,
    };
  } catch {
    /* absent or unreadable — the plugin's defaults are the right answer */
  }
  warnUnsupported(cfg.format);
  cache = { at: now, cfg };
  return cfg;
}

/** Drop the cached settings (tests; and anything that rewrites the config). */
export const invalidateDaily = (): void => { cache = null; };

// ── moment.js formatting, the subset a daily note needs ──────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** LONGEST TOKEN FIRST — `D` would otherwise eat the first half of `DD`. The
 *  `[…]` branch leads so an escaped literal is never scanned for tokens. */
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DDD|DD|Do|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a/g;

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

const ordinal = (n: number): string => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** Day of year, 1-based. */
const dayOfYear = (d: Date): number =>
  Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);

/** Format a `YYYY-MM-DD` day (and an optional wall clock) through a moment
 *  pattern. Everything is read in UTC off a midnight Date built from the ISO
 *  string, so no local timezone can shift the day out from under its own name —
 *  which day "today" is has already been decided by `todayISO()`. */
export function formatDay(iso: string, fmt: string, clock?: { h: number; m: number; s: number }): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const h24 = clock?.h ?? 0;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return fmt.replace(TOKEN, (m, literal?: string) => {
    if (literal !== undefined) return literal;
    switch (m) {
      case "YYYY": return String(d.getUTCFullYear());
      case "YY": return pad(d.getUTCFullYear() % 100);
      case "MMMM": return MONTHS[d.getUTCMonth()];
      case "MMM": return MONTHS[d.getUTCMonth()].slice(0, 3);
      case "MM": return pad(d.getUTCMonth() + 1);
      case "M": return String(d.getUTCMonth() + 1);
      case "DDDD": return pad(dayOfYear(d), 3);
      case "DDD": return String(dayOfYear(d));
      case "DD": return pad(d.getUTCDate());
      case "Do": return ordinal(d.getUTCDate());
      case "D": return String(d.getUTCDate());
      case "dddd": return WEEKDAYS[d.getUTCDay()];
      case "ddd": return WEEKDAYS[d.getUTCDay()].slice(0, 3);
      case "dd": return WEEKDAYS[d.getUTCDay()].slice(0, 2);
      case "d": return String(d.getUTCDay());
      case "HH": return pad(h24);
      case "H": return String(h24);
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "mm": return pad(clock?.m ?? 0);
      case "m": return String(clock?.m ?? 0);
      case "ss": return pad(clock?.s ?? 0);
      case "s": return String(clock?.s ?? 0);
      case "A": return h24 < 12 ? "AM" : "PM";
      case "a": return h24 < 12 ? "am" : "pm";
      default: return m;
    }
  });
}

const warned = new Set<string>();

/** A format carrying a token this module doesn't implement will name a file
 *  Obsidian wouldn't — a SECOND note for the same day, discovered a week later.
 *  Cheap to detect (strip the literals, strip every token we do handle, see if
 *  letters are left) and worth exactly one line of log per distinct format. */
function warnUnsupported(fmt: string): void {
  const rest = fmt.replace(/\[[^\]]*\]/g, "").replace(TOKEN, "");
  if (!/[A-Za-z]/.test(rest) || warned.has(fmt)) return;
  warned.add(fmt);
  console.warn(
    `daily: unsupported token(s) ${JSON.stringify(rest.replace(/[^A-Za-z]/g, ""))} in daily-note format ` +
    `${JSON.stringify(fmt)} — the Today tab may not name notes the way Obsidian does`,
  );
}

// ── Locating and reading a day's note ────────────────────────────────────────

/** The note's NAME for a given day — its identity, and its `# heading`. */
export const dailyName = (iso: string): string => formatDay(iso, dailyConfig().format);

/** Vault-relative path of a day's note, e.g. `daily/Daily-2026-08-22.md`. */
export const dailyRel = (iso: string): string =>
  [dailyConfig().folder, `${dailyName(iso)}.md`].filter(Boolean).join("/");

export interface DailyNote {
  iso: string;
  name: string;
  /** Vault-relative path — the path a changeset writes (under VAULT_SUBDIR). */
  rel: string;
  /** The file's raw bytes, or null when it hasn't been created yet. Raw, not
   *  parsed: an edit round-trips this text, so it must not go through a YAML
   *  re-serialiser that would reformat frontmatter the user wrote by hand. */
  text: string | null;
}

export function readDaily(iso: string): DailyNote {
  const rel = dailyRel(iso);
  let text: string | null = null;
  try {
    text = readFileSync(join(VAULT_DIR, rel), "utf8");
  } catch {
    /* not created yet — the ordinary case before the first edit of the day */
  }
  return { iso, name: dailyName(iso), rel, text };
}

/** A daily note by NAME, for the deep links that arrive with one: `/todo` rows
 *  (a daily atom's note), a `[[Daily-2026-08-22]]` wikilink, a `/history` path.
 *  Only resolves inside the configured folder, and only a bare filename. */
export function readDailyByName(name: string): DailyNote | null {
  if (!name || !/^[^/\\]+$/.test(name) || name === "." || name === "..") return null;
  const cfg = dailyConfig();
  const rel = [cfg.folder, `${name}.md`].filter(Boolean).join("/");
  let text: string;
  try {
    text = readFileSync(join(VAULT_DIR, rel), "utf8");
  } catch {
    return null;
  }
  return { iso: dailyDateOf(name) ?? "", name, rel, text };
}

/** The day a daily-note name stands for, or null.
 *
 *  Formats are a one-way function in general, so this doesn't try to invert one:
 *  it finds an ISO date INSIDE the name and confirms the guess by formatting it
 *  back. That covers every format built around `YYYY-MM-DD` (the plugin default,
 *  and every prefixed variant of it) and answers null rather than a wrong date
 *  for anything else — which costs a deep link its "edit today" affordance and
 *  nothing more. */
export function dailyDateOf(name: string): string | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return dailyName(iso) === name ? iso : null;
}

/** A note's prose — the raw text with a leading YAML frontmatter block removed.
 *
 *  Deliberately a text operation and not a `gray-matter` parse: this is only ever
 *  used to RENDER a daily note, and the editing surface round-trips the raw
 *  bytes, so nothing here should be able to reformat a note by understanding it.
 *  A file that opens with something that isn't frontmatter is simply its own
 *  body. */
export const stripFrontmatter = (raw: string): string =>
  /^---\r?\n/.test(raw) ? raw.replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\n]*\r?\n?/, "") : raw;

// ── The template ─────────────────────────────────────────────────────────────

/** Obsidian's core Templates variables, as Daily Notes fills them: `{{title}}`,
 *  `{{date}}`, `{{time}}`, and the `{{date:FMT}}` / `{{time:FMT}}` forms. */
function fillTemplate(raw: string, iso: string, name: string, clock: { h: number; m: number; s: number }): string {
  return raw.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, (_m, kind: string, fmt?: string) => {
    const k = kind.toLowerCase();
    if (k === "title") return name;
    const f = fmt?.trim() || (k === "date" ? "YYYY-MM-DD" : "HH:mm");
    return formatDay(iso, f, clock);
  });
}

/** The starting text for a day that has no note yet — the configured template
 *  with its variables filled, or the smallest real note if there isn't one.
 *
 *  The fallback deliberately carries NO frontmatter. A daily note's tags are the
 *  vault's own vocabulary (`_meta/Tags.md`), which this app does not get to
 *  invent; the template is where an instance says what a daily note is, and a
 *  vault without one gets a heading and a blank page rather than a guess. */
export function dailyStarter(iso: string, now: Date = new Date()): string {
  const name = dailyName(iso);
  const clock = { h: now.getHours(), m: now.getMinutes(), s: now.getSeconds() };
  const { template } = dailyConfig();
  if (template) {
    try {
      const raw = readFileSync(join(VAULT_DIR, `${template}.md`), "utf8");
      return fillTemplate(raw, iso, name, clock);
    } catch {
      console.warn(`daily: template ${JSON.stringify(template)} is configured but unreadable — starting from a heading`);
    }
  }
  return `# ${name}\n\n`;
}
