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

// --scrub mode: downgrade links to private notes to plain text (prefer the alias),
// so a bulk publish doesn't hard-fail. Bare-title scrub still surfaces the title,
// so this is opt-in — the default is to block (see publish.ts).
export function scrubPrivateLinks(body: string, privateSet: Set<string>): string {
  return body.replace(WIKILINK_RE, (full, bang, inner) => {
    if (bang === '!') return full; // leave embeds
    const base = stripMdExt(targetOf(inner));
    if (!privateSet.has(base)) return full;
    return inner.includes('|') ? inner.split('|').slice(1).join('|').trim() : base;
  });
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
