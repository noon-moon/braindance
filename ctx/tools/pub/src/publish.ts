// braindance publish tool — project publish-tagged notes from the private vault
// into noon-moon-net/garden/content (flat — /garden/<slug>). Deterministic; run manually, review the diff
// in noon-moon-net, then commit. Full design: ctx/noon-moon-net.md.
//
//   npm run publish -- [--vault DIR] [--pub DIR] [--scrub] [--dry]
//
// Default (strict): abort if any published note links to a non-published note —
// the privacy boundary. --scrub instead downgrades such links to plain text.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import matter from 'gray-matter';
import { walkVault, buildIndex, selectPublished, hasTag, findAsset, type Note } from './vault.ts';
import {
  stripScaffolding, normalizeAssetEmbeds, classifyLinks, scrubPrivateLinks,
  whitelistFrontmatter, wordCount,
} from './transform.ts';
import { regenerate, type Published } from './mirror.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args { vault: string; pub: string; scrub: boolean; dry: boolean; }

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  return {
    vault: resolve(get('--vault') ?? process.env.VAULT_REPO ?? resolve(HERE, '../../../vault')),
    pub: resolve(get('--pub') ?? process.env.PUB_REPO ?? resolve(homedir(), 'dev/noon-moon-net')),
    scrub: argv.includes('--scrub'),
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

    // Privacy gate — links to unpublished vault notes.
    if (links.privateLinks.length) {
      const uniq = [...new Set(links.privateLinks)];
      if (args.scrub) {
        body = scrubPrivateLinks(body, new Set(uniq));
      } else {
        errors.push(`${note.basename}: links to private note(s) → ${uniq.join(', ')}  (publish them, unlink, or run --scrub)`);
      }
    }

    // Assets must exist locally to be copied.
    const assetPaths: string[] = [];
    for (const name of [...new Set(links.assets)]) {
      const found = findAsset(args.vault, name);
      if (found) assetPaths.push(found);
      else errors.push(`${note.basename}: missing asset → ${name}`);
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
  console.log('Next: review the diff in noon-moon-net and commit.');
}

main();
