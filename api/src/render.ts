// Render a vault note's markdown to HTML: resolve [[wikilinks]] to viewer links
// (broken ones flagged), embeds to links, and degrade ```dataview blocks (the
// Phase 3 subset engine is not built yet). html:true is safe here — admin-only,
// reading your own vault over Tailscale.
import MarkdownIt from "markdown-it";
import { noteExists } from "./vault.js";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const escAttr = (s: string): string => s.replace(/"/g, "&quot;").replace(/</g, "&lt;");

function resolveWikilinks(markdown: string): string {
  // dataview fences -> a muted placeholder (engine deferred)
  let out = markdown.replace(
    /```dataview[\s\S]*?```/g,
    "\n<p class=\"dataview-skipped muted\">— dataview view (open in Obsidian) —</p>\n",
  );
  out = out.replace(/(!?)\[\[([^\]]+)\]\]/g, (_m, bang: string, inner: string) => {
    const [targetRaw, alias] = inner.split("|");
    const target = targetRaw.split("#")[0].trim();
    const text = (alias ?? targetRaw).trim();
    const href = `/vault/${encodeURIComponent(target)}`;
    if (bang === "!") return `[${text} ⧉](${href})`; // embeds -> link for v1
    const cls = noteExists(target) ? "wikilink" : "wikilink broken";
    return `<a class="${cls}" href="${escAttr(href)}">${text}</a>`;
  });
  return out;
}

export const renderMarkdown = (body: string): string =>
  md.render(resolveWikilinks(body));
