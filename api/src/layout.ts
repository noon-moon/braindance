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
`;

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function layout(title: string, body: Html | string): Html {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="shortcut icon" href="/favicon.png" />
  <link rel="apple-touch-icon" href="/favicon.png" />
  <style>${raw(STYLE)}</style>
</head>
<body>
  <header class="bar">
    <a href="/" class="brand">braindance</a>
    <nav><a href="/">capture</a><a href="/vault">vault</a><a href="/review">review</a><a href="/history">history</a></nav>
  </header>
  <main>${body}</main>
</body>
</html>`;
}
