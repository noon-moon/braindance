// Render a vault note's markdown to HTML: resolve [[wikilinks]] to viewer links
// (broken ones flagged), embeds to links, and degrade ```dataview / ```tasks
// blocks (the Phase 3 Dataview subset engine is not built yet; ```tasks views are
// served for real by the /todo tab, so their placeholder points there).
// html:true is safe here — admin-only, reading your own vault over Tailscale.
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
  // ```tasks fences -> a placeholder linking to the tab that answers them for real.
  // Every scope note carries one (its command-center query), as do TODO and the
  // daily template, so leaving them as raw code blocks was noise on every page.
  out = out.replace(
    /```tasks[\s\S]*?```/g,
    "\n<p class=\"dataview-skipped muted\">— tasks view → <a href=\"/todo\">todo</a> —</p>\n",
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

/** Inline-only render (no wrapping <p>) — for a task line's text, which carries
 *  the same [[wikilinks]] and [md](links) as note prose but must stay on one row. */
export const renderInline = (text: string): string =>
  md.renderInline(resolveWikilinks(text));
