// Declarative capture funnels. Each is one spec: the server renders its form and
// build()s a vault-correct note (frontmatter + scoping links). Everything lands on
// the `inbox` branch for desk triage — the phone never writes `main`.
// See [[Braindance Admin App]] "Workflow 1 — Note ingest".
import { ANY_SIGNIFIER } from "./tasks.js";

export interface Field {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "scope" | "date" | "url" | "number" | "checkbox";
  required?: boolean;
  options?: string[];
  placeholder?: string;
  /** `scope` fields only: this picker takes exactly ONE scope. A task is filed by
   *  living in a note, and a line appended to three hubs is three tasks — so the
   *  control that picks that note has to be able to say "one", structurally,
   *  rather than leave the filer to quietly take the first of however many. */
  single?: boolean;
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
      // An empty list is the same fact as an absent key, and `Contains:` with
      // nothing under it is a property Obsidian shows on every note that never
      // had one. Containment is optional on both sides, so both sides can be
      // empty and neither should be written.
      if (v.length === 0) continue;
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

/** The scope field is comma-separated free text — that is what the picker posts,
 *  and what it degrades to with JS off. This is the ONE place that turns that
 *  string into scope names, so the form, the writer, the parser and the filer can
 *  never disagree about what `Loon, Music` means.
 *
 *  Each name is stripped of the wikilink alphabet — `[`, `]`, `|`, `#`, and any
 *  newline — because the result is interpolated straight into `[[…]]`. A name
 *  carrying `]]` would close its own link and let the rest of the field become
 *  note body; `|` and `#` would silently retarget the link at an alias or a
 *  heading. This is the field that stopped being a `<select>`, so it is the field
 *  that has to stop trusting its own contents.
 *
 *  ORDER IS MEANING and is kept: the first scope is the one a task files INTO
 *  (see the triage route). Duplicates drop — two links to one hub is one link. */
export function parseScopes(value?: string | string[]): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(",");
  const out: string[] = [];
  for (const p of parts) {
    const s = p.replace(/[[\]|#\r\n]/g, " ").replace(/\s+/g, " ").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Scope names → the YAML link list the vault's containment fields hold:
 *  `"[[Music]]"`, one per item. Double-quoted because a bare `[[…]]` opens a flow
 *  sequence in YAML, which is why every hand-written note in the vault quotes it
 *  too; the quote and backslash inside a name are escaped rather than stripped,
 *  since this is a serialisation boundary and not a sanitising one (`parseScopes`
 *  already removed everything that could break out of the `[[…]]` itself). */
const linkList = (value?: string | string[]): string[] =>
  parseScopes(value).map((s) => `"[[${s.replace(/["\\]/g, "\\$&")}]]"`);

/** The vault's TWO containment relationships, as frontmatter — `Contains` and
 *  `Contained By` (see `_meta/Tags.md`). This replaced the old `Tags: [[MOC]]`
 *  body line, which could only say one of the two and said it in a place nothing
 *  but this app understood: scopes and references already carry containment in
 *  frontmatter, Obsidian resolves links there as ordinary links (so the hub still
 *  gets its backlink), and a dataview can query a field but not a prose line.
 *
 *  Both sides are optional and an empty one is simply absent (see `yaml`). Order
 *  is kept — for a note filed into several hubs the first is the primary — and
 *  `Contains` leads because that is the direction you read a hub in.
 *
 *  Legacy `Tags:` lines are still READ, by `inbox.ts`, so captures made before
 *  this (and by older clients) still pre-fill the desk's pickers. Nothing writes
 *  one any more. */
export const containment = (i: { contains?: string; containedBy?: string }): Record<string, unknown> => ({
  Contains: linkList(i.contains),
  "Contained By": linkList(i.containedBy),
});

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

/** The two containment pickers, in the order the desk asks them. Shared by every
 *  type so the pair reads the same wherever it appears — these are the two
 *  relationships triage is FOR, not per-type metadata. */
const CONTAINMENT_FIELDS: Field[] = [
  { key: "containedBy", label: "contained by", type: "scope", placeholder: "the hub(s) this belongs to — comma-separated" },
  { key: "contains", label: "contains", type: "scope", placeholder: "what this is a hub for — comma-separated" },
];

/** The three things a capture can turn out to be. This dropdown used to list the
 *  four *shapes of form* the app happened to have — Memo, Task, Resource, Media —
 *  which is a question about note templates, not about the thought in front of
 *  you. Media and Resource were memos with extra fields; the real fork at the desk
 *  is structural:
 *
 *    - MEMO  — a note. The default, and what nearly everything is.
 *    - SCOPE — a hub: a note other notes hang off, so it is the one type whose
 *              own `Contains` side is the point.
 *    - TODO  — not a note at all. A task is a LINE, filed by living in its
 *              scope's note, so filing one appends an atom and writes no note of
 *              its own (see the triage route).
 *
 *  Media and Resource live on in `LEGACY_FUNNELS` — off the dropdown, still
 *  resolvable, because the JSON `/ingest` API is a published contract.
 */
export const FUNNELS: Funnel[] = [
  {
    id: "memo",
    label: "Memo",
    hint: "a thought → a note at the vault root",
    fields: [
      { key: "title", label: "title", type: "text" },
      { key: "body", label: "body", type: "textarea", required: true },
      ...CONTAINMENT_FIELDS,
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
      frontmatter: { tags: ["memo"], ...containment(i) },
      body: `${i.title ? `# ${i.title}\n` : ""}\n${i.body}`,
    }),
  },
  {
    id: "scope",
    label: "Scope",
    hint: "a hub for an area — the thing other notes hang off",
    fields: [
      { key: "title", label: "name", type: "text", required: true },
      { key: "body", label: "what it's for", type: "textarea" },
      ...CONTAINMENT_FIELDS,
      { key: "ingestable", label: "a capture destination (offer it on the capture form)", type: "checkbox" },
    ],
    // A hub, written the way the vault's own hubs are: `tags: [scope]`, the
    // containment fields, and a line of prose saying what it covers. NO `# title`
    // heading — a scope's name is its filename and the existing hubs open
    // straight into their description, so a heading here would be the one thing
    // about a generated hub that didn't match a hand-written one.
    //
    // `ingestable` stacks on the tag rather than replacing it (see the vault's
    // `_meta/Tags.md`): it is what puts the new hub in the capture form's
    // dropdown, and it is a checkbox rather than automatic because most hubs are
    // places notes get filed INTO, not places you think at.
    build: (i) => ({
      title: i.title,
      frontmatter: {
        tags: i.ingestable ? ["scope", "ingestable"] : ["scope"],
        ...containment(i),
      },
      body: i.body ?? "",
    }),
  },
  {
    id: "todo",
    label: "TODO",
    hint: "a dated atom — one next action, filed into one scope",
    fields: [
      { key: "title", label: "what needs doing", type: "text", required: true },
      { key: "body", label: "detail", type: "textarea" },
      { key: "due", label: "due", type: "date" },
      { key: "priority", label: "priority", type: "select", options: Object.keys(PRIORITY_SIGNIFIER) },
      // ONE scope, and a picker that says so. Not `required` here, because this
      // spec is also what the phone's one-tap task capture is validated against
      // and a thought must never be rejected for want of filing. The DESK
      // requires it — that is where "file it" means "append the atom to this
      // note", and there is nothing to append to without one.
      { key: "containedBy", label: "file into", type: "scope", single: true, placeholder: "the scope note this atom lives in" },
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
      frontmatter: { tags: ["memo"], ...containment(i) },
      body: `# ${i.title}\n\n${taskLine(i)}${i.body ? `\n\n${i.body}` : ""}`,
    }),
  },
];

/** Off the dropdown, still resolvable. Both are memos with extra fields — the
 *  desk types them as memos now — but the JSON `/ingest` API names its funnel
 *  outright, and an iOS Shortcut posting `funnel: "media"` must not start 400ing
 *  because a *dropdown* was shortened. */
export const LEGACY_FUNNELS: Funnel[] = [
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
      frontmatter: {
        tags: ["memo"], kind: i.kind, status: i.status || "want", url: i.url || undefined,
        ...containment({ containedBy: MEDIA_SCOPE[i.kind] ?? "Media" }),
      },
      body: `# ${i.title}\n\n${i.creator ? `*${i.creator}*\n\n` : ""}${i.why || ""}`,
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
      frontmatter: {
        tags: ["memo", "reference"], url: i.url || undefined,
        ...containment({ containedBy: i.activity }),
      },
      body: `# ${i.title}\n\n${i.note || ""}`,
    }),
  },
];

/** Retired funnel ids, kept resolvable so an existing caller (an iOS Shortcut
 *  posting `funnel: "task"` to /ingest) doesn't start 400ing on a rename. `task`
 *  and `todo` have now swapped places twice; both have always meant the atom. */
const ALIASES: Record<string, string> = { task: "todo" };

export const funnelById = (id: string): Funnel | undefined =>
  [...FUNNELS, ...LEGACY_FUNNELS].find((f) => f.id === (ALIASES[id] ?? id));
