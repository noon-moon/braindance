// Write the published set into <pub>/garden/content — the garden root, so notes
// live at /garden/<slug> (no /notes/ nesting). Because content/ also holds
// hand-authored pages (index.md) we can't wipe the whole dir; instead a manifest
// records exactly the files this tool wrote last run and deletes only those, so
// un-tagging a note still removes it (deletions come for free) while index.md and
// any other hand-authored page are never touched.
import { rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface Published {
  basename: string;
  content: string;
  assets: string[]; // absolute source paths of referenced assets
}

// Lives outside content/ so Quartz never emits it; committed so the owned-file
// set survives across checkouts and CI runs.
const manifestPath = (pubDir: string) => join(pubDir, 'garden', '.publish-manifest.json');

export function regenerate(pubDir: string, items: Published[]): { notes: number; assets: number } {
  const contentDir = join(pubDir, 'garden', 'content');
  mkdirSync(contentDir, { recursive: true });

  // Remove everything we wrote last run — this is what makes un-tagging delete a
  // note. Files absent from the manifest (e.g. index.md) are left alone.
  const manifest = manifestPath(pubDir);
  if (existsSync(manifest)) {
    const prev: string[] = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const rel of prev) rmSync(join(contentDir, rel), { force: true });
  }

  const owned: string[] = [];
  const copied = new Set<string>();
  for (const it of items) {
    const noteFile = `${it.basename}.md`;
    writeFileSync(join(contentDir, noteFile), it.content, 'utf8');
    owned.push(noteFile);
    for (const src of it.assets) {
      const name = basename(src);
      if (copied.has(name)) continue;
      copyFileSync(src, join(contentDir, name));
      copied.add(name);
      owned.push(name);
    }
  }
  writeFileSync(manifest, JSON.stringify(owned.sort(), null, 2) + '\n', 'utf8');
  return { notes: items.length, assets: copied.size };
}
