// TaskNotes — the vault's task model, read from the plugin that owns it.
//
// A task in this vault is a NOTE: one file, metadata in frontmatter, managed by
// the TaskNotes plugin. It replaced a line-level model (`- [ ] … 📅 … #task`
// living inside its scope note) and the two are not compatible — see the
// superseded note in the vault's `_meta/Tags.md`.
//
// Everything here comes out of `.obsidian/plugins/tasknotes/data.json`, and that
// is the whole point, for the same reason `daily.ts` reads the Daily Notes
// plugin's settings rather than assuming `daily/YYYY-MM-DD`:
//
//   - The statuses and priorities are USER-DEFINED lists. The plugin's docs show
//     "in-progress" and "high" as examples; what an install actually accepts is
//     whatever its settings say, and a note written against the docs would carry
//     a status no view matches.
//   - `fieldMapping` is remappable, and this vault has remapped it: `projects`
//     is stored as `Contained By`, so a task names its scope with the same key
//     every other note in the vault uses. Hard-coding `projects:` here would
//     write a field the vault's own ontology does not know.
//   - `storeTitleInFilename` decides whether a `title:` field exists at all.
//
// Guess any of those and the note looks right and is invisible to every query.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_PATH, VAULT_SUBDIR } from "./config.js";

const VAULT = process.env.VAULT_PATH ?? join(REPO_PATH, VAULT_SUBDIR);
const CONFIG_REL = ".obsidian/plugins/tasknotes/data.json";
const TTL_MS = 3000;

export interface TaskNotesConfig {
  /** Vault-relative folder task notes live in. */
  folder: string;
  /** The tag that MAKES a note a task (`taskIdentificationMethod: "tag"`). */
  tag: string;
  status: string;
  priority: string;
  /** Frontmatter key for the scope link — `projects`, remapped. */
  scopeKey: string;
  dueKey: string;
  scheduledKey: string;
  createdKey: string;
  /** False ⇒ the note carries a `title:` field; true ⇒ the filename is it. */
  titleInFilename: boolean;
}

/** The plugin's own defaults, for a vault that has not configured it. */
const DEFAULTS: TaskNotesConfig = {
  folder: "TaskNotes/Tasks",
  tag: "task",
  status: "open",
  priority: "normal",
  scopeKey: "projects",
  dueKey: "due",
  scheduledKey: "scheduled",
  createdKey: "dateCreated",
  titleInFilename: true,
};

let cache: { at: number; cfg: TaskNotesConfig } | null = null;

export function taskConfig(): TaskNotesConfig {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.cfg;
  let cfg = DEFAULTS;
  try {
    const d = JSON.parse(readFileSync(join(VAULT, CONFIG_REL), "utf8")) as Record<string, unknown>;
    const map = (d.fieldMapping ?? {}) as Record<string, unknown>;
    const s = (v: unknown, fb: string): string => (typeof v === "string" && v.trim() ? v.trim() : fb);
    cfg = {
      folder: s(d.tasksFolder, DEFAULTS.folder).replace(/^\/+|\/+$/g, ""),
      tag: s(d.taskTag, DEFAULTS.tag).replace(/^#/, ""),
      status: s(d.defaultTaskStatus, DEFAULTS.status),
      priority: s(d.defaultTaskPriority, DEFAULTS.priority),
      scopeKey: s(map.projects, DEFAULTS.scopeKey),
      dueKey: s(map.due, DEFAULTS.dueKey),
      scheduledKey: s(map.scheduled, DEFAULTS.scheduledKey),
      createdKey: s(map.dateCreated, DEFAULTS.createdKey),
      titleInFilename: d.storeTitleInFilename !== false,
    };
  } catch {
    /* not installed, or unreadable — the plugin's defaults are the right answer */
  }
  cache = { at: now, cfg };
  return cfg;
}

export const invalidateTaskConfig = (): void => { cache = null; };

/** Is a status one this install actually defines? A task carrying a status no
 *  view matches is a task that has vanished, so the answer has to come off the
 *  configured list rather than off a constant here. */
export function knownStatuses(): string[] {
  try {
    const d = JSON.parse(readFileSync(join(VAULT, CONFIG_REL), "utf8")) as Record<string, unknown>;
    const list = Array.isArray(d.customStatuses) ? d.customStatuses : [];
    return list.map((x) => String((x as Record<string, unknown>).value ?? "")).filter(Boolean);
  } catch {
    return ["none", "open", "in-progress", "done"];
  }
}

export interface TaskInput {
  title: string;
  scopes: string[];
  due?: string | null;
  priority?: string | null;
  /** Prose the capture carried. A task note has a body, so detail that used to
   *  need a memo of its own now simply rides along under the frontmatter. */
  body?: string;
  createdISO: string;
}

/** Render a task note the way TaskNotes writes one. */
export function renderTask(t: TaskInput, footer?: string): string {
  const c = taskConfig();
  const fm: string[] = ["---", `status: ${c.status}`];
  if (!c.titleInFilename) fm.push(`title: ${JSON.stringify(t.title)}`);
  fm.push(`priority: ${t.priority ?? c.priority}`);
  if (t.due) fm.push(`${c.dueKey}: ${t.due}`);
  if (t.scopes.length) {
    fm.push(`${c.scopeKey}:`);
    for (const s of t.scopes) fm.push(`  - "[[${s}]]"`);
  }
  // Trailing blank line after the fence, matching what TaskNotes itself writes
  // — a note that differs from the plugin's own output invites a diff every
  // time the plugin touches it.
  fm.push(`${c.createdKey}: ${t.createdISO}`, "tags:", `  - ${c.tag}`, "---", "", "");
  const body = [t.body?.trim() ?? "", footer ?? ""].filter(Boolean).join("\n\n");
  return `${fm.join("\n")}${body ? `${body}\n` : ""}`;
}
