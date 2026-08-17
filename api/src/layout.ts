import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

// TUI-minimalist: monospace, one accent, structure over chrome. Dark default,
// light via prefers-color-scheme. See [[Braindance Admin App]] "Design system".
const STYLE = `
:root {
  --bg:#0b0e0f; --surface:#12161a; --border:#232a30; --fg:#d7dee3;
  --muted:#7c8894; --accent:#5ef2b8; --danger:#f2685e; --link:#8ab4ff;
  color-scheme: dark light;
}
@media (prefers-color-scheme: light) {
  :root { --bg:#faf8f8; --surface:#fff; --border:#e2e2e2; --fg:#22262a;
          --muted:#6b7480; --accent:#0b8f63; --danger:#c0392b; --link:#3352cc; }
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
/* An inline checkbox: the box, then its own label to the right of it. Used by the
   scope type's "capture destination" toggle, and shaped like the capture screen's
   task toggle so the one affordance reads the same in both places. */
.check { display:flex; align-items:center; gap:.45rem; margin:.7rem 0 0; }
.check input { width:auto; margin:0; accent-color:var(--accent); }
.check label { margin:0; color:var(--fg); font-size:.9rem; cursor:pointer; }
/* The type dropdown now LEADS the pane — it decides what every control under it
   is — so it reads as a heading rather than as one more field in the stack. */
select.type-pick { margin-bottom:.9rem; color:var(--accent); }
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
/* The pane is being swapped in place (DESK_JS). Just enough to say "this is
   about to be something else" — a spinner over a pane that is usually replaced
   in a few dozen milliseconds is a flash of chrome, not feedback. */
.desk-detail[aria-busy="true"] { opacity:.5; }
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
/* Links inside PROSE, and deliberately nowhere else. Everywhere else in this
   app an <a> is a control — a nav tab, a queue row, a tag, a path chip — and
   colouring those would light the whole chrome up in blue. Inside a note the
   opposite was true: a [[wikilink]] sat at --fg, indistinguishable from the
   sentence around it until you happened to mouse over it, which is not a thing
   you do while reading.
   Colour ALONE would fail on a monochrome display or for a colour-blind reader
   (WCAG 1.4.1), so the underline carries the same information — faint enough at
   40% not to fight a paragraph full of them, solid on hover. */
.note-body a, .sug-why a, p.dataview-skipped a {
  color:var(--link);
  text-decoration:underline;
  text-decoration-thickness:1px;
  text-underline-offset:2px;
  text-decoration-color:color-mix(in srgb, var(--link) 40%, transparent);
}
.note-body a:hover, .sug-why a:hover, p.dataview-skipped a:hover {
  color:var(--accent); text-decoration-color:var(--accent);
}
/* A tag chip inside a note body is a chip, not prose — it keeps its own look. */
.note-body a.tag { color:var(--muted); text-decoration:none; }
.note-body a.tag:hover { color:var(--accent); }
.note-body { overflow-wrap:break-word; word-break:break-word; }
.note-body pre { background:var(--surface); border:1px solid var(--border); border-radius:4px; padding:.6rem; max-width:100%; overflow-x:auto; }
.note-body code { background:var(--surface); padding:.1em .3em; border-radius:3px; }
.note-body pre code { background:none; padding:0; }
.note-body img { max-width:100%; height:auto; }
.note-body table { display:block; max-width:100%; overflow-x:auto; }
/* A wikilink to a note that doesn't exist. Same underline as any other prose
   link so it still reads as a link, but dashed and in --danger: the shape says
   "link", the styling says "goes nowhere". (Was a border-bottom, which now
   double-underlines against the prose-link rule above.) */
.note-body a.wikilink.broken {
  color:var(--danger);
  text-decoration:underline dashed;
  text-decoration-thickness:1px;
  text-underline-offset:2px;
  text-decoration-color:var(--danger);
}
.note-body a.wikilink.broken:hover { color:var(--danger); text-decoration-color:var(--danger); }
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
/* The vault filter. Sticky because the list runs to hundreds of rows and a
   filter you have to scroll back up to reach is one you stop using. */
.v-search { display:flex; gap:.5rem; position:sticky; top:3.2rem; z-index:4;
            background:var(--bg); padding:.4rem 0 .5rem; margin:0; }
.v-search .v-q { flex:1; }
.v-search .btn { flex:none; }
.v-empty { margin:.6rem 0; }
@media (max-width: 640px) {
  /* The nav is a bottom tab bar on a phone, so nothing occupies the top edge. */
  .v-search { top:0; }
}
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
 *  It is also RE-RUNNABLE, and published as `window.bdScopePick(root)`: the desk
 *  swaps its right pane in place (DESK_JS below), so scope fields arrive in the
 *  document long after load and something has to upgrade them. Idempotence is
 *  what makes that safe to call with no argument, over the whole document, at any
 *  time.
 *
 *  It never posts anything itself. The original input stays in the DOM, keeps its
 *  `name`, and the chips only ever write its `value` — so the server sees the
 *  same comma-separated string whether or not any of this ran, and `parseScopes`
 *  remains the single definition of what that string means. */
const SCOPE_PICK_JS = String.raw`
(function () {
  var esc = function (s) { return s.replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  function scan(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll("input.scope-in"), function (hidden) {
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
  }

  function enhance(hidden) {
    var all = (hidden.dataset.scopes || "").split("|").filter(Boolean);
    // A single-value field holds ONE scope — the note a TODO's atom is appended
    // to. The cap is read off the field rather than inferred, and it is enforced
    // here as well as on the server: a picker that lets you add a second chip and
    // then silently drops it is worse than one that cannot.
    var single = hidden.dataset.single === "1";
    var picked = hidden.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (single) picked = picked.slice(0, 1);
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
      // A full single-value field has nothing left to type into — remove the
      // chip to change it. Leaving the box open would offer an action that
      // silently does nothing.
      type.style.display = single && picked.length ? "none" : "";
    }
    function close() { menu.hidden = true; hits = []; cursor = -1; }
    function add(s) {
      // The same sanitising as parseScopes on the server, for the same reason:
      // these characters would break out of the [[…]] they end up inside.
      s = s.replace(/[[\]|#]/g, " ").replace(/\s+/g, " ").trim();
      if (s && single) picked = [s];
      else if (s && picked.indexOf(s) < 0) picked.push(s);
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

  // Published for DESK_JS, which swaps panes containing scope fields long after
  // this ran. Set BEFORE the first scan so a throw in one field can't leave the
  // desk with no way to upgrade the next one.
  window.bdScopePick = scan;
  scan(document);
})();
`;

/** The desk's second enhancement: picking a queue row swaps the RIGHT pane only,
 *  instead of navigating the whole page.
 *
 *  Selection has always ridden the URL (`?note=`), which is what made a two-pane
 *  desk possible with no client state at all — but it also meant every pick was a
 *  full document load, and the left rail was rebuilt from scratch each time. On a
 *  queue long enough to scroll (which is every queue that needs triaging) that
 *  threw away your place in the list on every single pick: you scrolled back down
 *  to where you were, picked the next one, and lost it again.
 *
 *  So this keeps the model and changes only the delivery. The URL still decides
 *  what is selected, the server still renders both panes, back/forward still work,
 *  and a shared link still resolves — the response's `.desk-detail` is simply
 *  lifted out and swapped in, leaving the queue's DOM (and therefore its scroll)
 *  untouched. With scripting off every one of those links is an ordinary anchor
 *  and the desk behaves exactly as it did before.
 *
 *  Anything that CHANGES the vault is left alone: filing and discarding are POSTs
 *  that redirect, because a note that filed has left the queue and the rail has to
 *  be rebuilt. This only intercepts reads. */
const DESK_JS = String.raw`
(function () {
  var desk = document.querySelector(".desk");
  if (!desk || !window.fetch || !window.DOMParser || !history.pushState) return;
  var detail = desk.querySelector(".desk-detail");
  var queue = desk.querySelector(".queue");
  if (!detail) return;

  var noteOf = function (url) {
    try { return new URL(url, location.href).searchParams.get("note"); } catch (e) { return null; }
  };

  // The rail is not re-rendered, so the selected row is re-marked by hand. Rows
  // are matched on the note name in their own href rather than on the string of
  // the URL, so an equivalent-but-differently-encoded link still lands.
  function select(url) {
    var note = noteOf(url);
    Array.prototype.forEach.call(desk.querySelectorAll("a.q-row"), function (a) {
      a.classList.toggle("sel", !!note && noteOf(a.getAttribute("href")) === note);
    });
    desk.classList.toggle("picked", !!note);
  }

  // The receipt line lives above the desk, not in the pane, so it is swapped
  // separately — otherwise a stale ?note= would answer with an empty pane and no
  // reason given. Direct children of <main> only: a pane's own validation error
  // is also a .flash, and it arrives with the pane.
  function flash(doc) {
    var now = document.querySelector("main > p.flash");
    var next = doc.querySelector("main > p.flash");
    if (now && next) now.replaceWith(next);
    else if (now) now.remove();
    else if (next) { var h = document.querySelector("main > h1"); if (h) h.insertAdjacentElement("afterend", next); }
  }

  // Re-attach behaviour to a freshly-swapped pane. The type dropdown ships with
  // an inline onchange as its no-JS path; that attribute is REMOVED here rather
  // than competing with the listener, since it would navigate away before this
  // ever ran.
  function wire(root) {
    Array.prototype.forEach.call(root.querySelectorAll("select.type-pick"), function (sel) {
      sel.removeAttribute("onchange");
      sel.onchange = function () {
        go(sel.dataset.here + "&funnel=" + encodeURIComponent(sel.value), true);
      };
    });
    if (window.bdScopePick) window.bdScopePick(root);
  }

  // Last request wins: picking three rows quickly must not leave whichever
  // response happened to be slowest on screen.
  var seq = 0;
  function go(url, push) {
    var mine = ++seq;
    detail.setAttribute("aria-busy", "true");
    fetch(url, { headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        if (mine !== seq) return;
        var doc = new DOMParser().parseFromString(text, "text/html");
        var next = doc.querySelector(".desk-detail");
        if (!next) throw new Error("no pane in response");
        detail.innerHTML = next.innerHTML;
        flash(doc);
        if (doc.title) document.title = doc.title;
        if (push) history.pushState({ desk: 1 }, "", url);
        select(url);
        wire(detail);
        detail.removeAttribute("aria-busy");
        // On a phone the two panes are one screen at a time (.desk.picked hides
        // the queue), so the pane that just replaced the list has to start at its
        // top. On a desktop both are on screen and scrolling anything is the very
        // thing this exists to avoid — hence the test is "is the queue actually
        // visible", not a width.
        if (queue && !queue.offsetParent) window.scrollTo(0, 0);
      })
      .catch(function (e) {
        if (window.console) console.error("desk swap failed, falling back:", e);
        location.href = url;
      });
  }

  document.addEventListener("click", function (e) {
    // Modified clicks belong to the browser: new tab, download, context menu.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest("a.q-row, a.desk-back");
    if (!a || !desk.contains(a)) return;
    e.preventDefault();
    go(a.getAttribute("href"), true);
  });

  // The suggestion card's "apply" is a GET form back to this same page, so it is
  // a read like any other and swaps in place. Its sibling "apply & file" is a
  // POST and is deliberately not matched here.
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || !desk.contains(f) || (f.method || "").toLowerCase() !== "get") return;
    if ((f.getAttribute("action") || "").split("?")[0] !== "/review") return;
    e.preventDefault();
    var q = new URLSearchParams(new FormData(f)).toString();
    go("/review" + (q ? "?" + q : ""), true);
  });

  window.addEventListener("popstate", function () { go(location.href, false); });

  wire(detail);
})();
`;

/** The vault list's filter, upgraded from "submit and reload" to "filters as you
 *  type". Like every script here it is an ENHANCEMENT: the form is a real GET to
 *  `/vault?q=`, the server marks non-matching rows `hidden`, and with scripting
 *  off that is already a working filter — so this only removes the round trip.
 *
 *  It reads the same `data-hay` string the server matched on and applies the
 *  same every-term rule, because a filter that disagrees with its own URL is
 *  worse than no filter: you would share a link that showed someone else a
 *  different list. */
const VAULT_FILTER_JS = String.raw`
(function () {
  var form = document.querySelector("form.v-search");
  var list = document.querySelector("ul.notes");
  if (!form || !list) return;
  var input = form.querySelector("input.v-q");
  var count = document.querySelector(".v-count");
  var total = document.querySelector(".v-total");
  var empty = document.querySelector(".v-empty");
  if (!input) return;
  var rows = Array.prototype.slice.call(list.querySelectorAll("li[data-hay]"));
  if (!rows.length) return;

  function apply(push) {
    var q = input.value.trim();
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var hay = rows[i].getAttribute("data-hay") || "";
      var hit = true;
      for (var t = 0; t < terms.length; t++) {
        if (hay.indexOf(terms[t]) < 0) { hit = false; break; }
      }
      rows[i].hidden = !hit;
      if (hit) n++;
    }
    if (count) count.textContent = String(n);
    if (total) total.textContent = n === rows.length ? "" : " of " + rows.length;
    if (empty) empty.hidden = n !== 0;
    // Keep the URL honest so the address bar is always shareable — replace
    // rather than push, so a filtered browse doesn't bury the back button under
    // one history entry per keystroke.
    if (push && window.history && history.replaceState) {
      history.replaceState(null, "", q ? "/vault?q=" + encodeURIComponent(q) : "/vault");
    }
  }

  // The submit button keeps working (it just no longer reloads), so a phone
  // keyboard's "go" key does the obvious thing.
  form.addEventListener("submit", function (e) { e.preventDefault(); apply(true); input.blur(); });
  input.addEventListener("input", function () { apply(true); });
  // A type-ahead over 889 rows is instant, but the browser's own clear button
  // (type=search) fires 'search', not 'input', in some engines.
  input.addEventListener("search", function () { apply(true); });
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
  <script>${raw(DESK_JS)}</script>
  <script>${raw(VAULT_FILTER_JS)}</script>
</body>
</html>`;
}
