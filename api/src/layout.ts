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
/* The favicon IS the identity — the wordmark only repeated the tab title, and a
   monospace word next to icon-scale nav reads as a sixth tab. */
.bar .brand { display:flex; align-items:center; }
.bar .brand img { width:1.5rem; height:1.5rem; border-radius:3px; display:block; }
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
.capture-form, .triage-form { display:flex; flex-direction:column; }
/* Scope picker. Everything below only applies once SCOPE_PICK_JS has run and
   stamped .on — with scripting off the field is a plain text input and none of
   these rules match it, which is the whole point of the arrangement. */
.scope-pick { position:relative; }
.scope-pick.on .scope-in { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
.scope-box { display:flex; flex-wrap:wrap; align-items:center; gap:.3rem;
  padding:.3rem .4rem; margin:.35rem 0 .8rem; background:var(--surface);
  border:1px solid var(--border); border-radius:4px; cursor:text; }
.scope-box:focus-within { border-color:var(--accent); }
.scope-chip { display:inline-flex; align-items:center; gap:.35rem; padding:.05rem .2rem .05rem .45rem;
  border:1px solid var(--border); border-radius:3px; font-size:.85rem; background:var(--bg); }
/* An unknown chip is a scope the vault doesn't have — a renamed hub carried over
   on an old capture. It files (a wikilink to a missing note is legal, and is how
   Obsidian makes one), so this is a warning, not an error. */
.scope-chip.unknown { border-style:dashed; color:var(--muted); }
.scope-chip button { border:none; background:none; color:var(--muted); font:inherit;
  line-height:1; padding:.15rem .3rem; cursor:pointer; }
.scope-chip button:hover { color:var(--danger); }
.scope-box input.scope-type { flex:1; min-width:7rem; width:auto; margin:0; padding:.15rem;
  border:none; background:none; }
.scope-box input.scope-type:focus { outline:none; }
.scope-menu { position:absolute; z-index:15; left:0; right:0; margin:0; padding:.2rem;
  list-style:none; max-height:12rem; overflow-y:auto; background:var(--surface);
  border:1px solid var(--accent); border-radius:4px; box-shadow:0 4px 14px rgba(0,0,0,.35); }
.scope-menu li { padding:.3rem .45rem; border-radius:3px; cursor:pointer; font-size:.9rem; }
.scope-menu li[aria-selected="true"] { background:var(--bg); color:var(--accent); }
/* "this is a task" reveals due + priority. Pure CSS — every screen here works
   with scripting off (the one script this app ships only ENHANCES the scope
   field) — so the disclosure is the checkbox's own :checked state. */
.as-task { display:flex; align-items:center; gap:.45rem; margin:.7rem 0 0; }
.as-task input { width:auto; margin:0; accent-color:var(--accent); }
.as-task label { margin:0; color:var(--fg); font-size:.9rem; cursor:pointer; }
.task-fields { display:none; }
.capture-form:has(#as-task:checked) .task-fields { display:block; }
.cap-actions { display:flex; gap:.5rem; align-items:center; margin-top:.7rem; }
.cap-actions .btn { flex:1; }
h2.section { font-size:1rem; font-weight:600; color:var(--muted); margin:1.4rem 0 .4rem; }
h2.section:first-of-type { margin-top:.6rem; }
.snippet { margin:.25rem 0 0; white-space:pre-wrap; overflow-wrap:anywhere; }
a.tag:hover { border-color:var(--accent); color:var(--accent); }
/* ── /review — the triage desk ──────────────────────────────────────────────
   Queue left, the capture being worked right. Both panes come from ONE request
   (selection rides ?note= in the URL), so the layout is the only thing that
   has to decide what's on screen — and on a phone there is only room for one of
   them. .picked is server-rendered from that same query rather than sniffed with
   :has(), because the server already knows the answer and a class says so in one
   word. */
.desk { display:grid; gap:.9rem; margin:.6rem 0 1.4rem; }
@media (min-width: 720px) {
  .desk { grid-template-columns:minmax(13rem,20rem) 1fr; align-items:start; }
  /* The queue outlives any one note, so it stays put while the pane scrolls. */
  .queue { position:sticky; top:3.2rem; max-height:calc(100dvh - 4.5rem); overflow-y:auto; }
}
.q-list { list-style:none; padding:0; margin:0; }
.q-row {
  display:block; background:var(--surface); border:1px solid var(--border);
  border-left:3px solid var(--border); border-radius:4px;
  padding:.35rem .6rem; margin:.3rem 0;
}
.q-row:hover { border-left-color:var(--accent); }
.q-row.sel { border-color:var(--accent); }
.q-time { display:block; color:var(--muted); font-size:.75rem; }
.q-title { display:block; overflow-wrap:anywhere; }
.q-row.sel .q-title { color:var(--accent); }
.desk-empty { margin-top:1.6rem; }
/* The suggestion card. Deliberately quiet — a dashed border rather than the
   accent one an action gets, because this is a draft someone else wrote and the
   fields below it are still the source of truth. */
.suggest { margin:.7rem 0 .2rem; }
.card.sug { border-style:dashed; margin:0; }
.sug-head { font-size:.8rem; color:var(--accent); margin-bottom:.15rem; }
.sug-title { overflow-wrap:anywhere; }
.sug-meta { display:flex; flex-wrap:wrap; gap:.25rem; margin:.35rem 0 0; }
.sug-why { margin:.35rem 0 0; font-size:.85rem; }
.card.sug .actions { margin-top:.5rem; }
.card.sug .actions form { display:none; } /* the real forms are siblings of the pane */
.sug-none { margin:.7rem 0 .2rem; font-size:.85rem; }
/* Desktop keeps both panes on screen, so there is nothing to go back TO. */
.desk-back { display:none; }
@media (max-width: 640px) {
  /* One column, one pane: the queue until you pick something, the note after —
     which makes the desk read as the two screens it replaced, without being
     two round trips. .desk-back is the way out, since the queue is gone. */
  .desk.picked .queue { display:none; }
  .desk:not(.picked) .desk-detail { display:none; }
  .desk-back { display:inline-block; color:var(--muted); margin-bottom:.3rem; }
}
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
/* Capture confirmation. A capture redirects back to the form, so the receipt has
   to be transient — it floats over the page and dismisses itself in CSS (no
   scripting involved, and nothing left to clean up on the next navigation). */
.toast {
  position:fixed; top:.6rem; left:50%; transform:translateX(-50%); z-index:20;
  max-width:min(34rem,calc(100% - 1.4rem)); padding:.5rem .8rem;
  border:1px solid var(--accent); border-radius:4px; background:var(--surface);
  color:var(--accent); font-size:.85rem; overflow-wrap:anywhere;
  box-shadow:0 2px 12px rgba(0,0,0,.35);
  animation:toast-out .45s ease 4.5s forwards;
}
.toast.dup { border-color:var(--muted); color:var(--muted); }
@keyframes toast-out { to { opacity:0; visibility:hidden; } }
@media (prefers-reduced-motion: reduce) { .toast { animation-duration:.01s; } }
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
/* /todo — Reminders-style date sections over the vault's #task lines. */
.tg { margin:1.15rem 0 0; }
.tg:first-of-type { margin-top:.5rem; }
.tg > h2 { display:flex; gap:.5rem; align-items:baseline; font-size:1rem; margin:0;
           padding-bottom:.25rem; border-bottom:1px solid var(--border); }
.tg.overdue > h2 { color:var(--danger); }
.tg.today > h2 { color:var(--accent); }
.tg > h2 .n { color:var(--muted); font-weight:400; font-size:.85rem; }
/* Scope lens: the heading links to the scope note, and carries its own overdue
   count — a section is an area, and this is whether the area is behind. */
.tg > h2 a { color:inherit; }
.tg > h2 a:hover { color:var(--accent); }
.tg > h2 .late { font-weight:400; font-size:.85rem; }
.meta strong { color:var(--accent); font-weight:600; }
ul.tasks { list-style:none; padding:0; margin:0; }
ul.tasks li { display:flex; gap:.55rem; align-items:flex-start; padding:.45rem .1rem;
              border-bottom:1px solid var(--border); }
ul.tasks .box { flex:none; color:var(--muted); }
/* The checkbox is a submit button, not a script — strip the chrome and give it a
   thumb-sized hit area without moving the row's text. */
form.tick { flex:none; margin:-.35rem 0 -.35rem -.35rem; }
button.box { border:none; background:none; padding:.35rem; color:var(--muted);
             font:inherit; line-height:inherit; cursor:pointer; }
button.box:hover, button.box:focus-visible { color:var(--accent); outline:none; }
.tg.overdue button.box { color:var(--danger); }
.tg.overdue button.box:hover { color:var(--accent); }
ul.tasks .box[title]:not(button) { cursor:help; }
.toast.err { border-color:var(--danger); color:var(--danger); }
.tg.overdue ul.tasks .box { color:var(--danger); }
.t-main { flex:1; min-width:0; }
.t-text { overflow-wrap:anywhere; }
.t-meta { display:flex; flex-wrap:wrap; gap:.45rem; align-items:baseline;
          margin:.1rem 0 0; font-size:.8rem; color:var(--muted); }
.t-meta a { color:var(--muted); border-bottom:1px dotted var(--border); }
.t-meta a:hover { color:var(--accent); border-bottom-color:var(--accent); }
.t-meta .late { color:var(--danger); }
/* A timed atom reads as an appointment — the one thing on the row that isn't
   metadata about the task, but about the day. */
.t-meta .at { color:var(--fg); border:1px solid var(--border); border-radius:3px; padding:0 .35em; }
.pri { flex:none; font-size:.85rem; }
ul.tasks li.done .t-text { color:var(--muted); text-decoration:line-through; }
.todo-foot { margin-top:1.3rem; display:flex; gap:.9rem; align-items:center; flex-wrap:wrap; }
.todo-foot form { margin:0; }
/* "sync now" — deliberately quiet. It's a utility for when you've just pushed
   from the laptop and don't want to wait out the reconcile timer, not one of the
   page's actions, so it reads as muted text until you reach for it. */
.sync-btn { padding:.15rem .55rem; font-size:.85rem; color:var(--muted); }
.sync-btn:hover { color:var(--accent); }
/* Calendar lens. The grid carries DENSITY only — a dot per occurrence — because
   a phone cell can't hold text; the selected day's atoms render below it as an
   ordinary task list, tick buttons and all. */
.cal-head { display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin:.6rem 0 .5rem; }
.cal-head a { padding:.1rem .7rem; border:1px solid var(--border); border-radius:4px; }
.cal-head a:hover { border-color:var(--accent); }
.cal-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:2px; }
.cal-dow { text-align:center; font-size:.7rem; color:var(--muted); padding-bottom:.2rem; }
.cal-day {
  display:flex; flex-direction:column; align-items:center; gap:.15rem;
  min-height:2.9rem; padding:.25rem .1rem; border:1px solid transparent;
  border-radius:4px; background:var(--surface); color:var(--fg);
}
.cal-day:hover { border-color:var(--accent); color:var(--fg); }
.cal-day.out { background:transparent; color:var(--muted); opacity:.45; }
.cal-day.today .dnum { color:var(--accent); font-weight:600; }
.cal-day.sel { border-color:var(--accent); }
.cal-day .dnum { font-size:.8rem; line-height:1.1; }
.cal-day .dots { display:flex; flex-wrap:wrap; gap:2px; justify-content:center; }
.cal-day .dot { width:5px; height:5px; border-radius:50%; background:var(--accent); }
/* A computed occurrence is hollow — it has no line in the vault yet. */
.cal-day .dot.proj { background:transparent; box-shadow:inset 0 0 0 1px var(--accent); }
.cal-day.late .dot { background:var(--danger); }
.cal-day.late .dot.proj { background:transparent; box-shadow:inset 0 0 0 1px var(--danger); }
.cal-undated { margin-top:1rem; font-size:.85rem; }
ul.tasks li.projected .t-text { color:var(--muted); }
ul.tasks .box.proj { opacity:.45; cursor:help; }
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
  /* The form sits at the thumb, so the receipt does too — just above the tab bar
     rather than off at the top of the screen where it'd be missed. */
  .toast { top:auto; bottom:calc(3.6rem + env(safe-area-inset-bottom, 0px)); }
  /* Capture: anchor the form to the bottom so inputs build up from the thumb. */
  main:has(.capture-form) { display:flex; flex-direction:column; min-height:100dvh; }
  main:has(.capture-form) h1 { display:none; }
  .capture-form { margin-top:auto; }
}
`;

/** The ONE script this app ships, and it is an enhancement: it upgrades the scope
 *  field (`input.scope-in`, rendered by `control()`) from a comma-separated text
 *  box into chips with per-token type-ahead. Turn scripting off and every screen
 *  still works — the field is a plain input with a `<datalist>`, which is exactly
 *  what this replaces.
 *
 *  It runs on every page and finds nothing on most of them. That is deliberate:
 *  the alternative is a per-page conditional that has to know which templates
 *  contain a scope field, and the day it's wrong the picker silently stops being
 *  a picker. It is idempotent (`data-on`) for the same reason.
 *
 *  It never posts anything itself. The original input stays in the DOM, keeps its
 *  `name`, and the chips only ever write its `value` — so the server sees the
 *  same comma-separated string whether or not any of this ran, and `parseScopes`
 *  remains the single definition of what that string means. */
const SCOPE_PICK_JS = String.raw`
(function () {
  var esc = function (s) { return s.replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  Array.prototype.forEach.call(document.querySelectorAll("input.scope-in"), function (hidden) {
    if (hidden.dataset.on) return;
    hidden.dataset.on = "1";
    try { enhance(hidden); } catch (e) {
      // Whatever went wrong, the tier below still works — so put the field back
      // the way it was rendered rather than leaving a half-built picker. This is
      // the reason the field degrades at all: the enhancement is allowed to fail.
      hidden.classList.remove("scope-in");
      var w = hidden.closest(".scope-pick");
      if (w && w.parentNode) { w.parentNode.insertBefore(hidden, w); w.remove(); }
      if (window.console) console.error("scope picker disabled:", e);
    }
  });

  function enhance(hidden) {
    var all = (hidden.dataset.scopes || "").split("|").filter(Boolean);
    var picked = hidden.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var hits = [], cursor = -1;

    var wrap = document.createElement("div");
    wrap.className = "scope-pick on";
    hidden.parentNode.insertBefore(wrap, hidden);
    wrap.appendChild(hidden);
    var box = document.createElement("div");
    box.className = "scope-box";
    var type = document.createElement("input");
    type.type = "text"; type.className = "scope-type"; type.autocomplete = "off";
    type.setAttribute("aria-label", "add a scope");
    box.appendChild(type);
    var menu = document.createElement("ul");
    menu.className = "scope-menu"; menu.hidden = true; menu.setAttribute("role", "listbox");
    wrap.appendChild(box); wrap.appendChild(menu);

    function sync() {
      hidden.value = picked.join(", ");
      Array.prototype.forEach.call(box.querySelectorAll(".scope-chip"), function (c) { c.remove(); });
      picked.forEach(function (s, i) {
        var chip = document.createElement("span");
        chip.className = "scope-chip" + (all.indexOf(s) < 0 ? " unknown" : "");
        if (all.indexOf(s) < 0) chip.title = "no scope note by this name — it will file as a new link";
        chip.innerHTML = esc(s) + '<button type="button" tabindex="-1" aria-label="remove ' + esc(s) + '">×</button>';
        chip.querySelector("button").onclick = function () { picked.splice(i, 1); sync(); type.focus(); };
        box.insertBefore(chip, type);
      });
      type.placeholder = picked.length ? "" : (hidden.placeholder || "");
    }
    function close() { menu.hidden = true; hits = []; cursor = -1; }
    function add(s) {
      // The same sanitising as parseScopes on the server, for the same reason:
      // these characters would break out of the [[…]] they end up inside.
      s = s.replace(/[[\]|#]/g, " ").replace(/\s+/g, " ").trim();
      if (s && picked.indexOf(s) < 0) picked.push(s);
      type.value = ""; close(); sync();
    }
    function open() {
      var q = type.value.trim().toLowerCase();
      hits = all.filter(function (s) {
        return picked.indexOf(s) < 0 && (!q || s.toLowerCase().indexOf(q) >= 0);
      }).slice(0, 8);
      if (!hits.length) return close();
      cursor = 0;
      menu.innerHTML = hits.map(function (s, i) {
        return '<li role="option" aria-selected="' + (i === 0) + '">' + esc(s) + "</li>";
      }).join("");
      Array.prototype.forEach.call(menu.children, function (li, i) {
        // mousedown, not click: click fires after blur, and blur commits.
        li.onmousedown = function (e) { e.preventDefault(); add(hits[i]); type.focus(); };
      });
      menu.hidden = false;
    }
    function move(d) {
      if (menu.hidden) return open();
      cursor = (cursor + d + hits.length) % hits.length;
      Array.prototype.forEach.call(menu.children, function (li, i) {
        li.setAttribute("aria-selected", i === cursor);
      });
      menu.children[cursor].scrollIntoView({ block: "nearest" });
    }

    box.onclick = function (e) { if (e.target === box) type.focus(); };
    type.oninput = open;
    type.onfocus = open;
    type.onblur = function () { add(type.value); };
    type.onkeydown = function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Escape") { close(); }
      else if (e.key === "Backspace" && !type.value && picked.length) { picked.pop(); sync(); }
      else if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
        var pick = (!menu.hidden && cursor >= 0) ? hits[cursor] : type.value;
        if (!pick.trim()) { if (e.key === ",") e.preventDefault(); return; }
        // Enter here means "commit this chip", never "submit the form" — the one
        // key that would otherwise file a note the moment you finished naming a
        // scope. Tab keeps its own job and moves on, having committed.
        if (e.key !== "Tab") e.preventDefault();
        add(pick);
      }
    };
    sync();
    // Last, so that everything above having thrown leaves the tier below intact:
    // the datalist is the no-JS type-ahead and two dropdowns over one field is one
    // too many, but it only goes once there is something to replace it with.
    hidden.removeAttribute("list");
    // A visually-hidden required input is one the browser refuses to focus and
    // then refuses to submit past. The server already rejects a missing required
    // field and re-renders the form intact, so it carries this alone.
    hidden.required = false;
  }
})();
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
  checklist: svg('<path d="M22 7h-9v2h9V7zm0 8h-9v2h9v-2zM5.54 11L2 7.46l1.41-1.41l2.12 2.12l4.24-4.24l1.41 1.41L5.54 11zm0 8L2 15.46l1.41-1.41l2.12 2.12l4.24-4.24l1.41 1.41L5.54 19z"/>'),
};

/** `active` marks the current tab (capture | vault | todo | review | history). */
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
    <a href="/" class="brand"><img src="/favicon.png" alt="braindance"></a>
    <nav>${nav("capture", "/", "inbox")}${nav("vault", "/vault", "book")}${nav("todo", "/todo", "checklist")}${nav("review", "/review", "search")}${nav("history", "/history", "clock")}</nav>
  </header>
  <main>${body}</main>
  <script>${raw(SCOPE_PICK_JS)}</script>
</body>
</html>`;
}
