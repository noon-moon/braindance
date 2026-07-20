import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

// TUI-minimalist: monospace, one accent, structure over chrome. Dark default,
// light via prefers-color-scheme. See [[Braindance Admin App]] "Design system".
const STYLE = `
:root {
  --bg:#0b0e0f; --surface:#12161a; --border:#232a30; --fg:#d7dee3;
  --muted:#7c8894; --accent:#5ef2b8; --danger:#f2685e;
  color-scheme: dark light;
}
@media (prefers-color-scheme: light) {
  :root { --bg:#faf8f8; --surface:#fff; --border:#e2e2e2; --fg:#22262a;
          --muted:#6b7480; --accent:#0b8f63; --danger:#c0392b; }
}
* { box-sizing:border-box; min-width:0; }
html { overflow-x:hidden; }
body {
  margin:0; background:var(--bg); color:var(--fg); overflow-wrap:break-word;
  font:15px/1.5 ui-monospace,"SF Mono",SFMono-Regular,Menlo,"Cascadia Code",Consolas,monospace;
}
a { color:var(--fg); text-decoration:none; overflow-wrap:break-word; }
a:hover { color:var(--accent); }
.bar {
  position:sticky; top:0; display:flex; gap:1rem; align-items:baseline;
  padding:.5rem .7rem; border-bottom:1px solid var(--border);
  background:var(--bg); z-index:5;
}
.bar .brand { color:var(--accent); font-weight:600; }
.bar nav { display:flex; gap:.9rem; }
main { width:100%; max-width:64rem; margin:0 auto; padding:.7rem .7rem 2rem; }
h1,h2,h3 { line-height:1.2; margin:.7rem 0 .4rem; }
h1 { font-size:1.3rem; }
main > :first-child, .note-body > :first-child { margin-top:0; }
p { margin:.5rem 0; }
.muted { color:var(--muted); }
.card {
  display:block; border:1px solid var(--border); border-radius:5px;
  padding:.55rem .7rem; margin:.35rem 0; background:var(--surface);
}
a.card:hover { border-color:var(--accent); }
.grid { display:grid; gap:.4rem; grid-template-columns:repeat(auto-fill,minmax(8rem,1fr)); }
.btn {
  display:inline-block; border:1px solid var(--border); border-radius:4px;
  padding:.45rem .8rem; background:transparent; color:var(--fg);
  font:inherit; cursor:pointer;
}
.btn:hover { border-color:var(--accent); color:var(--accent); }
label { display:block; margin:.6rem 0 .2rem; color:var(--muted); font-size:.85rem; }
input,select,textarea {
  width:100%; max-width:100%; padding:.5rem; background:var(--bg); color:var(--fg);
  border:1px solid var(--border); border-radius:4px; font:inherit;
}
textarea { min-height:7rem; resize:vertical; }
input:focus,select:focus,textarea:focus { outline:none; border-color:var(--accent); }
.req { color:var(--danger); }
hr { border:none; border-top:1px solid var(--border); margin:1rem 0; }
.note-body { overflow-wrap:break-word; word-break:break-word; }
.note-body pre { background:var(--surface); border:1px solid var(--border); border-radius:4px; padding:.6rem; max-width:100%; overflow-x:auto; }
.note-body code { background:var(--surface); padding:.1em .3em; border-radius:3px; }
.note-body pre code { background:none; padding:0; }
.note-body img { max-width:100%; height:auto; }
.note-body table { display:block; max-width:100%; overflow-x:auto; }
.note-body a.wikilink.broken { color:var(--danger); border-bottom:1px dotted var(--danger); }
.meta { color:var(--muted); font-size:.85rem; margin:.2rem 0 .8rem; }
.tag { display:inline-block; border:1px solid var(--border); border-radius:3px; padding:0 .4em; margin-right:.3em; font-size:.8rem; color:var(--muted); }
.flash { border:1px solid var(--accent); border-radius:4px; padding:.55rem .8rem; margin-bottom:.8rem; color:var(--accent); }
.flash.err { border-color:var(--danger); color:var(--danger); }
.op { border:1px solid var(--border); border-radius:5px; padding:.55rem .7rem; margin:.35rem 0; background:var(--surface); display:flex; justify-content:space-between; gap:.7rem; align-items:flex-start; }
.op .msg { overflow-wrap:anywhere; }
.op form { margin:0; flex:none; }
.op .btn.danger:hover { border-color:var(--danger); color:var(--danger); }
.btn.danger:hover { border-color:var(--danger); color:var(--danger); }
ul.changeset { list-style:none; padding:0; margin:.45rem 0; }
ul.changeset li { padding:.15rem 0; overflow-wrap:anywhere; }
ul.changeset .put { color:var(--accent); }
ul.changeset .del { color:var(--danger); }
.actions { display:flex; gap:.5rem; margin-top:.55rem; flex-wrap:wrap; align-items:center; }
.actions form { margin:0; }
.sendback { display:flex; gap:.5rem; margin-top:.5rem; }
.sendback input { flex:1; }
details.diff { margin:.2rem 0 .1rem; }
details.diff summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
details.diff pre { background:var(--bg); border:1px solid var(--border); border-radius:4px; padding:.5rem; max-width:100%; overflow-x:auto; margin:.3rem 0 0; }
.dataview-skipped { opacity:.6; }
ul.notes { list-style:none; padding:0; margin:.5rem 0; }
ul.notes li { padding:.2rem 0; border-bottom:1px solid var(--border); overflow-wrap:break-word; }
.bar { align-items:center; }
.bar nav { display:flex; gap:1.15rem; align-items:center; }
.bar nav a { display:flex; align-items:center; color:var(--muted); border-bottom:3px solid transparent; padding-bottom:.12rem; }
.bar nav a:hover { color:var(--fg); }
.bar nav a.nav-active { color:var(--accent); border-bottom-color:var(--accent); }
.bar nav .ic { width:1.5rem; height:1.5rem; fill:currentColor; display:block; }
/* Desktop: text labels, icons hidden. */
.bar nav a .nav-ic { display:none; }
.bar nav a .nav-tx { display:inline; }
/* Mobile: icon tab bar pinned to the BOTTOM, brand hidden. */
@media (max-width: 640px) {
  .bar { position:fixed; top:auto; bottom:0; left:0; right:0; justify-content:space-around;
         border-top:1px solid var(--border); border-bottom:none;
         padding:.35rem .2rem; padding-bottom:calc(.35rem + env(safe-area-inset-bottom, 0px)); }
  .bar .brand { display:none; }
  .bar nav { flex:1; justify-content:space-around; gap:0; }
  .bar nav a { flex-direction:column; padding:.25rem .7rem 0;
               border-bottom:none; border-top:3px solid transparent; }
  .bar nav a.nav-active { border-bottom-color:transparent; border-top-color:var(--accent); }
  .bar nav a .nav-ic { display:block; }
  .bar nav a .nav-tx { display:none; }
  main { padding-bottom:calc(4.5rem + env(safe-area-inset-bottom, 0px)); }
}
`;

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

// Inline MUI (Material Icons) SVGs — self-contained, no external font/CDN.
const svg = (paths: string) =>
  raw(`<svg class="ic" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">${paths}</svg>`);
const ICON: Record<string, ReturnType<typeof svg>> = {
  inbox: svg('<path d="M19 3H4.99c-1.11 0-1.98.89-1.98 2L3 19c0 1.1.88 2 1.99 2H19c1.1 0 2-.9 2-2V5a2 2 0 0 0-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10z"/>'),
  book: svg('<path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/>'),
  search: svg('<path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5A6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5S14 7.01 14 9.5S11.99 14 9.5 14z"/>'),
  clock: svg('<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8s8 3.58 8 8s-3.58 8-8 8z"/><path d="M12.5 7H11v6l5.25 3.15l.75-1.23l-4.5-2.67z"/>'),
};

/** `active` marks the current tab (capture | vault | review | history). */
export function layout(title: string, body: Html | string, active?: string): Html {
  const nav = (id: string, href: string, icon: keyof typeof ICON) =>
    html`<a href="${href}" class="${active === id ? "nav-active" : ""}" title="${id}" aria-label="${id}"><span class="nav-ic">${ICON[icon]}</span><span class="nav-tx">${id}</span></a>`;
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${title}</title>
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="shortcut icon" href="/favicon.png" />
  <link rel="apple-touch-icon" href="/favicon.png" />
  <style>${raw(STYLE)}</style>
</head>
<body>
  <header class="bar">
    <a href="/" class="brand">braindance</a>
    <nav>${nav("capture", "/", "inbox")}${nav("vault", "/vault", "book")}${nav("review", "/review", "search")}${nav("history", "/history", "clock")}</nav>
  </header>
  <main>${body}</main>
</body>
</html>`;
}
