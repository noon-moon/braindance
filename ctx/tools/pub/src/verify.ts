// braindance publish gate — CI-side, FAIL-CLOSED, VAULT-BLIND.
//
//   npm run verify [-- --pub DIR]
//
// Audits the ALREADY-COMMITTED public projection (<pub>/garden/content) for leaks
// WITHOUT reading ctx/vault — so it is safe to wire into the Pages workflow, which
// must never take the vault as an input (build-scope isolation). It re-checks, on
// exactly the bytes that will go public, the same boundary the projector enforced
// at commit time, and exits nonzero (breaking the deploy) on any of:
//
//   1. a wikilink/embed [[x]] or ![[x]] to a note NOT present in content/ — a
//      private-note title leak or a dangling reference (the projector would have
//      blocked/scrubbed it; if it's here, something bypassed the gate),
//   2. an asset embed ![[a.ext]] whose file is absent from content/ — a reference
//      pointing outside the carried, gated asset set,
//   3. a content note carrying a frontmatter key outside the whitelist — a field
//      that should have been stripped.
//
// content/index.md and any hand-authored page are audited by the same rules.
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import matter from 'gray-matter';
import { extractRefs, FM_WHITELIST } from './transform.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function get(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}

interface File { rel: string; abs: string; }

function walk(dir: string): File[] {
  const out: File[] = [];
  const rec = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push({ rel: relative(dir, p), abs: p });
    }
  };
  rec(dir);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const pub = resolve(get(argv, '--pub') ?? process.env.PUB_REPO ?? resolve(HERE, '../../../www'));
  const contentDir = join(pub, 'garden', 'content');
  console.log(`verify: auditing committed projection at ${contentDir}\n`);

  const files = walk(contentDir);
  const notesPresent = new Set(
    files.filter((f) => f.rel.endsWith('.md')).map((f) => f.rel.slice(0, -3).split('/').pop()!),
  );
  const assetsPresent = new Set(files.map((f) => f.rel.split('/').pop()!));

  const errors: string[] = [];

  for (const f of files) {
    if (!f.rel.endsWith('.md')) continue;
    const { data, content } = matter(readFileSync(f.abs, 'utf8'));

    // (3) frontmatter whitelist — no key outside the safe set may reach the site.
    for (const k of Object.keys(data ?? {})) {
      if (!FM_WHITELIST.has(k)) errors.push(`${f.rel}: disallowed frontmatter key '${k}'`);
    }

    const { assets, notes } = extractRefs(content);
    // (1) note links/embeds must resolve to a note actually in the projection.
    for (const n of new Set(notes)) {
      if (!notesPresent.has(n)) errors.push(`${f.rel}: link/embed to absent note → [[${n}]]  (private or dangling)`);
    }
    // (2) asset embeds must resolve to a carried asset file.
    for (const a of new Set(assets)) {
      if (!assetsPresent.has(a)) errors.push(`${f.rel}: embed of absent asset → ![[${a}]]`);
    }
  }

  if (errors.length) {
    console.error(`✗ FAIL-CLOSED: ${errors.length} leak/integrity issue(s) in the public projection:\n`);
    for (const e of errors) console.error(`  ${e}`);
    console.error('\nThe deploy is blocked. Re-run the publish tool (fix the source note), commit the corrected projection, and push.');
    process.exit(1);
  }

  console.log(`✓ ${files.filter((f) => f.rel.endsWith('.md')).length} note(s) clean — no private links/embeds, no dangling assets, whitelist intact.`);
}

main();
