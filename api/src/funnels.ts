// Declarative capture funnels. Each is one spec: the server renders its form and
// build()s a vault-correct note (frontmatter + scoping links). Everything lands on
// the `inbox` branch for desk triage — the phone never writes `main`.
// See [[Braindance Admin App]] "Workflow 1 — Note ingest".

export interface BuiltNote {
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface Funnel {
  id: string;
  label: string;
  hint: string;
  /** How this type becomes a note — ABSENT for a type that does not become one.
   *
   *  `todo` has no build any more. A task in this vault is a TaskNotes note,
   *  written by `tasknotes.ts` from the plugin's own configured schema, and the
   *  applier routes there rather than here. Leaving a build that produced the
   *  old `- [ ] … #task` line would have been a shape nothing reads, emitted
   *  silently by whichever caller forgot. Optional says so in the type. */
  build?: (input: Record<string, string>) => BuiltNote;
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

const MEDIA_SCOPE: Record<string, string> = {
  Game: "Video Games",
  Book: "Books",
  Music: "Music",
  Film: "Film",
};

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
      frontmatter: { tags: ["memo"], ...(i.url ? { url: i.url } : {}), ...containment(i) },
      body: `${i.title ? `# ${i.title}\n` : ""}\n${i.body}`,
    }),
  },
  {
    id: "scope",
    label: "Scope",
    hint: "a hub for an area — the thing other notes hang off",
    // A hub, written the way the vault's own hubs are: `tags: [scope]`, the
    // containment fields, and a line of prose saying what it covers. NO `# title`
    // heading — a scope's name is its filename and the existing hubs open
    // straight into their description, so a heading here would be the one thing
    // about a generated hub that didn't match a hand-written one.
    //
    // `classifiable` stacks on the tag rather than replacing it (see the vault's
    // `_meta/Tags.md`): it is the EGRESS ALLOWLIST — this hub's name and blurb
    // are sent to a model on every classification. A checkbox rather than
    // automatic, because most hubs should hold content and containment without
    // ever leaving the machine.
    build: (i) => ({
      title: i.title,
      frontmatter: {
        tags: i.classifiable ? ["scope", "classifiable"] : ["scope"],
        ...(i.url ? { url: i.url } : {}),
        ...containment(i),
      },
      body: i.body ?? "",
    }),
  },
  {
    id: "todo",
    label: "TODO",
    hint: "a dated atom — one next action, filed into one scope",
    // A task is a LINE, not a note (see [[Tags]]) — so this builds the smallest
    // note that CARRIES one. Captured, it lands in `inbox/` and `/todo` shows it
    // as an unfiled atom straight away; triage then lifts the line out and
    // appends it to its scope note, which is what "filed" means.
    //
    // NO BUILD. A task is a TaskNotes note now — see the Funnel interface.
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
