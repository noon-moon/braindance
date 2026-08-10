// Declarative capture funnels. Each is one spec: the server renders its form and
// build()s a vault-correct note (frontmatter + scoping links). Everything lands on
// the `inbox` branch for desk triage — the phone never writes `main`.
// See [[Braindance Admin App]] "Workflow 1 — Note ingest".
import { ANY_SIGNIFIER } from "./tasks.js";

export interface Field {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "scope" | "date" | "url" | "number";
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

export interface BuiltNote {
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface Funnel {
  id: string;
  label: string;
  hint: string;
  fields: Field[];
  build(input: Record<string, string>): BuiltNote;
}

const yaml = (fm: Record<string, unknown>): string => {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === "" || v === null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
};

/** A checklist item — any indent, `-`/`*`/`+` bullet, a status box. */
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[.?\]/;

/** Append a `#task` atom to an existing note's raw text — how the desk FILES a
 *  task, since a task belongs to the scope whose note it physically lives in.
 *  Lands at the end of a `## Tasks` section when the note has one, else at the
 *  end of the note. Operates on raw file text (frontmatter included) so nothing
 *  round-trips through a YAML re-serialiser. */
export function appendTaskLine(raw: string, line: string): string {
  const lines = raw.replace(/\s+$/, "").split("\n");
  const heading = lines.findIndex((l) => /^#{1,6}\s+tasks\s*$/i.test(l));
  if (heading === -1) {
    // Join an existing trailing list rather than starting a second one — a blank
    // line between two atoms makes them separate (loose) Markdown lists.
    const gap = CHECKLIST_ITEM.test(lines[lines.length - 1] ?? "") ? "" : "\n";
    return `${lines.join("\n")}\n${gap}${line}\n`;
  }
  // End of that section = the next heading of any level, blank lines trimmed
  // back so the atom joins the list rather than floating below it.
  let end = lines.findIndex((l, i) => i > heading && /^#{1,6}\s/.test(l));
  if (end === -1) end = lines.length;
  while (end > heading + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, line);
  return `${lines.join("\n")}\n`;
}

export const compose = (n: BuiltNote): string =>
  `${yaml(n.frontmatter)}\n\n${n.body.trim()}\n`;

/** The vault's scope-link convention: a `Tags: [[MOC]]` line as the FIRST body
 *  line, above the `# title`, so the note joins its hub's backlinks. Empty when
 *  no scope was picked. Parsed back out by `inbox.ts` for triage pre-fill. */
export const scopeLink = (scope?: string): string =>
  scope?.trim() ? `Tags: [[${scope.trim()}]]\n` : "";

/** Obsidian Tasks' five priority levels → their signifiers. No entry = normal. */
export const PRIORITY_SIGNIFIER: Record<string, string> = {
  highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬",
};

/** Obsidian Tasks' signifier alphabet, removed from a description on its way
 *  into an atom.
 *
 *  The description is free text and it is interpolated AHEAD of the structured
 *  fields, so anything the format treats as a signifier is a field the text can
 *  forge. `chase the landlord 🔁 every day 📅 2020-01-01` files a recurring,
 *  permanently-overdue atom into whichever scope note triage appends to — and
 *  `canComplete` (tasks.ts) then refuses to tick it from the app at all, because
 *  a recurrence we can't roll forward belongs to Obsidian. The due/priority
 *  controls are the only legitimate way those fields get set, which now includes
 *  "the only way", not just "the intended way". Reachable from a suggested title
 *  as much as a typed one, so it is fixed here rather than at either caller.
 *
 *  The emoji goes and the words either side stay: a stripped date reads as the
 *  prose it always was, where dropping the clause with it would look like the
 *  desk had eaten what you typed. A trailing VS16 goes too — on its own it is a
 *  signifier's leftovers and nothing a description ever means. */
const SIGNIFIER_RE = new RegExp(`[${ANY_SIGNIFIER}]\\uFE0F?`, "gu");

/** Render one `#task` atom — the vault's task unit is this LINE, so it is built
 *  once here and reused by capture (which wraps it in an inbox note) and triage
 *  (which appends it to a scope note). Field order follows Obsidian Tasks:
 *  description → priority → dates → the `#task` global filter last.
 *
 *  The description is flattened to a single line, stripped of a `#task` the user
 *  typed themselves (two on one line is a malformed atom), and stripped of every
 *  signifier (above) so it can only ever be a description. */
export function taskLine(i: Record<string, string>): string {
  const text = (i.title ?? "")
    .replace(/(?:^|\s)#task(?![\w/-])/gu, " ")
    .replace(SIGNIFIER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = [text, PRIORITY_SIGNIFIER[i.priority ?? ""] ?? "", i.due ? `📅 ${i.due}` : "", "#task"];
  return `- [ ] ${parts.filter(Boolean).join(" ")}`;
}

const MEDIA_SCOPE: Record<string, string> = {
  Game: "Video Games",
  Book: "Books",
  Music: "Music",
  Film: "Film",
};

export const FUNNELS: Funnel[] = [
  {
    id: "memo",
    label: "Memo",
    hint: "a thought → inbox, optionally linked to a scope",
    fields: [
      { key: "title", label: "title", type: "text" },
      { key: "body", label: "body", type: "textarea", required: true },
      { key: "scope", label: "scope", type: "scope" },
    ],
    // The capture screen posts a body and nothing else — naming a thought is a
    // decision the desk makes, not the thumb. So an untitled memo gets NO heading
    // at all: a `# memo` placeholder is noise in the note and a lie in the review
    // list, which labels an untitled capture by its first line instead. The title
    // stays exactly what was typed ("" is a real answer), because the capture
    // filename and the toast both read it back.
    // `title` survives in the spec so the iOS Share Sheet Shortcut, which posts
    // {funnel, title, body} to /ingest, keeps landing titled notes.
    build: (i) => ({
      title: i.title,
      frontmatter: { tags: ["memo"] },
      body: `${scopeLink(i.scope)}${i.title ? `# ${i.title}\n` : ""}\n${i.body}`,
    }),
  },
  {
    id: "task",
    label: "Task",
    hint: "a dated atom — one next action",
    fields: [
      { key: "title", label: "what needs doing", type: "text", required: true },
      { key: "body", label: "detail", type: "textarea" },
      { key: "due", label: "due", type: "date" },
      { key: "priority", label: "priority", type: "select", options: Object.keys(PRIORITY_SIGNIFIER) },
      { key: "scope", label: "scope", type: "scope" },
    ],
    // A task is a LINE, not a note (see [[Tags]]) — so this builds the smallest
    // note that CARRIES one. Captured, it lands in `inbox/` and `/todo` shows it
    // as an unfiled atom straight away; triage then lifts the line out and
    // appends it to its scope note, which is what "filed" means.
    //
    // `detail` is prose the atom can't hold (a task is one line). It rides along
    // in the capture note so nothing typed is dropped, and triage decides where
    // it goes — the line to the scope, the prose to a memo of its own.
    build: (i) => ({
      title: i.title,
      frontmatter: { tags: ["memo"] },
      body: `${scopeLink(i.scope)}# ${i.title}\n\n${taskLine(i)}${i.body ? `\n\n${i.body}` : ""}`,
    }),
  },
  {
    id: "media",
    label: "Media",
    hint: "a game / book / album / film to check out",
    fields: [
      { key: "kind", label: "kind", type: "select", required: true, options: ["Game", "Book", "Music", "Film"] },
      { key: "title", label: "title", type: "text", required: true },
      { key: "creator", label: "creator", type: "text", placeholder: "author / director / artist / studio" },
      { key: "url", label: "url", type: "url" },
      { key: "why", label: "why", type: "textarea" },
      { key: "status", label: "status", type: "select", options: ["want", "consuming", "done"] },
    ],
    build: (i) => ({
      title: i.title,
      frontmatter: { tags: ["memo"], kind: i.kind, status: i.status || "want", url: i.url || undefined },
      body:
        `${scopeLink(MEDIA_SCOPE[i.kind] ?? "Media")}# ${i.title}\n\n` +
        `${i.creator ? `*${i.creator}*\n\n` : ""}${i.why || ""}`,
    }),
  },
  {
    id: "resource",
    label: "Resource",
    hint: "a standing go-to for an activity",
    fields: [
      { key: "title", label: "title", type: "text", required: true },
      { key: "activity", label: "activity", type: "scope", required: true },
      { key: "url", label: "url", type: "url" },
      { key: "note", label: "what it's for", type: "textarea" },
    ],
    build: (i) => ({
      title: i.title,
      frontmatter: { tags: ["memo", "reference"], url: i.url || undefined },
      body: `${scopeLink(i.activity)}# ${i.title}\n\n${i.note || ""}`,
    }),
  },
];

/** Retired funnel ids, kept resolvable so an existing caller (an iOS Shortcut
 *  posting `funnel: "todo"` to /ingest) doesn't start 400ing on a rename. */
const ALIASES: Record<string, string> = { todo: "task" };

export const funnelById = (id: string): Funnel | undefined =>
  FUNNELS.find((f) => f.id === (ALIASES[id] ?? id));
