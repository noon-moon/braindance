// Inbox reader — the untriaged capture queue.
//
// Captures land as `inbox/<stamp>-<slug>.md` (notes.ts / doCapture). The manual
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
  /** Human title: the first `# heading`, else a humanised filename slug. */
  title: string;
  /** Body with the leading scope link + `# title` heading stripped — the actual content. */
  text: string;
  /** Original capture time (ISO-8601), reconstructed from the filename stamp. */
  createdISO: string | null;
  /** Scope MOC chosen at capture time (the leading `Tags: [[…]]` link), else null.
   *  Carried into the triage form's scope dropdown so the pick isn't re-made. */
  scope: string | null;
}

// A capture filename is `${stamp()}-${slug}.md` where stamp() is an ISO string
// with `:` and `.` replaced by `-`, e.g. `2026-07-20T06-29-50-938Z-cool-article`.
// Reverse just the time-part substitutions to recover the original ISO instant.
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.*)$/;

function parseStamp(nameNoExt: string): { createdISO: string | null; slugPart: string } {
  const m = nameNoExt.match(STAMP_RE);
  if (!m) return { createdISO: null, slugPart: nameNoExt };
  const [, date, h, min, s, ms, slugPart] = m;
  return { createdISO: `${date}T${h}:${min}:${s}.${ms}Z`, slugPart };
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

/** Pull a leading `Tags: [[Scope]]` line (the scope-link convention written by
 *  `funnels.ts`'s scopeLink) off the top of a body — it sits ABOVE the `# title`,
 *  so it has to come off before splitHeading can see the heading. */
const SCOPE_LINE = /^Tags:\s*\[\[([^\]]+)\]\]\s*$/;

function splitScope(body: string): { scope: string | null; rest: string } {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const m = lines[i]?.trim().match(SCOPE_LINE);
  if (!m) return { scope: null, rest: body };
  // Strip any alias/anchor, matching how vault.ts resolves a wikilink target.
  const scope = m[1].split("|")[0].split("#")[0].trim();
  return { scope: scope || null, rest: lines.slice(i + 1).join("\n") };
}

const humanise = (s: string): string => s.replace(/[-_]+/g, " ").trim() || "untitled";

function toInboxNote(fileName: string): InboxNote | null {
  const name = fileName.slice(0, -3); // strip .md
  let raw: string;
  try {
    raw = readFileSync(join(INBOX_DIR, fileName), "utf8");
  } catch {
    return null;
  }
  const { content } = matter(raw);
  const { scope, rest } = splitScope(content);
  const { title, text } = splitHeading(rest);
  const { createdISO, slugPart } = parseStamp(name);
  return { name, title: title || humanise(slugPart), text, createdISO, scope };
}

/** All untriaged inbox notes, newest capture first. */
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
  return entries.map(toInboxNote).filter((n): n is InboxNote => n !== null);
}

/** One inbox note by name (without `.md`), or null if absent. */
export function getInboxNote(name: string): InboxNote | null {
  if (!name || name.includes("/") || name.includes("..")) return null; // path-safety
  const fileName = `${name}.md`;
  if (!existsSync(join(INBOX_DIR, fileName))) return null;
  return toInboxNote(fileName);
}
