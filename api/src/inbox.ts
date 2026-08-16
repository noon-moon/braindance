// Inbox reader — the untriaged capture queue.
//
// Captures land as `inbox/<stamp>.md`, or `inbox/<stamp>-<slug>.md` when a title
// was typed — the one-tap path names nothing (notes.ts / doCapture). The manual
// triage desk (in /review) drains this queue: each memo is re-typed to a real
// vault note, kept as a plain memo at the vault root, or discarded — always as
// one atomic op via the adapter, so the inbox trends to empty and everything in
// it is, by definition, still untriaged.
//
// This module only READS the inbox (the writes are ordinary changesets committed
// from index.ts). It reads the same working checkout the viewer does, so a
// just-captured memo shows up on the next request.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { REPO_PATH, VAULT_SUBDIR } from "./config.js";

// Same resolution as vault.ts: <REPO_PATH>/<VAULT_SUBDIR> (VAULT_PATH overrides),
// then the `inbox/` subdir. VAULT_SUBDIR is "" once the checkout ROOT is the vault.
const VAULT_DIR = process.env.VAULT_PATH ?? join(REPO_PATH, VAULT_SUBDIR);
const INBOX_DIR = join(VAULT_DIR, "inbox");

export interface InboxNote {
  /** Filename without `.md` — the note's identity in the inbox. */
  name: string;
  /** Human title: the first `# heading`, else a humanised filename slug, else the
   *  body's first line — an untitled capture has neither of the first two. */
  title: string;
  /** Body with the leading scope link + `# title` heading stripped — the actual content. */
  text: string;
  /** Original capture time (ISO-8601), reconstructed from the filename stamp. */
  createdISO: string | null;
  /** The hubs this capture belongs to — `Contained By` frontmatter, plus any
   *  legacy `Tags: [[…]]` line — in the order written, empty when none was
   *  picked. Carried into the desk's "contained by" picker so a capture-time
   *  pick isn't re-made, and for a TODO it is the note the atom files into. */
  containedBy: string[];
  /** The other direction: what this capture is a hub FOR. Only a `Contains`
   *  frontmatter list, since the legacy line could never express it. Almost
   *  always empty on a capture — it is the desk's question, not the thumb's. */
  contains: string[];
}

// A capture filename is `${stamp()}.md`, or `${stamp()}-${slug}.md` when a title
// was typed, where stamp() is an ISO string with `:` and `.` replaced by `-`
// (`2026-07-20T06-29-50-938Z-cool-article`). The slug suffix is OPTIONAL: the
// one-tap capture path names by timestamp alone, and a bare stamp still has to
// yield its instant — createdISO is the only place the capture time survives.
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-(.*))?$/;

function parseStamp(nameNoExt: string): { createdISO: string | null; slugPart: string } {
  const m = nameNoExt.match(STAMP_RE);
  if (!m) return { createdISO: null, slugPart: nameNoExt };
  const [, date, h, min, s, ms, slugPart] = m;
  return { createdISO: `${date}T${h}:${min}:${s}.${ms}Z`, slugPart: slugPart ?? "" };
}

/** Split a note body (frontmatter already removed) into its `# title` and the
 *  remaining text. Falls back to an empty title when there's no leading heading. */
function splitHeading(body: string): { title: string; text: string } {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const h = lines[i]?.match(/^#\s+(.+)/);
  if (!h) return { title: "", text: body.trim() };
  return { title: h[1].trim(), text: lines.slice(i + 1).join("\n").trim() };
}

/** Pull a leading `Tags: [[Scope]] [[Other]]` line off the top of a body — it sits
 *  ABOVE the `# title`, so it has to come off before splitHeading can see the
 *  heading.
 *
 *  LEGACY, and read-only: this was the scope-link convention until containment
 *  moved into frontmatter (`funnels.ts`'s `containment`). Nothing writes one any
 *  more, but the inbox is a synced directory — a capture made by an older client,
 *  or one that was already sitting in the queue — so the desk still has to
 *  recover the pick rather than silently drop it.
 *
 *  Matches ONE OR MORE links, and only links: a line ending in prose is somebody's
 *  sentence that happens to start with `Tags:`, and eating it would delete text
 *  from the note. */
const SCOPE_LINE = /^Tags:\s*((?:\[\[[^\]]+\]\]\s*)+)$/;
const LINK_RE = /\[\[([^\]]+)\]\]/g;

/** A wikilink target, as vault.ts resolves one: alias and anchor stripped. */
const linkTarget = (raw: string): string => raw.split("|")[0].split("#")[0].trim();

function splitScope(body: string): { scopes: string[]; rest: string } {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const m = lines[i]?.trim().match(SCOPE_LINE);
  if (!m) return { scopes: [], rest: body };
  const scopes: string[] = [];
  for (const [, target] of m[1].matchAll(LINK_RE)) {
    const s = linkTarget(target);
    if (s && !scopes.includes(s)) scopes.push(s);
  }
  return { scopes, rest: lines.slice(i + 1).join("\n") };
}

/** Scope names out of a containment frontmatter field. The vault writes these as
 *  a list of quoted wikilinks (`- "[[Music]]"`), which gray-matter hands back as
 *  a string array — but a hand-edited note may carry a lone string, a bare name
 *  with no brackets, or a null from an emptied Obsidian property, and none of
 *  those should cost the desk the whole pick. Anything that isn't a usable name
 *  is dropped; nothing here throws. */
function fmScopes(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    // A `[[link]]` yields its target; anything else is taken as a plain name.
    const m = [...item.matchAll(LINK_RE)].map(([, t]) => linkTarget(t));
    for (const s of m.length ? m : [item.trim()]) if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const humanise = (s: string): string => s.replace(/[-_]+/g, " ").trim();

/** The label an untitled capture carries: the body's first non-blank line, cut to
 *  something that still reads on a phone row. Capture (the toast) and the review
 *  list share this rule deliberately — a note named one thing as it lands and
 *  another when it comes back up for triage is a note you can't find twice.
 *
 *  Which means those two callers pass NO `max`: the shared rule is the default,
 *  and a call site that names its own width has quietly stopped sharing it (the
 *  toast passed 48 against this 60 and relabelled every line in between). `max`
 *  is for callers doing something else entirely with a first line — suggest.ts
 *  cuts a scope blurb for egress, which is a budget, not a label. */
export function firstLine(body: string, max = 60): string {
  const line = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The ONE name test for an inbox note, shared by everything that turns a name
 *  into a path: this module's reader and suggest.ts's sidecar store.
 *
 *  It is one predicate because three near-copies is what let `..notes.md` exist:
 *  a name the listing admitted, the sidecar store silently refused to write for,
 *  and `getInboxNote` refused to open — a note in the queue that could be paid
 *  for on every tick and triaged by nobody. A name that fails here is not
 *  "unsafe to write" or "unsafe to read", it is UNREPRESENTABLE, so it must be
 *  rejected at the door rather than half-accepted downstream.
 *
 *  Rejects: empty; either separator (`\` is a separator on the platforms this
 *  may be pulled from, and half the old checks let it through); `..` anywhere,
 *  which is coarser than "the `..` segment" on purpose — no capture filename
 *  contains it; a leading dot, which is a dotfile rather than a capture; and any
 *  control character, which no filename this app writes contains and which would
 *  otherwise reach a log line or a header. */
export const isSafeNoteName = (name: string): boolean =>
  Boolean(name) &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("..") &&
  !name.startsWith(".") &&
  !/[\u0000-\u001f\u007f]/.test(name);

/** Names already warned about, so an unsafe file that sits in the inbox logs
 *  once rather than on every listing (which is every page render AND every
 *  worker tick). Silence is what made this class of note invisible; a line per
 *  request would be its own kind of silence. */
const warnedNames = new Set<string>();

function toInboxNote(fileName: string): InboxNote | null {
  const name = fileName.slice(0, -3); // strip .md
  let raw: string;
  try {
    raw = readFileSync(join(INBOX_DIR, fileName), "utf8");
  } catch {
    return null;
  }
  const { data, content } = matter(raw);
  const { scopes, rest } = splitScope(content);
  const { title, text } = splitHeading(rest);
  const { createdISO, slugPart } = parseStamp(name);
  // Frontmatter first, legacy line after: the two can only both be present on a
  // note somebody hand-edited, and the field is the convention now.
  const containedBy = [...new Set([...fmScopes(data?.["Contained By"]), ...scopes])];
  // Heading → filename slug → first line. The slug outranks the body because when
  // one exists it IS the title someone typed; the first line only carries an
  // untitled capture, which is now the common case.
  return {
    name,
    title: title || humanise(slugPart) || firstLine(text) || "untitled",
    text,
    createdISO,
    containedBy,
    contains: fmScopes(data?.Contains),
  };
}

/** All untriaged inbox notes, newest capture first.
 *
 *  The name filter is the gate for the whole queue, not a nicety: a note whose
 *  name `getInboxNote` will refuse can never be triaged or discarded, so
 *  admitting it only puts an immortal row in the desk — and, once the worker
 *  existed, a paid API call per tick for a note that can never leave. A file
 *  arriving by `git pull` (the inbox is a synced directory, not only ours) is
 *  exactly how such a name gets here. */
export function listInbox(): InboxNote[] {
  let entries: string[];
  try {
    entries = readdirSync(INBOX_DIR)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .sort()
      .reverse(); // filenames sort chronologically → reverse = newest first
  } catch {
    return []; // no inbox dir yet
  }
  return entries
    .filter((f) => {
      if (isSafeNoteName(f.slice(0, -3))) return true;
      if (!warnedNames.has(f)) {
        warnedNames.add(f);
        console.warn(`inbox: skipping ${JSON.stringify(f)} — unsafe name, cannot be addressed or triaged`);
      }
      return false;
    })
    .map(toInboxNote)
    .filter((n): n is InboxNote => n !== null);
}

/** One inbox note by name (without `.md`), or null if absent. */
export function getInboxNote(name: string): InboxNote | null {
  if (!isSafeNoteName(name)) return null; // the same gate the listing applies
  const fileName = `${name}.md`;
  if (!existsSync(join(INBOX_DIR, fileName))) return null;
  return toInboxNote(fileName);
}
