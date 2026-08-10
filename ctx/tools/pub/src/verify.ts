// Publish gate, second pass — VAULT-BLIND (privacy enforcement point (b)).
//
// publish.ts gates at PROJECTION time, with the vault in hand. This re-audits the
// COMMITTED projection on its own, in CI, where the vault does not exist. It is the
// check that catches what projection-time gating structurally cannot:
//   - a file hand-edited under garden/content after it was projected
//   - a bad projection committed from a stale or patched checkout
//   - a leak introduced by editing the manifest rather than the notes
//
// It reads ONLY <pub>/garden. It must never learn what is in the vault — that is the
// whole point: if this passes, the published bytes are self-consistently safe no
// matter what the private side looks like. Passing --vault is therefore an error,
// not an option (someone "fixing" a failure that way would silently delete the
// guarantee).
//
//   npm run verify [-- --pub DIR]
//
// Exits nonzero on any finding, which BREAKS THE DEPLOY before anything is built.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { FM_WHITELIST, STRUCTURAL_TAGS } from './transform.ts';

// Hand-authored pages that legitimately live alongside the machine-owned notes.
const HAND_AUTHORED = new Set(['index.md']);

const ASSET_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif',
  'pdf', 'mp4', 'mov', 'webm', 'mp3', 'wav',
]);

const WIKILINK_RE = /(!?)\[\[([^\]]+)\]\]/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

interface Finding { file: string; message: string }

function targetOf(inner: string): string {
  return inner.split('|')[0].split('#')[0].trim();
}

function extOf(t: string): string {
  return t.includes('.') ? t.split('.').pop()!.toLowerCase() : '';
}

function parseArgs(argv: string[]) {
  if (argv.includes('--vault') || process.env.VAULT_REPO) {
    // Not a usage nit: reading the vault here would turn a structural guarantee
    // into a procedural one and defeat the entire check.
    console.error('verify is vault-blind by design — it takes no --vault (and ignores VAULT_REPO).');
    if (argv.includes('--vault')) process.exit(2);
  }
  const i = argv.indexOf('--pub');
  const pub = i !== -1 && argv[i + 1] ? argv[i + 1] : process.env.PUB_REPO;
  if (!pub) {
    console.error(
      'verify: no target. Pass --pub <dir> or set PUB_REPO to the site repo to audit\n' +
      '        (the directory CONTAINING garden/, not the garden itself).',
    );
    process.exit(2);
  }
  return { pub: resolve(pub) };
}

function main() {
  const { pub } = parseArgs(process.argv.slice(2));
  const gardenDir = join(pub, 'garden');
  const contentDir = join(gardenDir, 'content');
  console.log(`verifying: ${contentDir}\n`);

  if (!existsSync(contentDir)) {
    console.error(`no such directory: ${contentDir}`);
    process.exit(2);
  }

  const entries = readdirSync(contentDir, { withFileTypes: true }).filter((e) => e.isFile());
  const files = entries.map((e) => e.name);
  const notes = files.filter((f) => f.endsWith('.md'));
  const present = new Set(files); // every file that actually exists in content/
  const noteBasenames = new Set(notes.map((f) => f.slice(0, -3)));

  const findings: Finding[] = [];
  const warnings: string[] = [];

  // --- manifest integrity ------------------------------------------------------
  const manifestPath = join(gardenDir, '.publish-manifest.json');
  let owned = new Set<string>();
  if (existsSync(manifestPath)) {
    try {
      const list: string[] = JSON.parse(readFileSync(manifestPath, 'utf8'));
      owned = new Set(list);
      for (const rel of list) {
        if (!present.has(rel)) {
          findings.push({ file: '.publish-manifest.json', message: `lists "${rel}", which is not in content/ — the manifest is the delete-set, so a stale entry means the next publish cannot clean up` });
        }
      }
    } catch (err) {
      findings.push({ file: '.publish-manifest.json', message: `unparseable: ${err instanceof Error ? err.message : String(err)}` });
    }
  } else {
    warnings.push('no .publish-manifest.json — nothing has been projected yet');
  }

  for (const f of notes) {
    if (!owned.has(f) && !HAND_AUTHORED.has(f)) {
      warnings.push(`${f}: not in the manifest and not a known hand-authored page — checked anyway, but the publish tool does not own it`);
    }
  }

  // --- per-note checks ---------------------------------------------------------
  for (const file of notes) {
    const raw = readFileSync(join(contentDir, file), 'utf8');

    let data: Record<string, unknown>;
    let body: string;
    try {
      const parsed = matter(raw);
      data = (parsed.data ?? {}) as Record<string, unknown>;
      body = parsed.content;
    } catch (err) {
      // Fail closed: frontmatter we cannot read is frontmatter we cannot whitelist.
      findings.push({ file, message: `unreadable frontmatter, so it cannot be checked: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
      continue;
    }

    // Frontmatter whitelist — the projection should already have dropped these.
    for (const key of Object.keys(data)) {
      if (!FM_WHITELIST.has(key)) {
        findings.push({ file, message: `frontmatter key "${key}" is not in the public whitelist — it was added or restored after projection` });
      }
    }
    const tags = data.tags;
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (STRUCTURAL_TAGS.has(String(t))) {
          findings.push({ file, message: `internal tag "${t}" survived into the published tags` });
        }
      }
    }

    // Links and embeds. In a correct projection EVERY wikilink resolves inside
    // content/ — an unresolved one renders its target's title, which is the leak.
    for (const m of body.matchAll(WIKILINK_RE)) {
      const embed = m[1] === '!';
      const target = targetOf(m[2]);
      if (!target) continue;
      const ext = extOf(target);

      if (embed && ASSET_EXT.has(ext)) {
        const name = target.split('/').pop()!;
        if (!present.has(name)) {
          findings.push({ file, message: `embeds missing asset "${name}" — a broken embed in public output` });
        }
        continue;
      }

      const base = target.endsWith('.md') ? target.slice(0, -3) : target;
      if (!noteBasenames.has(base)) {
        findings.push({ file, message: `links to [[${base}]], which is not published — a dangling wikilink RENDERS THE TITLE, which is the leak this gate exists to stop` });
      }
    }

    // Relative markdown images (assets the mirror copied flat alongside the note).
    for (const m of body.matchAll(MD_IMAGE_RE)) {
      const url = m[1];
      if (/^(https?:)?\/\//.test(url) || url.startsWith('data:') || url.startsWith('#')) continue;
      const name = decodeURIComponent(url.split('/').pop()!.split('?')[0]);
      if (name && !present.has(name)) {
        findings.push({ file, message: `references missing local file "${name}"` });
      }
    }
  }

  // --- report ------------------------------------------------------------------
  for (const w of warnings) console.log(`⚠ ${w}`);
  if (warnings.length) console.log('');

  if (findings.length) {
    console.error(`✗ publish gate FAILED — ${findings.length} finding(s) in the committed projection:\n`);
    for (const f of findings) console.error(`  ${f.file}: ${f.message}`);
    console.error('\nThe deploy is blocked. Re-run the publish tool, or fix the note and re-project.');
    process.exit(1);
  }

  console.log(`✓ publish gate passed — ${notes.length} note(s), no leaks, no dangling references.`);
}

main();
