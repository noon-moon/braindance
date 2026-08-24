// Vault walking, indexing, selection, and asset resolution.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import matter from 'gray-matter';

export interface Note {
  path: string; // absolute
  rel: string; // relative to the vault root
  basename: string; // filename without .md — a note's identity
  data: Record<string, unknown>; // frontmatter
  body: string; // content after frontmatter
}

// Not real notes / not publishable sources.
const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', 'assets', 'attachments']);

// A note whose frontmatter is invalid YAML (the usual cause: an unquoted `: `
// inside a value) must not take the whole run down — one bad note would block
// every publish. Fall back to EMPTY frontmatter with the raw text as the body:
// the note keeps its identity in the index, so a wikilink to it still resolves
// as internal-PRIVATE and still blocks the gate. Dropping it instead would
// reclassify those links as external and let the title through — the exact leak
// the gate exists to stop. With no frontmatter it can never carry `publish:
// true`, so it can never be selected itself.
function parseNote(path: string, raw: string): { data: Record<string, unknown>; body: string } {
  try {
    const { data, content } = matter(raw);
    return { data: data ?? {}, body: content };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.warn(`warn: unreadable frontmatter, treating as private: ${path}\n      ${reason}`);
    return { data: {}, body: raw };
  }
}

export function walkVault(vaultDir: string): Note[] {
  const out: Note[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const path = join(dir, entry.name);
        const { data, body } = parseNote(path, readFileSync(path, 'utf8'));
        out.push({
          path,
          rel: relative(vaultDir, path),
          basename: entry.name.slice(0, -3),
          data,
          body,
        });
      }
    }
  };
  walk(vaultDir);
  return out;
}

// Basename -> note, for wikilink resolution (Obsidian resolves by basename).
export function buildIndex(notes: Note[]): Map<string, Note> {
  const idx = new Map<string, Note>();
  for (const n of notes) idx.set(n.basename, n);
  return idx;
}

export function selectPublished(notes: Note[]): Note[] {
  return notes.filter((n) => n.data.publish === true);
}

export function hasTag(note: Note, tag: string): boolean {
  const t = note.data.tags;
  return Array.isArray(t) && t.map(String).includes(tag);
}

// Find a referenced asset by basename under the vault's binary stores.
// Assets live in <vault>/assets or <vault>/attachments (gitignored, present locally).
export function findAsset(vaultDir: string, name: string): string | null {
  const target = name.split('/').pop()!; // accept both `x.png` and `assets/x.png`
  for (const sub of ['assets', 'attachments']) {
    const found = searchByName(join(vaultDir, sub), target);
    if (found) return found;
  }
  return null;
}

function searchByName(dir: string, name: string): string | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // dir may not exist
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = searchByName(p, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}
