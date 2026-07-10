// braindance publish tool — project publish-tagged notes from the private vault
// into the in-repo garden (ctx/www/garden/content, flat — /garden/<slug>).
// Deterministic; run manually, review the diff (git diff ctx/www/garden/content),
// then commit. Full design: ctx/tools/pub/README.md.
//
//   npm run publish -- [--vault DIR] [--pub DIR] [--strict|--scrub] [--dry]
//
// Default is STRICT and FAIL-CLOSED: exit nonzero if a published note would leak —
// a link OR embed/transclusion to a non-published vault note ([[x]] AND ![[x]]),
// or an asset embed (![[x.png]]) whose file can't be resolved. --strict is the
// default and is named explicitly for CI intent. --scrub instead downgrades
// private links/embeds to plain text and drops unresolvable asset embeds so a bulk
// publish can proceed; the two are mutually exclusive.
//
// The vault is read ONLY here, at projection time. CI never runs this against the
// vault — it re-audits the already-committed projection with `verify.ts`, which
// reads only ctx/www/garden/content. See README + .github/workflows/pages.yml.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import { walkVault, buildIndex, selectPublished, hasTag, findAsset } from './vault.ts';
import {
  stripScaffolding, normalizeAssetEmbeds, classifyLinks, scrubPrivateLinks,
  scrubMissingAssetEmbeds, whitelistFrontmatter, wordCount,
} from './transform.ts';
import { regenerate, type Published } from './mirror.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args { vault: string; pub: string; scrub: boolean; strict: boolean; dry: boolean; }

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const scrub = argv.includes('--scrub');
  if (scrub && argv.includes('--strict')) {
    console.error('✗ --strict and --scrub are mutually exclusive.');
    process.exit(2);
  }
  return {
    // --vault / --pub default to this repo's own ctx/vault and ctx/www (the tool
    // lives at ctx/tools/pub/src, so ../../../{vault,www}). PUB_REPO still lets an
    // advanced user target a separate repo (the VPS/two-repo path).
    vault: resolve(get('--vault') ?? resolve(HERE, '../../../vault')),
    pub: resolve(get('--pub') ?? process.env.PUB_REPO ?? resolve(HERE, '../../../www')),
    scrub,
    strict: !scrub,
    dry: argv.includes('--dry') || argv.includes('--dry-run'),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`vault: ${args.vault}\npub:   ${args.pub}\nmode:  ${args.scrub ? 'scrub' : 'strict'}${args.dry ? ' (dry-run)' : ''}\n`);

  const notes = walkVault(args.vault);
  const index = buildIndex(notes);
  const published = selectPublished(notes);
  const publishedSet = new Set(published.map((n) => n.basename));

  if (published.length === 0) {
    console.log('No notes tagged `publish: true`. Nothing to project.');
    if (!args.dry) regenerate(args.pub, []);
    return;
  }

  const items: Published[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const note of published) {
    let body = stripScaffolding(note.body);
    body = normalizeAssetEmbeds(body);
    const links = classifyLinks(body, index, publishedSet);

    // Privacy gate — links AND embeds/transclusions to unpublished vault notes.
    // classifyLinks already treats ![[note]] transclusions as note links (only
    // ![[x.ext]] is an asset), so a private-note *embed* is caught here too.
    if (links.privateLinks.length) {
      const uniq = [...new Set(links.privateLinks)];
      if (args.scrub) {
        body = scrubPrivateLinks(body, new Set(uniq)); // downgrades [[x]] and ![[x]]
      } else {
        errors.push(`${note.basename}: links/embeds private note(s) → ${uniq.join(', ')}  (publish them, unlink, or run --scrub)`);
      }
    }

    // Assets: carry ONLY the ones this published note actually references, and
    // only if resolvable. An unresolvable asset embed is a leak vector (a stray
    // ![[secret.png]] pointing outside the copied set) — block it in strict.
    const assetPaths: string[] = [];
    const missing: string[] = [];
    for (const name of [...new Set(links.assets)]) {
      const found = findAsset(args.vault, name);
      if (found) assetPaths.push(found);
      else missing.push(name);
    }
    if (missing.length) {
      if (args.scrub) {
        body = scrubMissingAssetEmbeds(body, new Set(missing)); // drop the embed
      } else {
        errors.push(`${note.basename}: unresolvable asset embed(s) → ${missing.join(', ')}  (add the file, remove the embed, or run --scrub)`);
      }
    }

    // Quality warnings (non-blocking).
    if (wordCount(body) < 20) warnings.push(`${note.basename}: stub (<20 words)`);
    if (hasTag(note, 'todo')) warnings.push(`${note.basename}: still tagged \`todo\``);

    const fm = whitelistFrontmatter(note.data);
    const content = Object.keys(fm).length ? matter.stringify(body, fm) : body;
    items.push({ basename: note.basename, content, assets: assetPaths });
  }

  for (const w of warnings) console.log(`⚠ ${w}`);
  if (warnings.length) console.log('');

  if (errors.length) {
    console.error(`✗ ${errors.length} blocking issue(s) — nothing written:\n`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  console.log(`Ready to publish ${items.length} note(s): ${items.map((i) => i.basename).join(', ')}`);
  if (args.dry) {
    console.log('\n(dry-run — no files written)');
    return;
  }

  const { notes: n, assets: a } = regenerate(args.pub, items);
  console.log(`\n✓ Wrote ${n} note(s) + ${a} asset(s) to ${args.pub}/garden/content`);
  console.log('Next: review the diff (git diff ctx/www/garden/content) and commit.');
}

main();
