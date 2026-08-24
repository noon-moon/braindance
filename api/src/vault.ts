// Index over the flat vault. Slice 1: reads the SAME read-write working checkout
// the api commits captures into (git.ts), so writes are immediately visible —
// it no longer waits on a host `git pull` timer to refresh a `:ro` mount. The
// index is rebuilt on a short TTL and eagerly invalidated after each capture
// (see `invalidate()`), so the next read reflects the just-committed note.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { REPO_PATH, VAULT_SUBDIR } from "./config.js";

// Defaults to <REPO_PATH>/<VAULT_SUBDIR> so the viewer reads exactly the checkout
// the git store commits to. VAULT_PATH still overrides for standalone/legacy
// setups. (VAULT_SUBDIR is "" once the checkout ROOT is the vault, post-cutover.)
const VAULT_PATH = process.env.VAULT_PATH ?? join(REPO_PATH, VAULT_SUBDIR);
const WIKILINK = /\[\[([^\]]+)\]\]/g;
const TTL_MS = 3000;

export interface VaultNote {
  name: string; // filename without .md — the note's identity
  data: Record<string, unknown>; // frontmatter
  body: string;
  tags: string[];
  outlinks: string[]; // wikilink target basenames
}

interface Index {
  notes: Map<string, VaultNote>;
  backlinks: Map<string, string[]>;
}

let cache: { at: number; idx: Index } | null = null;

/** Every `[[wikilink]]` target in a frontmatter VALUE, at any depth. Obsidian
 *  resolves links in properties as ordinary links, and the vault's containment
 *  fields (`Contains` / `Contained By`) are the main place a note's structural
 *  links now live — so a scan that only read the body would report a hub with no
 *  backlinks from the very notes filed into it. Values are walked rather than
 *  looked up by name: `topic`, `source`, a template's own field can each hold a
 *  link, and the index has no business knowing which keys those are.
 *
 *  Keys are deliberately NOT scanned — a key is a field name, and `[[…]]` in one
 *  is a malformed note rather than a link. */
function fmLinks(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(WIKILINK)) into.push(m[1].split("|")[0].split("#")[0].trim());
  } else if (Array.isArray(value)) {
    for (const v of value) fmLinks(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) fmLinks(v, into);
  }
}

function parse(name: string, raw: string): VaultNote {
  const { data, content } = matter(raw);
  const tags = Array.isArray(data?.tags) ? data.tags.map(String) : [];
  const outlinks: string[] = [];
  for (const m of content.matchAll(WIKILINK)) {
    outlinks.push(m[1].split("|")[0].split("#")[0].trim());
  }
  fmLinks(data, outlinks);
  return { name, data: data ?? {}, body: content, tags, outlinks };
}

export function index(): Index {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.idx;

  const notes = new Map<string, VaultNote>();
  for (const e of readdirSync(VAULT_PATH, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue; // flat vault; skips daily/, inbox/, _meta/
    const name = e.name.slice(0, -3);
    try {
      notes.set(name, parse(name, readFileSync(join(VAULT_PATH, e.name), "utf8")));
    } catch { /* skip unreadable */ }
  }

  const backlinks = new Map<string, string[]>();
  for (const note of notes.values()) {
    for (const target of note.outlinks) {
      (backlinks.get(target) ?? backlinks.set(target, []).get(target)!).push(note.name);
    }
  }

  const idx = { notes, backlinks };
  cache = { at: now, idx };
  return idx;
}

/** Drop the viewer's cached indexes so the next read re-scans the working tree.
 *  Called after the applier files a note, so a hub it just minted is visible to
 *  the collision check on the very next capture in the same pass. */
export const invalidate = (): void => { cache = null; };

/** The scopes explicitly marked `ingestable`, and NOTHING else. No fallback: an
 *  empty answer means the vault marked nothing, which is a real answer.
 *
 *  This is the accessor for any caller where the list is an ALLOWLIST — chiefly
 *  suggest.ts, where the names (and a line of each hub's description) leave the
 *  box. An allowlist that grows when its tag goes missing is not an allowlist,
 *  so a bulk frontmatter edit that drops `ingestable` must shrink egress to
 *  nothing rather than silently widen it to every scope in the vault. */
export const getIngestableScopesStrict = (): string[] =>
  [...index().notes.values()]
    .filter((n) => n.tags.includes("scope") && n.tags.includes("ingestable"))
    .map((n) => n.name)
    .sort();

export const getNote = (name: string): VaultNote | undefined => index().notes.get(name);

export const noteExists = (name: string): boolean => index().notes.has(name);

/** Every root-note name already spoken for, lowercased — the test a name for a
 *  NEW note has to pass before anything writes it.
 *
 *  Deliberately not `noteExists`, and for two independent reasons:
 *
 *   - CASE. `slug()` lowercases, and every note in this vault is title-cased, so
 *     `noteExists("books")` is false while `Books.md` sits right there. On a
 *     case-INSENSITIVE filesystem (APFS, a Docker Desktop bind mount) writing
 *     `books.md` then opens and TRUNCATES `Books.md` — the de-dup loop that was
 *     meant to stop exactly that never fired, because its test never matched.
 *   - THE INDEX IS NOT THE DISK. `index()` skips a note whose frontmatter won't
 *     parse, so a file that plainly exists can be missing from the map on any
 *     platform. What a filename collides with is a directory question, and the
 *     directory is the only thing that can answer it.
 *
 *  The index is unioned in rather than replaced so a directory we can't read
 *  degrades to the old answer instead of declaring every name free. */
export function takenRootNames(): Set<string> {
  const taken = new Set<string>();
  for (const name of index().notes.keys()) taken.add(name.toLowerCase());
  try {
    for (const e of readdirSync(VAULT_PATH, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith(".md")) taken.add(e.name.slice(0, -3).toLowerCase());
    }
  } catch { /* unreadable vault dir — the index is all we have */ }
  return taken;
}


