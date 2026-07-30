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

function parse(name: string, raw: string): VaultNote {
  const { data, content } = matter(raw);
  const tags = Array.isArray(data?.tags) ? data.tags.map(String) : [];
  const outlinks: string[] = [];
  for (const m of content.matchAll(WIKILINK)) {
    outlinks.push(m[1].split("|")[0].split("#")[0].trim());
  }
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

/** Drop the cached index so the next read re-scans the working tree. Called
 *  after a capture commits, so just-written notes are visible immediately. */
export const invalidate = (): void => {
  cache = null;
};

export const getScopes = (): string[] =>
  [...index().notes.values()].filter((n) => n.tags.includes("scope")).map((n) => n.name).sort();

export const getNote = (name: string): VaultNote | undefined => index().notes.get(name);

export const backlinksFor = (name: string): string[] =>
  [...new Set(index().backlinks.get(name) ?? [])].sort();

export const listNotes = (): VaultNote[] =>
  [...index().notes.values()].sort((a, b) => a.name.localeCompare(b.name));

export const noteExists = (name: string): boolean => index().notes.has(name);
