// Transform a private note's body/frontmatter into a publishable form:
// strip internal scaffolding, classify cross-domain links, whitelist frontmatter.

// Frontmatter keys that may survive into the public garden. Everything else is
// dropped — a whitelist, so a new private field can never leak by omission.
// Notably absent: Contains / Contained By (leak private titles), status / due /
// completed / processed (todo machinery), publish (the internal selector).
export const FM_WHITELIST = new Set(['tags', 'topic', 'url', 'aliases', 'title', 'date']);

// Internal taxonomy tags — stripped from the published `tags` list.
export const STRUCTURAL_TAGS = new Set([
  'publish', 'memo', 'scope', 'todo', 'recurring', 'daily', 'reference', 'read', 'watch',
]);

const ASSET_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif',
  'pdf', 'mp4', 'mov', 'webm', 'mp3', 'wav',
]);

// [[Note]] / [[Note#h|alias]] / ![[embed]] / ![[img.png]]
const WIKILINK_RE = /(!?)\[\[([^\]]+)\]\]/g;

export interface LinkClass {
  assets: string[]; // asset refs (basename) via ![[img.ext]]
  privateLinks: string[]; // note links to unpublished vault notes — the leak vector
  publicLinks: string[];
  unresolved: string[]; // link to no known vault note — a dangling link, not a leak
}

function targetOf(inner: string): string {
  return inner.split('|')[0].split('#')[0].trim();
}

function isAssetRef(embed: boolean, target: string): boolean {
  if (!embed) return false;
  const ext = target.includes('.') ? target.split('.').pop()!.toLowerCase() : '';
  return ASSET_EXT.has(ext);
}

function stripMdExt(t: string): string {
  return t.endsWith('.md') ? t.slice(0, -3) : t;
}

export function classifyLinks(
  body: string,
  index: Map<string, unknown>,
  published: Set<string>,
): LinkClass {
  const res: LinkClass = { assets: [], privateLinks: [], publicLinks: [], unresolved: [] };
  for (const m of body.matchAll(WIKILINK_RE)) {
    const embed = m[1] === '!';
    const target = targetOf(m[2]);
    if (isAssetRef(embed, target)) {
      res.assets.push(target.split('/').pop()!);
      continue;
    }
    const base = stripMdExt(target);
    if (published.has(base)) res.publicLinks.push(base);
    else if (index.has(base)) res.privateLinks.push(base);
    else res.unresolved.push(base);
  }
  return res;
}

// Remove the internal note-taking scaffolding that would otherwise (a) leak
// private scope titles and (b) render as noise in the garden:
//   - fenced ```dataview blocks (Quartz can't run them; it does backlinks natively)
//   - leading preamble lines (Created:/Status:/Tags:/zettel-id) before the first heading
//   - a trailing backlinks section ("# References" or "# Connections")
export function stripScaffolding(body: string): string {
  let text = body.replace(/```dataview[\s\S]*?```/g, '');
  const lines = text.split('\n');

  const preambleMeta = /^(Created|Status|Tags|Tag|Aliases)\s*:/i;
  const zettelId = /^\d{6,}\s*$/;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === '') { i++; continue; }
    if (l.startsWith('#')) break; // first content heading — stop stripping preamble
    if (preambleMeta.test(l) || zettelId.test(l)) { i++; continue; }
    break; // real content before any heading — leave it alone
  }
  let out = lines.slice(i);

  // vault backlinks sections are headed "References" or "Connections"
  const refIdx = out.findIndex((l) => /^#{1,6}\s*(References|Connections)\b/i.test(l.trim()));
  if (refIdx !== -1) {
    let end = refIdx;
    while (end - 1 >= 0 && (out[end - 1].trim() === '' || out[end - 1].trim() === '---')) end--;
    out = out.slice(0, end);
  }
  return out.join('\n').trim() + '\n';
}

// Rewrite asset embeds to their basename so they resolve against the flat copy
// the mirror writes into garden/content/ (e.g. ![[assets/x.png]] -> ![[x.png]]).
export function normalizeAssetEmbeds(body: string): string {
  return body.replace(WIKILINK_RE, (full, bang, inner) => {
    if (bang !== '!') return full;
    const target = targetOf(inner);
    if (!isAssetRef(true, target)) return full;
    const base = target.split('/').pop()!;
    const suffix = inner.includes('|') ? '|' + inner.split('|').slice(1).join('|') : '';
    return `![[${base}${suffix}]]`;
  });
}

// --scrub mode: downgrade links AND transclusions of private notes to plain text
// (prefer the alias), so a bulk publish doesn't hard-fail. This covers both
// [[private note]] links and ![[private note]] embeds — a note embed must never
// survive as a raw transclusion directive (that would try to pull private content
// / leak the boundary), so its `!` is dropped and it becomes text like a link.
// Asset embeds (![[x.png]]) are left untouched here (handled by
// scrubMissingAssetEmbeds). Bare-title scrub still surfaces the title, so this is
// opt-in — the default is to block (see publish.ts).
export function scrubPrivateLinks(body: string, privateSet: Set<string>): string {
  return body.replace(WIKILINK_RE, (full, bang, inner) => {
    const target = targetOf(inner);
    if (bang === '!' && isAssetRef(true, target)) return full; // leave asset embeds
    const base = stripMdExt(target);
    if (!privateSet.has(base)) return full;
    return inner.includes('|') ? inner.split('|').slice(1).join('|').trim() : base;
  });
}

// --scrub mode: drop asset embeds (![[x.png]]) whose file couldn't be resolved,
// so a bulk publish proceeds instead of hard-failing. `missing` is the set of
// unresolvable asset basenames. Strict mode blocks these instead (see publish.ts).
export function scrubMissingAssetEmbeds(body: string, missing: Set<string>): string {
  return body.replace(WIKILINK_RE, (full, bang, inner) => {
    if (bang !== '!') return full;
    const target = targetOf(inner);
    if (!isAssetRef(true, target)) return full;
    const name = target.split('/').pop()!;
    return missing.has(name) ? '' : full;
  });
}

// Extract every wikilink/embed reference from a body, split into asset basenames
// (![[x.ext]]) and note basenames ([[x]] / ![[x]]). Used by verify.ts to audit
// the already-committed public projection without touching the vault.
export function extractRefs(body: string): { assets: string[]; notes: string[] } {
  const assets: string[] = [];
  const notes: string[] = [];
  for (const m of body.matchAll(WIKILINK_RE)) {
    const embed = m[1] === '!';
    const target = targetOf(m[2]);
    if (!target) continue; // e.g. [[#heading]] self-links — nothing to resolve
    if (isAssetRef(embed, target)) assets.push(target.split('/').pop()!);
    else notes.push(stripMdExt(target));
  }
  return { assets, notes };
}

export function whitelistFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!FM_WHITELIST.has(k)) continue;
    if (k === 'tags' && Array.isArray(v)) {
      const kept = v.filter((t) => !STRUCTURAL_TAGS.has(String(t)));
      if (kept.length) out[k] = kept;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function wordCount(body: string): number {
  return (body.trim().match(/\S+/g) || []).length;
}
