import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { layout } from "./layout.js";
import { FUNNELS, funnelById, compose, taskLine, appendTaskLine, scopeLink, parseScopes, type Field, type Funnel } from "./funnels.js";
import { commitCapture, createNote, stamp, slug } from "./notes.js";
import { VAULT_SUBDIR, vaultRel, aiSuggestConfig } from "./config.js";
import { suggestionFor, dropSidecar, type Suggestion } from "./suggest.js";
import { startSuggestWorker } from "./worker.js";
import { seenRecently, contentHash } from "./dedup.js";
import { randomUUID } from "node:crypto";
import { submitProposal, listProposals, getProposal, setStatus, updateProposal, type Proposal, type ProposalStatus } from "./proposals.js";
import { getScopes, getIngestableScopes, getNote, listNotes, backlinksFor, invalidate, noteExists, takenRootNames, readNoteRaw } from "./vault.js";
import { listInbox, getInboxNote, firstLine, type InboxNote } from "./inbox.js";
import { renderMarkdown, renderInline } from "./render.js";
import { gitStore } from "./git.js";
import { buildICS, icsOptionsFromEnv } from "./ics.js";
import { healthPayload } from "./health.js";
import {
  listTasks, groupByDue, completedTasks, todayISO, daysBetween, effectiveDate, parseTaskLine,
  canComplete, completeInFile, readTaskFile, groupByScope, timeSpan, addDays,
  occurrencesByDate, monthWindow, shiftMonth,
  type Task, type TaskGroup, type ScopeGroup, type Occurrence,
} from "./tasks.js";

const app = new Hono();

// ── Static assets ────────────────────────────────────────────────────────────
app.use("/favicon.png", serveStatic({ path: "./public/favicon.png" }));
app.use("/favicon.ico", serveStatic({ path: "./public/favicon.png" }));

// ── Capture: input form with a funnel-type dropdown (home) ──────────────────
function control(f: Field, scopes: string[], value = "") {
  const req = f.required ? raw(" required") : "";
  const ph = f.placeholder ?? "";
  const sel = (o: string) => (o === value ? raw(" selected") : "");
  if (f.type === "textarea") return html`<textarea name="${f.key}"${req} placeholder="${ph}">${value}</textarea>`;
  if (f.type === "select")
    return html`<select name="${f.key}"${req}>${f.required ? "" : html`<option value=""></option>`}${(f.options ?? []).map((o) => html`<option${sel(o)}>${o}</option>`)}</select>`;
  if (f.type === "scope") {
    // MANY scopes, comma-separated, over the live MOC list (every `scope`-tagged
    // note, alphabetical). They become the note's leading `Tags: [[A]] [[B]]` line,
    // so it hangs off every hub it belongs to — a thought rarely belongs to exactly
    // one area, and the old <select> made you pick the least wrong one. `_meta/`
    // scopes (scope_kind: system) never appear: the flat index only reads the root.
    //
    // This was a <select>, which constrained the value structurally. A text field
    // does not, so `parseScopes` sanitises on the way out and the filer checks each
    // name against the vault before it writes.
    //
    // THREE TIERS, each usable on its own:
    //   - no JS at all → a plain text input. Type `Loon, Music`. Works.
    //   - no JS + <datalist> → the browser's own type-ahead. Whole-field only (the
    //     spec has no notion of a token), so it completes the first scope and the
    //     rest is typing — which is why the third tier exists.
    //   - JS → chips + per-token type-ahead (scope-pick.js), which REPLACES the
    //     datalist rather than stacking with it (two dropdowns over one field).
    // Values that AREN'T live scopes (a carried-over capture whose MOC was since
    // renamed) stay in the field and lead the option list rather than vanishing.
    const cur = parseScopes(value);
    const opts = [...cur.filter((s) => !scopes.includes(s)), ...scopes];
    const list = `scope-opts-${f.key}`;
    // `|` separates the JS tier's option list because `parseScopes` strips it out
    // of every name, so it is the one character guaranteed not to be IN one.
    return html`<input type="text" name="${f.key}"${req} class="scope-in" list="${list}"
      autocomplete="off" autocapitalize="off" spellcheck="false"
      placeholder="${f.placeholder || (f.required ? "scope" : "scope — comma-separated, optional")}"
      value="${cur.join(", ")}" data-scopes="${opts.join("|")}"
      ><datalist id="${list}">${opts.map((s) => html`<option value="${s}"></option>`)}</datalist>`;
  }
  const t = f.type === "url" ? "url" : f.type === "date" ? "date" : f.type === "number" ? "number" : "text";
  return html`<input type="${t}" name="${f.key}"${req} placeholder="${ph}" value="${value}">`;
}

// The capture screen: ONE textarea + scope, and a task toggle over due/priority.
//
// There is deliberately no title field. Naming a thought is a decision, and it
// lands at the exact moment you're trying not to make one — so the note is named
// by its timestamp and titled at the desk, where you can actually see what it
// turned out to be. The review list labels it by its first line until then.
//
// Capture stays UNTYPED by default — a thought drops into the inbox as a raw
// memo and the media/resource sorting happens at triage. What capture time knows
// and the desk can only guess at is anything you can't reconstruct later:
//
//   - WHICH SCOPE the thought belongs to (lands as the leading `Tags: [[MOC]]`),
//   - whether it's a thought or an ACTION, and if so when it's due.
//
// So the one classification the form does offer is "this is a task", which
// reveals due + priority (pure CSS — every screen here works with scripting off)
// and captures a real
// `#task` atom instead of a memo. Everything stays optional: an untitled,
// scopeless, untyped thought still captures in one tap. (The full typed funnel
// schema still lives on the JSON /ingest API.)
//
// The screen never becomes a dead end: a capture posts, redirects, and lands back
// HERE with a self-dismissing toast (see POST /ingest), so consecutive thoughts
// go in without a tap in between. A rejected submission re-renders in place with
// its text intact — losing a typed thought to a validation error is the one
// failure this pipeline must not have.
interface CaptureView {
  /** Set when a capture just landed → success toast. Names the note by what was
   *  TYPED, not by its timestamped filename — the receipt has to read at a glance
   *  on a phone. Untitled memos (now the ordinary path) echo their first line, so
   *  the toast still confirms *which* thought went in. */
  ok?: { title: string };
  /** The capture was a de-dup no-op → neutral toast. */
  dup?: boolean;
  /** Submitted values to re-fill after a rejection. */
  values?: Record<string, string>;
  /** Re-open the task disclosure after a rejection, so the due date the user
   *  already picked isn't hidden behind a toggle that reset itself. */
  asTask?: boolean;
  error?: string;
}

function captureForm(v: CaptureView = {}) {
  const memo = funnelById("memo") ?? FUNNELS[0];
  const task = funnelById("task")!;
  // Only `ingestable` hubs here — a phone dropdown over every scope in the vault
  // is a scroll, not a pick. Triage still files into anything (triagePane).
  const scopes = getIngestableScopes();
  const val = (key: string) => v.values?.[key] ?? "";
  // Field specs come from the funnels themselves so labels, options and types
  // stay single-sourced — the form spans two funnels, and the toggle picks which
  // one the POST is validated against.
  // Requiredness here depends on the toggle — a memo needs a body, a task needs
  // its text — and no-JS HTML can't move a `required` attribute at tick time. So
  // the form asserts neither and the server decides; a rejection re-renders with
  // everything intact, which is what makes that safe.
  const field = (f: Field) => html`<label>${f.label}</label>${control({ ...f, required: false }, scopes, val(f.key))}`;
  const of = (fn: typeof memo, key: string) => fn.fields.find((x) => x.key === key)!;
  const toast = v.ok
    ? html`<div class="toast">✓ captured${v.ok.title ? html` → “${v.ok.title}”` : " to inbox"}</div>`
    : v.dup
      ? html`<div class="toast dup">↩ duplicate ignored — this matches a capture just made.</div>`
      : "";
  return layout(
    "capture",
    html`
      ${toast}
      <h1>capture</h1>
      ${v.error ? html`<p class="flash err">${v.error}</p>` : ""}
      <form method="post" action="/ingest" class="capture-form">
        <input type="hidden" name="idem" value="${randomUUID()}">
        <div class="cap-fields">
          ${field(of(memo, "body"))}
          ${field(of(memo, "scope"))}
        </div>
        <div class="as-task">
          <input type="checkbox" id="as-task" name="as_task" value="1"${v.asTask ? raw(" checked") : ""}>
          <label for="as-task">this is a task</label>
        </div>
        <div class="task-fields">
          ${field(of(task, "due"))}
          ${field(of(task, "priority"))}
        </div>
        <div class="cap-actions">
          <button class="btn" type="submit">capture</button>
        </div>
      </form>`,
    "capture",
  );
}

// `?ok=` (even empty) means "a capture just landed" — the toast is the receipt.
app.get("/", (c) => {
  const ok = c.req.query("ok");
  return c.html(captureForm({ ok: ok === undefined ? undefined : { title: ok }, dup: c.req.query("dup") === "1" }));
});
// old per-funnel URLs fold into the single untyped capture form
app.get("/new/:funnel", (c) => c.redirect("/"));

// Shared capture: validate → build → de-dup → commit. Used by the web form
// (HTML) and the JSON API alike, so both behave identically.
type CaptureResult =
  | { kind: "ok"; path: string; title: string }
  | { kind: "duplicate" }
  | { kind: "error"; message: string };

async function doCapture(funnelId: string, raw: Record<string, unknown>, idem?: string): Promise<CaptureResult> {
  const funnel = funnelById(funnelId);
  if (!funnel) return { kind: "error", message: "unknown funnel" };
  const input: Record<string, string> = {};
  for (const fl of funnel.fields) input[fl.key] = String(raw[fl.key] ?? "").trim();
  const missing = funnel.fields.filter((fl) => fl.required && !input[fl.key]).map((fl) => fl.label);
  if (missing.length) return { kind: "error", message: `missing required: ${missing.join(", ")}` };

  const note = funnel.build(input);
  const composed = compose(note);
  // De-dup: identical content (any source) or a re-POST carrying the same
  // idempotency token (form render, or a Shortcut's per-share UUID).
  const keys = [`hash:${funnel.id}:${contentHash(composed)}`, ...(idem ? [`idem:${idem}`] : [])];
  if (keys.some((k) => seenRecently(k))) return { kind: "duplicate" };

  // The stamp alone is a complete identity — it is unique, it sorts
  // chronologically, and it is what makes two concurrent captures unable to touch
  // the same file. The slug is only there to make a TITLED capture legible in a
  // directory listing, so an untitled one simply goes without rather than
  // carrying a `-note` placeholder that says nothing.
  const named = note.title ? `${stamp()}-${slug(note.title)}.md` : `${stamp()}.md`;
  const path = vaultRel(VAULT_SUBDIR, "inbox", named);
  await commitCapture(path, composed, `inbox: ${funnel.id} capture`);
  // What the toast echoes: the typed title, else the thought's opening words —
  // the same label the review list will show, so the receipt and the queue agree.
  // NO `max` argument: the agreement is the point, so the width is firstLine's to
  // decide and passing a second number here is how the two surfaces disagreed.
  return { kind: "ok", path, title: input.title || firstLine(input.body ?? "") };
}

/** On the capture screen the big textarea is where a thought actually gets
 *  typed, and the title is optional — so someone who writes into the body and
 *  THEN ticks "this is a task" would otherwise be rejected for a missing title
 *  they never meant to skip. Promote the body's first line to the atom and keep
 *  the rest as detail, the way a task capture reads everywhere else. Mutates the
 *  parsed body in place, before validation sees it. */
function splitTitleFromBody(raw: Record<string, unknown>): void {
  if (String(raw.title ?? "").trim()) return;
  const body = String(raw.body ?? "");
  const nl = body.indexOf("\n");
  raw.title = (nl === -1 ? body : body.slice(0, nl)).trim();
  raw.body = nl === -1 ? "" : body.slice(nl + 1).trim();
}

// ── Capture: ingest → inbox/ (web form → HTML; JSON body → JSON, for the iOS
//    Share Sheet shortcut & other programmatic callers) ────────────────────────
app.post("/ingest", async (c) => {
  const wantsJson = (c.req.header("content-type") ?? "").includes("application/json");
  const raw = (wantsJson
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody()) as Record<string, unknown>;
  // The web form carries no funnel id — its task toggle picks one. JSON callers
  // still name the funnel outright, so the typed schema is unchanged for them.
  const asTask = raw.as_task === "1" || raw.as_task === true;
  const funnelId = String(raw.funnel ?? (asTask ? "task" : "memo"));
  if (asTask && !wantsJson) splitTitleFromBody(raw);
  const idem = raw.idem ? String(raw.idem).trim() : undefined;
  const res = await doCapture(funnelId, raw, idem);

  if (wantsJson) {
    if (res.kind === "ok") return c.json({ status: "captured", path: res.path }, 201);
    if (res.kind === "duplicate") return c.json({ status: "duplicate" }, 200);
    return c.json({ error: res.message }, 400);
  }
  // Rejected: re-render the form with what was typed, rather than bouncing to a
  // dead end that drops it.
  if (res.kind === "error") {
    const funnel = funnelById(funnelId) ?? funnelById("memo")!;
    const values: Record<string, string> = {};
    for (const fl of funnel.fields) values[fl.key] = String(raw[fl.key] ?? "");
    return c.html(captureForm({ values, asTask, error: res.message }), 400);
  }
  // Post/redirect/get back to the capture screen — a reload can't re-submit, and
  // the next thought needs no "capture another" tap. The toast rides the query.
  const q = res.kind === "duplicate" ? "dup=1" : `ok=${encodeURIComponent(res.title)}`;
  return c.redirect(`/?${q}`, 303);
});

// ── Vault viewer ────────────────────────────────────────────────────────────
app.get("/vault", (c) => {
  const notes = listNotes();
  return c.html(layout("vault", html`
    <h1>vault <span class="muted">(${notes.length})</span></h1>
    <ul class="notes">
      ${notes.map((n) => html`<li><a href="/vault/${encodeURIComponent(n.name)}">${n.name}</a> ${n.tags.slice(0, 3).map((t) => html`<span class="tag">${t}</span>`)}</li>`)}
    </ul>`, "vault"));
});

app.get("/vault/:name", (c) => {
  const p = c.req.param("name");
  let name = p;
  try { name = decodeURIComponent(p); } catch { /* keep p */ }
  const note = getNote(name) ?? getNote(p);
  if (!note) {
    // Not a canonical root note — fall back to an untriaged inbox capture so
    // history/deep links resolve. Read-only, with a CTA into the triage desk.
    const inb = getInboxNote(name) ?? getInboxNote(p);
    if (inb) {
      return c.html(layout(inb.title, html`
        <h1>${inb.title}</h1>
        <div class="meta"><span class="tag">inbox · untriaged</span>${inb.createdISO ? html` ${fmtDate(inb.createdISO)}` : ""}</div>
        <p><a class="btn" href="/review/triage/${encodeURIComponent(inb.name)}">→ triage this</a></p>
        <article class="note-body">${raw(renderMarkdown(inb.text))}</article>`, "vault"));
    }
    return c.html(layout(name, html`<p class="flash">no note “${name}”.</p><p><a href="/vault">← vault</a></p>`, "vault"), 404);
  }
  const backlinks = backlinksFor(note.name);
  return c.html(layout(note.name, html`
    <h1>${note.name}</h1>
    <div class="meta">${note.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>
    <article class="note-body">${raw(renderMarkdown(note.body))}</article>
    ${backlinks.length ? html`<hr><h3>backlinks <span class="muted">(${backlinks.length})</span></h3><ul class="notes">${backlinks.map((b) => html`<li><a href="/vault/${encodeURIComponent(b)}">${b}</a></li>`)}</ul>` : ""}`, "vault"));
});

// ── TODO: every #task atom in the vault, in Reminders-style date sections ────
// The roll-up [[TODO]] does in Obsidian, done natively here — the vault's `tasks`
// query blocks can't render in this viewer, and this is the mobile surface for
// "what's due". Ticking a box writes the vault (POST /todo/complete): the atom is
// the line, so completion rewrites that line in place, as one revertable op.
/** "August 2026" — the calendar's month heading. */
const monthLabel = (month: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" })
    .format(new Date(`${month}-01T00:00:00Z`));

/** "Today" / "Tomorrow" / "Wednesday, August 5" — the selected day's heading. */
function dayLabel(iso: string, today: string): string {
  if (iso === today) return "Today";
  if (iso === addDays(today, 1)) return "Tomorrow";
  if (iso === addDays(today, -1)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
    ...(iso.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(new Date(`${iso}T00:00:00Z`));
}

const PRI_GLYPH: Record<string, string> = {
  highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬",
};

/** The checkbox. A real one for an atom we can complete — a tiny form, because
 *  every screen here works with scripting off — and an inert glyph otherwise:
 *  done already, or a `🔁`
 *  rule we won't roll forward (see canComplete), where ticking here would drop
 *  the recurrence. Those stay Obsidian's job, and say so. */
function taskBox(t: Task, showDone: boolean, byScope: boolean, projected = false) {
  // A projected occurrence has no line in the vault to rewrite — the atom exists
  // once, on its current date. Tick THAT one and the recurrence rolls forward.
  if (projected) return html`<span class="box proj" title="a future occurrence — complete the current one">☐</span>`;
  if (!canComplete(t)) {
    const why = t.status === "done" ? "" : "recurring — complete in Obsidian";
    return html`<span class="box" title="${why}">${t.status === "done" ? "☑" : "☐"}</span>`;
  }
  return html`<form class="tick" method="post" action="/todo/complete">
    <input type="hidden" name="note" value="${t.note}">
    <input type="hidden" name="dir" value="${t.dir}">
    <input type="hidden" name="line" value="${t.line}">
    <input type="hidden" name="raw" value="${t.raw}">
    ${showDone ? html`<input type="hidden" name="done" value="1">` : ""}
    ${byScope ? html`<input type="hidden" name="by" value="scope">` : ""}
    <button class="box" type="submit" title="complete" aria-label="complete “${t.text}”">☐</button>
  </form>`;
}

interface RowOpts {
  today: string;
  /** Print the atom's own date. Redundant under a dated heading (the date lens's
   *  Today/Tomorrow/… sections), load-bearing under any heading that isn't one:
   *  Overdue, and every section of the scope lens. */
  showDate?: boolean;
  showDone?: boolean;
  /** Carried into the tick form so completing an atom returns to THIS lens. */
  byScope?: boolean;
  /** A computed future occurrence rather than the atom's own line. */
  projected?: boolean;
}

function taskRow(t: Task, o: RowOpts) {
  const date = effectiveDate(t);
  const late = date ? daysBetween(date, o.today) : 0;
  return html`<li class="${t.status === "done" ? "done" : ""}${o.projected ? " projected" : ""}">
    ${taskBox(t, o.showDone ?? false, o.byScope ?? false, o.projected)}
    <div class="t-main">
      <div class="t-text">${raw(renderInline(t.text))}</div>
      <div class="t-meta">
        <a href="/vault/${encodeURIComponent(t.note)}">${t.note}</a>
        ${o.showDate && date
          ? html`<span>📅 ${date}</span>${late > 0 ? html`<span class="late">${late}d late</span>` : ""}`
          : ""}
        ${t.time ? html`<span class="at">${timeSpan(t)!.start}–${timeSpan(t)!.end}</span>` : ""}
        ${t.status === "done" && t.completed ? html`<span>✅ ${t.completed}</span>` : ""}
        ${!t.due && t.scheduled ? html`<span>⏳ scheduled</span>` : ""}
        ${t.recurrence ? html`<span>🔁 ${t.recurrence}</span>` : ""}
        ${t.unfiled ? html`<span class="tag">unfiled</span>` : ""}
      </div>
    </div>
    ${t.priority ? html`<span class="pri" title="${t.priority}">${PRI_GLYPH[t.priority]}</span>` : ""}
  </li>`;
}

// Two lenses over the same atoms. `date` (default) answers "what's due when";
// `scope` answers "what's on each area's plate" — the `group by filename` roll-up
// [[TODO]] does in Obsidian, and the view that makes a scope its area's command
// center. The pick rides in the URL so either is linkable/bookmarkable.
app.get("/todo", (c) => {
  const all = listTasks();
  const today = todayISO();
  const byScope = c.req.query("by") === "scope";
  const byCal = c.req.query("by") === "calendar";
  const showDone = c.req.query("done") === "1";
  const win = monthWindow(c.req.query("month") ?? "", today);
  // Default to today when the month on screen contains it, else the 1st — so
  // paging to another month lands somewhere real rather than on an empty day.
  const wanted = c.req.query("day") ?? "";
  const selected = wanted >= win.first && wanted <= win.last ? wanted
    : today >= win.first && today <= win.last ? today : win.first;
  const byDay: Map<string, Occurrence[]> = byCal ? occurrencesByDate(all, win.gridFrom, win.gridTo) : new Map();
  const undated = all.filter((t) => t.status === "open" && !effectiveDate(t)).length;
  const done = showDone ? completedTasks(all).slice(0, 50) : [];
  const open = all.filter((t) => t.status === "open").length;
  const overdue = groupByDue(all, today).find((g) => g.kind === "overdue")?.tasks.length ?? 0;

  const dateSection = (g: TaskGroup) => html`
    <section class="tg ${g.kind}">
      <h2>${g.label} <span class="n">${g.tasks.length}</span></h2>
      <ul class="tasks">${g.tasks.map((t) =>
        taskRow(t, { today, showDone, byScope, showDate: g.kind === "overdue" }))}</ul>
    </section>`;

  const scopeSection = (g: ScopeGroup) => html`
    <section class="tg ${g.unfiled ? "unfiled" : ""}">
      <h2>${g.unfiled ? g.note : html`<a href="/vault/${encodeURIComponent(g.note)}">${g.note}</a>`}
        <span class="n">${g.tasks.length}</span>
        ${g.overdue ? html`<span class="late">${g.overdue} overdue</span>` : ""}</h2>
      <ul class="tasks">${g.tasks.map((t) => taskRow(t, { today, showDone, byScope, showDate: true }))}</ul>
    </section>`;

  const url = (...parts: string[]) => {
    const q = parts.filter(Boolean).join("&");
    return q ? `/todo?${q}` : "/todo";
  };
  const here = byScope ? "by=scope" : byCal ? `by=calendar&month=${win.month}` : "";
  const lens = (on: boolean, q: string, label: string) =>
    on ? html`<strong>${label}</strong>` : html`<a href="${url(q, showDone ? "done=1" : "")}">${label}</a>`;

  // ── The month grid ────────────────────────────────────────────────────────
  // A calendar answers a question the two list lenses can't: what does the month
  // LOOK like — which days are loaded, which are free. So the grid carries only
  // density (a dot per occurrence), and the selected day's atoms render beneath
  // it as an ordinary task list, tick buttons and all.
  const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const cell = (d: string) => {
    const occ = byDay.get(d) ?? [];
    const out = d < win.first || d > win.last;
    const cls = [
      out ? "out" : "",
      d === today ? "today" : "",
      d === selected ? "sel" : "",
      occ.length && d < today ? "late" : "",
    ].filter(Boolean).join(" ");
    return html`<a class="cal-day ${cls}" href="${url(`by=calendar&month=${win.month}`, `day=${d}`)}"
        aria-label="${d} — ${occ.length} task${occ.length === 1 ? "" : "s"}">
      <span class="dnum">${Number(d.slice(8))}</span>
      <span class="dots">${occ.slice(0, 4).map((o) => html`<span class="dot ${o.projected ? "proj" : ""}"></span>`)}</span>
    </a>`;
  };
  const grid = () => {
    const weeks: string[][] = [];
    for (let d = win.gridFrom; d <= win.gridTo; ) {
      const week: string[] = [];
      for (let i = 0; i < 7; i++) { week.push(d); d = addDays(d, 1); }
      weeks.push(week);
    }
    const sel = byDay.get(selected) ?? [];
    return html`
      <div class="cal-head">
        <a href="${url(`by=calendar&month=${shiftMonth(win.month, -1)}`)}" aria-label="previous month">‹</a>
        <strong>${monthLabel(win.month)}</strong>
        <a href="${url(`by=calendar&month=${shiftMonth(win.month, 1)}`)}" aria-label="next month">›</a>
      </div>
      <div class="cal-grid">
        ${DOW.map((d) => html`<span class="cal-dow">${d}</span>`)}
        ${weeks.flat().map(cell)}
      </div>
      <section class="tg">
        <h2>${dayLabel(selected, today)} <span class="n">${sel.length}</span></h2>
        ${sel.length === 0
          ? html`<p class="muted">nothing on this day.</p>`
          : html`<ul class="tasks">${sel.map((o) =>
              taskRow(o.task, { today, projected: o.projected, showDate: false }))}</ul>`}
      </section>
      ${undated ? html`<p class="muted cal-undated">${undated} undated atom${undated === 1 ? "" : "s"} —
        not on the calendar. <a href="${url("")}">see them by date</a>.</p>` : ""}`;
  };

  // Same post/redirect/get receipt the capture screen uses.
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  return c.html(layout("todo", html`
    ${ok !== undefined ? html`<div class="toast">✓ completed${ok ? html` → “${ok}”` : ""}</div>` : ""}
    ${err ? html`<div class="toast err">✗ ${err}</div>` : ""}
    <h1>todo <span class="muted">(${open})</span></h1>
    <div class="meta">${today}${overdue ? html` · <span class="late">${overdue} overdue</span>` : ""}
      · ${lens(!byScope && !byCal, "", "by date")} · ${lens(byScope, "by=scope", "by scope")}
      · ${lens(byCal, "by=calendar", "calendar")}</div>
    ${byCal
      ? grid()
      : open === 0
        ? html`<p class="muted">nothing open — every <code>#task</code> atom is done.</p>`
        : byScope
          ? groupByScope(all, today).map(scopeSection)
          : groupByDue(all, today).map(dateSection)}
    <p class="todo-foot">
      ${showDone
        ? html`<a href="${url(here)}">hide completed</a>`
        : html`<a href="${url(here, "done=1")}">show completed</a>`}
    </p>
    ${done.length
      ? html`<section class="tg">
          <h2>Completed <span class="n">${done.length}</span></h2>
          <ul class="tasks">${done.map((t) => taskRow(t, { today, showDate: true }))}</ul>
        </section>`
      : ""}`, "todo"));
});

// Tick a box → rewrite that line in its note, as one atomic op. The whole write
// is guarded on the line still reading exactly as the page rendered it, so a
// stale tab can never complete an atom the vault has since moved or edited.
// There's no un-complete button: a mis-tap is one revert away in /history.
app.post("/todo/complete", async (c) => {
  const b = await c.req.parseBody();
  const back = [b.by === "scope" ? "by=scope" : "", b.done === "1" ? "done=1" : ""].filter(Boolean);
  const bounce = (q: string) => c.redirect(`/todo?${[...back, q].join("&")}`, 303);

  const file = readTaskFile(String(b.dir ?? ""), String(b.note ?? ""));
  if (!file) return bounce("err=no+such+note");

  const updated = completeInFile(file.text, Number(b.line ?? 0), String(b.raw ?? ""), todayISO());
  if (!updated) return bounce("err=that+line+changed+—+reload+and+try+again");

  const t = parseTaskLine(String(b.raw ?? ""), "", "", 0);
  try {
    await gitStore().commit(
      { ops: [{ op: "put", path: vaultRel(VAULT_SUBDIR, file.rel), content: updated }] },
      { message: `todo: complete ${t?.text ?? "atom"}` },
    );
    invalidate();
    return bounce(`ok=${encodeURIComponent(t?.text ?? "")}`);
  } catch (e) {
    return bounce(`err=${encodeURIComponent((e as Error).message)}`);
  }
});

// Subscribe-once calendar feed. Tailscale-only like every other route, so the
// URL is the only credential — which is also why it carries no auth of its own.
app.get("/todo.ics", (c) => {
  const body = buildICS(listTasks(), icsOptionsFromEnv());
  return c.body(body, 200, {
    "content-type": "text/calendar; charset=utf-8",
    // Named so a manual download lands as something recognisable.
    "content-disposition": 'inline; filename="braindance.ics"',
  });
});

// ── History: operation log + undo ───────────────────────────────────────────
const fmtDate = (iso: string): string => iso.slice(0, 16).replace("T", " ");

// A touched-path chip. `.md` paths link to the vault viewer by basename (which
// also resolves untriaged inbox captures — see GET /vault/:name); others render
// as plain chips.
const pathTag = (p: string) =>
  p.endsWith(".md")
    ? html` <a class="tag" href="/vault/${encodeURIComponent(p.slice(p.lastIndexOf("/") + 1, -3))}">${p}</a>`
    : html` <span class="tag">${p}</span>`;

async function renderHistory(flash?: { ok: boolean; msg: string }) {
  const ops = await gitStore().history({ limit: 100 });
  return layout(
    "history",
    html`
      <h1>history <span class="muted">(${ops.length})</span></h1>
      ${flash ? html`<p class="flash ${flash.ok ? "" : "err"}">${flash.msg}</p>` : ""}
      ${ops.map(
        (o) => html`
          <div class="op">
            <div class="msg">
              <strong>${o.message}</strong>
              <div class="meta">
                ${fmtDate(o.date)} · <code>${o.id.slice(0, 8)}</code>${o.paths
                  .slice(0, 4)
                  .map(pathTag)}${o.paths.length > 4
                  ? html` <span class="muted">+${o.paths.length - 4}</span>`
                  : ""}
              </div>
            </div>
            <form method="post" action="/revert" onsubmit="return confirm('Revert this operation? It creates a new undo commit.')">
              <input type="hidden" name="id" value="${o.id}" />
              <button class="btn danger" type="submit">↩ revert</button>
            </form>
          </div>
        `,
      )}
    `,
    "history",
  );
}

app.get("/history", async (c) => c.html(await renderHistory()));

app.post("/revert", async (c) => {
  const body = await c.req.parseBody();
  const id = String(body.id ?? "").trim();
  if (!id) return c.html(await renderHistory({ ok: false, msg: "no operation id given" }), 400);
  try {
    const res = await gitStore().revert(id);
    return c.html(await renderHistory({ ok: true, msg: `✓ reverted ${id.slice(0, 8)} — new op ${res.id.slice(0, 8)}` }));
  } catch (e) {
    return c.html(await renderHistory({ ok: false, msg: `✗ revert failed: ${(e as Error).message}` }), 409);
  }
});

// ── Proposals (Slice 4 — agents submit; the review queue UI is next) ────────
app.post("/proposals", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "JSON body required" }, 400);
  try {
    const p = await submitProposal(body as Parameters<typeof submitProposal>[0]);
    return c.json({ id: p.id, status: p.status }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.get("/proposals", async (c) => {
  const q = c.req.query("status");
  const valid: ProposalStatus[] = ["pending", "approved", "rejected", "returned"];
  const status = valid.includes(q as ProposalStatus) ? (q as ProposalStatus) : "pending";
  return c.json({ proposals: await listProposals(status) });
});

// ── /review — the triage desk ───────────────────────────────────────────────
// One page, two panes: the untriaged queue on the left, the capture you're
// working on to the right. SELECTION RIDES THE URL (`?note=<name>`) — that is
// what makes a desk possible without any client-side state. Picking a row is an ordinary
// link, both panes re-render on one request, and the state is bookmarkable,
// back-buttonable, and still there after a rejected submit.
//
// Before this the queue was a card list and triage was its own page: N notes
// meant N round trips out and back. The panes cost the same one request each,
// but you never lose sight of what's left.
//
// Proposals stay a plain section BELOW the desk — a different queue (agent
// changesets, already approve/edit/reject-gated) that shares only the page.
interface ReviewView {
  /** The queue row the right pane is working on — `?note=`, resolved. Null (the
   *  landing state, or a stale link to a note already triaged away) renders the
   *  empty right pane. */
  selected?: InboxNote | null;
  /** Which funnel's fields the right pane draws — `?funnel=`, else memo. */
  funnelId?: string;
  /** Submitted values, re-filled after a rejected file. Losing a thought to a
   *  validation error is the one failure this pipeline must not have, so a
   *  rejection re-renders the desk in place rather than bouncing anywhere. */
  values?: Record<string, string>;
  error?: string;
  /** The waiting suggestion for `selected`, already validated against the live
   *  vault (suggest.ts). Undefined when nothing selected; null when the worker is
   *  off, hasn't got to this note, or gave up on it — all of which render the
   *  same empty state, because from the desk they are the same fact. */
  suggestion?: Suggestion | null;
  /** Receipt for an action that resolved on THIS request (approve / reject /
   *  send back). Triage's own receipts arrive through the redirect query
   *  instead — see POST /review/triage/:name. */
  flash?: { ok: boolean; msg: string };
}

/** `2026-08-09T10:11:12.345Z` → `10:11`. The same UTC slice fmtDate takes, so a
 *  queue row and the detail header above it can't disagree about a capture. */
const hhmm = (iso: string): string => iso.slice(11, 16);

// A queue row is the timestamp over the note's label — which for the ordinary
// untitled capture is its first line (inbox.ts). Nothing else fits a phone-width
// rail, and nothing else is needed: the row's job is to be recognisable enough
// to pick, and picking it renders the whole note beside it. The full capture
// time rides in `title=` so the HH:MM never has to stand in for a date.
function queueRow(n: InboxNote, selected: string | null) {
  return html`<li>
    <a class="q-row${n.name === selected ? " sel" : ""}" href="/review?note=${encodeURIComponent(n.name)}"
       title="${n.createdISO ? fmtDate(n.createdISO) : n.name}">
      <span class="q-time">${n.createdISO ? hhmm(n.createdISO) : "—"}</span>
      <span class="q-title">${n.title}</span>
    </a>
  </li>`;
}

async function renderReview(v: ReviewView = {}) {
  const proposals = await listProposals("pending");
  const inbox = listInbox();
  const sel = v.selected?.name ?? null;
  return layout(
    "review",
    html`
      <h1>review</h1>
      ${v.flash ? html`<p class="flash ${v.flash.ok ? "" : "err"}">${v.flash.msg}</p>` : ""}

      <div class="desk${sel ? " picked" : ""}">
        <div class="queue">
          <h2 class="section">inbox <span class="muted">· to triage (${inbox.length})</span></h2>
          ${inbox.length === 0
            ? html`<p class="muted">inbox zero — nothing to triage.</p>`
            : html`<ul class="q-list">${inbox.map((n) => queueRow(n, sel))}</ul>`}
        </div>
        <div class="desk-detail">
          ${v.selected
            ? triagePane(v.selected, v.funnelId ?? "memo", getScopes(), v.suggestion ?? null, v.values, v.error)
            : html`<p class="muted desk-empty">${inbox.length
                ? "pick a capture from the queue to triage it."
                : "nothing waiting."}</p>`}
        </div>
      </div>

      <h2 class="section">proposals <span class="muted">· agent (${proposals.length})</span></h2>
      ${proposals.length === 0
        ? html`<p class="muted">no pending proposals. agents submit to <code>POST /proposals</code>.</p>`
        : proposals.map(
            (p) => html`
              <div class="card">
                <strong>${p.intent}</strong>
                <div class="meta">${fmtDate(p.createdAt)} · <code>${p.id.slice(5, 13)}</code>${p.parentOp
                    ? html` · parent <code>${p.parentOp.slice(0, 8)}</code>`
                    : ""}</div>
                ${p.rationale ? html`<p class="muted">${p.rationale}</p>` : ""}
                <ul class="changeset">
                  ${p.changeset.map(
                    (op) =>
                      html`<li>
                        <span class="${op.op === "put" ? "put" : "del"}">${op.op === "put" ? "＋ put" : "－ delete"}</span>
                        <code>${op.path}</code>
                        ${op.op === "put"
                          ? html`<details class="diff"><summary>content (${op.content.length} chars)</summary><pre>${op.content.slice(0, 4000)}</pre></details>`
                          : ""}
                      </li>`,
                  )}
                </ul>
                <div class="actions">
                  <form method="post" action="/review/approve" onsubmit="return confirm('Approve — apply this changeset to the vault as one commit?')">
                    <input type="hidden" name="id" value="${p.id}" />
                    <button class="btn" type="submit">✓ approve</button>
                  </form>
                  <a class="btn" href="/review/${p.id}/edit">✎ edit</a>
                  <form method="post" action="/review/reject" onsubmit="return confirm('Reject and discard this proposal?')">
                    <input type="hidden" name="id" value="${p.id}" />
                    <button class="btn danger" type="submit">✕ reject</button>
                  </form>
                </div>
                <form class="sendback" method="post" action="/review/send-back">
                  <input type="hidden" name="id" value="${p.id}" />
                  <input type="text" name="feedback" placeholder="feedback → send back for a follow-up proposal…" />
                  <button class="btn" type="submit">↩ send back</button>
                </form>
              </div>
            `,
          )}
    `,
    "review",
  );
}

// Apply an approved proposal's changeset as ONE atomic op. Paths are
// vault-relative; resolved to the current layout (VAULT_SUBDIR) so they land
// correctly pre- and post-cutover. Marks the proposal approved + refreshes the
// viewer. Throws on a failed apply (caller flashes).
async function applyProposal(p: Proposal): Promise<{ id: string; paths: string[] }> {
  const ops = p.changeset.map((op) =>
    op.op === "put"
      ? { op: "put" as const, path: vaultRel(VAULT_SUBDIR, op.path), content: op.content }
      : { op: "delete" as const, path: vaultRel(VAULT_SUBDIR, op.path) },
  );
  const res = await gitStore().commit({ ops }, { message: p.intent });
  await setStatus(p.id, "approved");
  invalidate();
  return res;
}

function renderEditForm(p: Proposal) {
  return layout(
    `edit ${p.id.slice(5, 13)}`,
    html`
      <h1>edit proposal <code>${p.id.slice(5, 13)}</code></h1>
      <p><a href="/review">← back to review</a></p>
      <form method="post" action="/review/${p.id}/edit">
        <label>intent</label>
        <input type="text" name="intent" value="${p.intent}" />
        ${p.changeset.map((op, i) =>
          op.op === "put"
            ? html`<label>＋ put <code>${op.path}</code></label>
                <textarea name="content_${i}">${op.content}</textarea>`
            : html`<label>－ delete <code>${op.path}</code> <span class="muted">(no content)</span></label>`,
        )}
        <div class="actions">
          <button class="btn" type="submit" name="action" value="save">save</button>
          <button class="btn" type="submit" name="action" value="approve" onclick="return confirm('Save &amp; apply to the vault?')">save &amp; approve</button>
        </div>
      </form>
    `,
    "review",
  );
}

// ── Inbox triage desk (manual, folded into /review) ─────────────────────────
// Drain the inbox: re-type a raw memo into a real vault note, keep it as a plain
// memo at the root, or discard — each as one atomic op (revertable via /history).
const URL_RE = /https?:\/\/[^\s)]+/;

/** The `#task` atom a memo already carries, if it was captured through the task
 *  funnel. Re-typing at the desk rebuilds the line from the form, so without
 *  this its due date and priority would be silently dropped on the way in. */
function memoAtom(memo: InboxNote): Task | null {
  const lines = memo.text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = parseTaskLine(lines[i], memo.name, "inbox", i + 1);
    if (t) return t;
  }
  return null;
}

/** A memo's text with its `#task` atom line removed — the detail a task capture
 *  carried alongside the action. Unchanged for an ordinary memo, which has none. */
function proseOf(memo: InboxNote): string {
  const atom = memoAtom(memo);
  if (!atom) return memo.text;
  return memo.text
    .split("\n")
    .filter((l) => l !== atom.raw)
    .join("\n")
    .trim();
}

/** A memo's label, WHOLE. An untitled capture's `title` is its first line cut to
 *  fit a queue row (inbox.ts firstLine) — right for a label, wrong the moment it
 *  reaches a field, because that field becomes the filed note's `# heading` and,
 *  for a task, the atom itself, so the ellipsis would be written into the vault.
 *  A label that IS that truncation gives back the line it was cut from.
 *
 *  Its FILENAME too, which is why `uniqueDest` is fed from here and never from
 *  `memo.title`: the label is cut to a row width and mid-word, so filing off it
 *  gives a stem chopped at 59 characters, where slug()'s own 60-character cut of
 *  the whole line is the one the note's identity is supposed to come from. */
const wholeTitle = (memo: InboxNote): string =>
  memo.title === firstLine(memo.text) ? firstLine(memo.text, Infinity) : memo.title;

// Deterministic pre-fill (no LLM): the memo title → a `title` field, the memo
// body → the funnel's main text field, a URL in the body → a `url` field, and the
// scopes picked at capture time → the scope picker, comma-separated (so the pick
// survives re-typing).
function prefillFor(f: Field, memo: InboxNote): string {
  if (f.key === "title") return memoAtom(memo)?.text || wholeTitle(memo);
  if (f.type === "scope") return memo.scopes.join(", ");
  if (f.key === "due") return memoAtom(memo)?.due ?? "";
  if (f.key === "priority") return memoAtom(memo)?.priority ?? "";
  // The atom line is already represented by the title/due/priority fields — a
  // textarea gets the prose AROUND it, not a duplicate of it.
  if (f.type === "textarea") return proseOf(memo);
  if (f.type === "url") return memo.text.match(URL_RE)?.[0] ?? "";
  return "";
}

// A suggestion pre-fill: the model's answer where it has one, the deterministic
// pre-fill everywhere else. The model is asked about metadata, not about the
// note — the prose field always stays the captured text, so accepting a
// suggestion can never rewrite what you wrote.
//
// ONE function serves both buttons: "apply" re-renders the pane from it, "apply
// & file" posts it. They must not be able to disagree about what "the suggestion"
// means — a card that fills one set of fields and files another is worse than no
// card at all.
function suggestedValue(fl: Field, memo: InboxNote, s: Suggestion): string {
  if (fl.key === "title") return s.title;
  if (fl.type === "scope") return s.scope ?? prefillFor(fl, memo);
  if (fl.key === "due") return s.due ?? prefillFor(fl, memo);
  if (fl.key === "priority") return s.priority ?? prefillFor(fl, memo);
  return prefillFor(fl, memo);
}

const suggestedValues = (memo: InboxNote, f: Funnel, s: Suggestion): Record<string, string> =>
  Object.fromEntries(f.fields.map((fl) => [fl.key, suggestedValue(fl, memo, s)]));

// A collision-safe destination at the vault ROOT (flat vault) for a filed note.
//
// The `-2` suffix loop is worth exactly as much as its collision test, and the
// test has to be the one in vault.ts: case-insensitive (slug lowercases, notes
// are title-cased) and read off the directory rather than the index. Filing is
// the only place in the app that invents a NEW filename, so this is the one
// place that decides whether a triage can overwrite a note.
function uniqueDest(title: string): { rel: string; name: string } {
  const base = slug(title);
  const taken = takenRootNames();
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  return { rel: vaultRel(VAULT_SUBDIR, `${name}.md`), name };
}

// The right pane: the capture, editable, and everything needed to file it.
//
// The order is the order you think in — read the thought, then say what it is.
// So the funnel's prose field is hoisted out of the field loop and leads the
// pane: it is the same input the funnel already owns (memo `body`, task
// `detail`, media `why`), but here it isn't one control among several, it IS the
// note. Type, title, scope and the type-specific fields follow it as metadata
// about that text. Nothing is read-only any more — a capture is a first draft,
// and the desk is where it gets edited, not just labelled.
function triagePane(memo: InboxNote, funnelId: string, scopes: string[], suggestion: Suggestion | null, values?: Record<string, string>, error?: string) {
  const f = funnelById(funnelId) ?? funnelById("memo")!;
  // The suggested TITLE arrives already in the box rather than waiting behind
  // "apply". Titling is the one thing every triage does, and the one field the
  // deterministic pre-fill is worst at — all it can offer is the note's own
  // first line, which is the text you are reading directly above it, so it tells
  // you nothing you don't already know. The rest of the suggestion stays inert
  // until accepted: a wrong title is visible in the field you are looking at,
  // while a wrong scope files the note somewhere you won't think to look.
  //
  // A DEFAULT only. `values` — a re-render after a rejected submit, or after
  // "apply" — still wins, so this can never overwrite something you typed.
  const val = (fl: Field) => {
    if (values?.[fl.key] !== undefined) return values[fl.key];
    if (fl.key === "title" && suggestion?.title.trim()) return suggestion.title;
    return prefillFor(fl, memo);
  };
  const act = `/review/triage/${encodeURIComponent(memo.name)}`;
  const here = `/review?note=${encodeURIComponent(memo.name)}`;
  const sf = suggestion ? funnelById(suggestion.funnel) : undefined;
  // Resolved ONCE and used for both the hidden form and the check below, so the
  // button and what it would post cannot come from two different readings.
  const sugValues = suggestion && sf ? suggestedValues(memo, sf, suggestion) : null;
  // The required fields the suggestion has no answer for. "apply & file" posts
  // these values and NOTHING else, so each of these comes back as `missing
  // required:` — every time, for the whole class: media's `kind` is a select the
  // model isn't asked about, and resource's `activity` is empty whenever it
  // returns no scope. A button that can only 400 is worse than no button, so it
  // is replaced by the one thing the user needs to know: apply, then pick these.
  // "apply" is unaffected — filling four fields of five is still worth a tap.
  const sugMissing = sf && sugValues
    ? sf.fields.filter((fl) => fl.required && !sugValues[fl.key]?.trim()).map((fl) => fl.label)
    : [];
  const canFile = Boolean(sugValues && !sugMissing.length);
  const prose = f.fields.find((fl) => fl.type === "textarea");
  const fieldRow = (fl: Field) =>
    html`<label>${fl.label} ${fl.required ? html`<span class="req">*</span>` : ""}</label>${control(fl, scopes, val(fl))}`;
  return html`
    <a class="desk-back" href="/review">← queue</a>
    <div class="meta">from inbox · ${memo.createdISO ? fmtDate(memo.createdISO) : ""} · <code>${memo.name}</code>${memo.scopes.map((s) => html` <span class="tag">${s}</span>`)}</div>
    ${error ? html`<p class="flash err">${error}</p>` : ""}
    <form method="post" action="${act}" class="triage-form">
      ${prose ? fieldRow(prose) : html`<p class="muted snippet">${memo.text}</p>`}

      <!-- The suggestion sits between the note and the fields it would pre-fill
           on purpose: you read the thought, then the machine's reading of it,
           then decide. It is never applied for you — a form field you looked at
           is the whole containment story for anything the model got wrong. -->
      <div class="suggest">
        ${suggestion && sf
          ? html`<div class="card sug">
              <div class="sug-head">suggestion <span class="muted">· ${sf.label.toLowerCase()}${suggestion.scope ? html` → ${suggestion.scope}` : ""}</span></div>
              <strong class="sug-title">${suggestion.title}</strong>
              ${suggestion.due || suggestion.priority || suggestion.tags.length
                ? html`<div class="sug-meta">
                    ${suggestion.due ? html`<span class="tag">📅 ${suggestion.due}</span>` : ""}
                    ${suggestion.priority ? html`<span class="tag">${PRI_GLYPH[suggestion.priority] ?? ""} ${suggestion.priority}</span>` : ""}
                    ${suggestion.tags.map((t) => html`<span class="tag">${t}</span>`)}
                  </div>`
                : ""}
              ${suggestion.rationale ? html`<p class="muted sug-why">${suggestion.rationale}</p>` : ""}
              <div class="actions">
                <button class="btn" type="submit" form="suggest-apply">↧ apply</button>
                ${canFile
                  ? html`<button class="btn" type="submit" form="suggest-file">↧ apply &amp; file</button>`
                  : html`<span class="muted">then pick ${sugMissing.join(" + ")}</span>`}
              </div>
            </div>`
          : html`<p class="muted sug-none">no suggestion.</p>`}
      </div>

      <label>type</label>
      <select name="funnel" onchange="location.href='${here}&funnel='+this.value">
        ${FUNNELS.map((x) => html`<option value="${x.id}"${x.id === f.id ? raw(" selected") : ""}>${x.label}</option>`)}
      </select>
      <div class="cap-fields">
        ${f.fields.filter((fl) => fl !== prose).map(fieldRow)}
      </div>
      <div class="cap-actions">
        <button class="btn" type="submit" name="action" value="file">file it</button>
        <button class="btn danger" type="submit" form="triage-discard">✕ discard</button>
      </div>
    </form>
    <!-- Discard is a POST of its own and a form can't nest, so it sits here
         empty and the button above reaches it by form= — which is what puts
         both actions on one row without a line of script. -->
    <form method="post" action="${act}" id="triage-discard" onsubmit="return confirm('Discard this memo?')">
      <input type="hidden" name="action" value="discard" />
    </form>
    ${suggestion && sf
      ? html`
        <!-- The two apply paths, as sibling forms the card's buttons reach by
             form= (same trick as discard). Both are ordinary submits — "apply"
             is a GET that re-renders this pane with the suggestion in the
             fields, "apply & file" is the SAME POST the "file it" button makes,
             carrying those values as hidden inputs. Nothing new can happen to
             the vault through this card: it ends at the one commit path a
             hand-typed triage already takes.
             The funnel is not carried on the apply link — the pane re-reads it
             from the sidecar, so there is one answer to "which type did it
             suggest" rather than one in a URL and one in a file. -->
        <form method="get" action="/review" id="suggest-apply">
          <input type="hidden" name="note" value="${memo.name}" />
          <input type="hidden" name="apply" value="1" />
        </form>
        <!-- Note this posts the note text AS CAPTURED, not whatever is in the
             textarea right now — a separate form can't read another form's
             fields without script. Edit-then-file is the "apply" button
             followed by "file it"; this button is the one-tap path for a
             capture you're accepting as it stands.
             Rendered only when the suggestion fills every required field: a
             form that can only be rejected is not a shortcut. -->
        ${canFile && sugValues
          ? html`<form method="post" action="${act}" id="suggest-file">
              <input type="hidden" name="action" value="file" />
              <input type="hidden" name="funnel" value="${sf.id}" />
              ${sf.fields.map((fl) => html`<input type="hidden" name="${fl.key}" value="${sugValues[fl.key]}" />`)}
            </form>`
          : ""}`
      : ""}`;
}

// Resolve the :name param to an inbox note (decoded or raw), or null.
const resolveInbox = (raw0: string): InboxNote | null => {
  let name = raw0;
  try { name = decodeURIComponent(raw0); } catch { /* keep raw */ }
  return getInboxNote(name) ?? getInboxNote(raw0);
};

// Triage no longer has a page of its own — it's the desk's right pane. This
// route stays as a permanent redirect INTO that pane so the links that already
// point at it keep resolving: /vault/:name's "→ triage this" CTA, a /history
// path chip, a bookmark, an old tab.
app.get("/review/triage/:name", (c) => {
  const q = new URLSearchParams({ note: c.req.param("name") });
  const funnel = c.req.query("funnel");
  if (funnel) q.set("funnel", funnel);
  return c.redirect(`/review?${q}`, 302);
});

app.post("/review/triage/:name", async (c) => {
  const memo = resolveInbox(c.req.param("name"));
  if (!memo) return c.html(await renderReview({ flash: { ok: false, msg: "inbox note not found (already triaged?)" } }), 404);
  const body = await c.req.parseBody();
  const inboxRel = vaultRel(VAULT_SUBDIR, "inbox", `${memo.name}.md`);

  // A note that filed is a note that left the queue, so success LEAVES the pane:
  // post/redirect/get back to the desk with the receipt on the query — the same
  // pattern the capture screen uses, and the reason a reload can't re-file.
  const filed = (msg: string) => c.redirect(`/review?ok=${encodeURIComponent(msg)}`, 303);
  // Anything that isn't success stays put, with the note still selected and
  // whatever was typed still in the fields. Losing a thought to a validation
  // error — or to a commit that lost a race — is the one failure this pipeline
  // must not have.
  // The suggestion is re-read here so a rejected submit doesn't lose the card
  // along with nothing else — the pane comes back exactly as it was.
  const stuck = async (status: 400 | 409, v: Omit<ReviewView, "selected">) =>
    c.html(await renderReview({ selected: memo, suggestion: await suggestionFor(memo.name), ...v }), status);

  if (String(body.action) === "discard") {
    try {
      await gitStore().commit({ ops: [{ op: "delete", path: inboxRel }] }, { message: `triage: discard inbox/${memo.name}` });
      invalidate();
      await dropSidecar(memo.name); // the note left the queue; its suggestion goes with it
      return filed(`✕ discarded “${memo.title}”`);
    } catch (e) {
      return stuck(409, { flash: { ok: false, msg: `✗ discard failed: ${(e as Error).message}` } });
    }
  }

  // File it: build the typed note from the chosen funnel + submitted fields.
  const funnelId = String(body.funnel ?? "memo");
  const funnel = funnelById(funnelId);
  if (!funnel) return stuck(400, { flash: { ok: false, msg: `unknown funnel ${funnelId}` } });
  const input: Record<string, string> = {};
  for (const fl of funnel.fields) input[fl.key] = String(body[fl.key] ?? "").trim();
  const missing = funnel.fields.filter((fl) => fl.required && !input[fl.key]).map((fl) => fl.label);
  if (missing.length) {
    return stuck(400, { funnelId, values: input, error: `missing required: ${missing.join(", ")}` });
  }

  // Filing a TASK is not "make a note" — a task is a line, and it is filed by
  // living in its scope's note ([[Tags]]). So the changeset appends the atom to
  // that note and drops the inbox memo, in one op. With no scope picked there's
  // nothing to append to, so it falls through and files as its own note, which
  // still leaves a real (if scopeless) atom rather than losing the capture.
  const scopeKey = funnel.fields.find((fl) => fl.type === "scope")?.key;
  const picked = scopeKey ? parseScopes(input[scopeKey]) : [];
  // ONE atom, in ONE note. The first scope owns it and the rest ride along as
  // links in the description, because a task is a line and a line appended to
  // three hubs is three tasks: tick it in one and the other two stay open
  // forever. The links still put the atom in every hub's backlinks, which is the
  // thing having several scopes was for.
  const target = picked[0] ?? "";
  const alsoLinks = picked.slice(1).map((s) => `[[${s}]]`).join(" ");
  if (funnel.id === "task" && target && noteExists(target)) {
    const raw = readNoteRaw(target);
    if (!raw) return stuck(409, { funnelId, values: input, flash: { ok: false, msg: `✗ could not read “${target}”` } });
    const line = taskLine(alsoLinks ? { ...input, title: `${input.title} ${alsoLinks}` } : input);
    // A task is one line, so any DETAIL the capture carried has nowhere to go on
    // the scope note. Rather than drop it with the memo, it becomes a memo note
    // of its own in the same op — the action files, the context keeps. Clear the
    // detail field at the desk and only the atom lands.
    const detail = input.body?.trim() ?? "";
    const keep = detail ? uniqueDest(input.title || wholeTitle(memo) || "note") : null;
    const ops = [
      { op: "delete" as const, path: inboxRel },
      { op: "put" as const, path: vaultRel(VAULT_SUBDIR, `${target}.md`), content: appendTaskLine(raw, line) },
    ];
    if (keep) {
      ops.push({
        op: "put" as const,
        path: keep.rel,
        content: compose({
          title: input.title,
          frontmatter: { ...(memo.createdISO ? { created: memo.createdISO } : {}), tags: ["memo"] },
          body: `${scopeLink(picked)}# ${input.title}\n\n${detail}`,
        }),
      });
    }
    try {
      const res = await gitStore().commit({ ops }, {
        message: `triage: task → ${picked.join(", ")}${keep ? ` (+ memo ${keep.name})` : ""} ← inbox/${memo.name}`,
      });
      invalidate();
      await dropSidecar(memo.name);
      // The receipt names the hub the atom LIVES in and, separately, the ones it
      // only links to — "filed to three places" would be a lie you'd act on.
      return filed(`✓ filed atom → ${target}${alsoLinks ? ` (+ ${picked.length - 1} linked)` : ""}${keep ? `, detail kept as ${keep.name}` : ""} (op ${res.id.slice(0, 8)})`);
    } catch (e) {
      return stuck(409, { funnelId, values: input, flash: { ok: false, msg: `✗ file failed: ${(e as Error).message}` } });
    }
  }

  const note = funnel.build(input);
  if (memo.createdISO) note.frontmatter = { created: memo.createdISO, ...note.frontmatter }; // preserve capture time
  const content = compose(note);
  const dest = uniqueDest(note.title || wholeTitle(memo) || "note");
  try {
    const res = await gitStore().commit(
      { ops: [{ op: "delete", path: inboxRel }, { op: "put", path: dest.rel, content }] },
      { message: `triage: ${funnel.id} ← inbox/${memo.name}` },
    );
    invalidate();
    await dropSidecar(memo.name);
    return filed(`✓ filed as ${funnel.id} → ${dest.name} (op ${res.id.slice(0, 8)})`);
  } catch (e) {
    return stuck(409, { funnelId, values: input, flash: { ok: false, msg: `✗ file failed: ${(e as Error).message}` } });
  }
});

// The desk. `?note=` picks the right pane, `?funnel=` picks which funnel's
// fields it draws, and `?ok=`/`?err=` carry a receipt back from a redirect.
app.get("/review", async (c) => {
  const want = c.req.query("note");
  const selected = want ? resolveInbox(want) : null;
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  // A `?note=` that no longer resolves is the ordinary consequence of triaging
  // in one tab and following a stale link in another — say so, and fall back to
  // the queue rather than 404ing a page that is still perfectly useful.
  const flash = ok !== undefined ? { ok: true, msg: ok }
    : err !== undefined ? { ok: false, msg: err }
      : want && !selected ? { ok: false, msg: "inbox note not found (already triaged?)" }
        : undefined;
  // Re-validated against the vault as it is on THIS request, not as it was when
  // the worker ran — see suggest.ts validate().
  const suggestion = selected ? await suggestionFor(selected.name) : null;
  // `?apply=1` is the suggestion card's "apply" button: same page, same note,
  // now with the suggestion in the fields. It only fills the form — the note is
  // still filed by the ordinary "file it" submit below it.
  const applied = c.req.query("apply") !== undefined && suggestion && selected
    ? { funnelId: suggestion.funnel, values: suggestedValues(selected, funnelById(suggestion.funnel)!, suggestion) }
    : null;
  return c.html(await renderReview({
    selected,
    suggestion,
    funnelId: applied?.funnelId ?? c.req.query("funnel"),
    values: applied?.values,
    flash,
  }));
});

app.post("/review/approve", async (c) => {
  const id = String((await c.req.parseBody()).id ?? "").trim();
  const p = await getProposal(id);
  if (!p || p.status !== "pending") return c.html(await renderReview({ flash: { ok: false, msg: "proposal not found or already handled" } }), 404);
  try {
    const res = await applyProposal(p);
    return c.html(await renderReview({ flash: { ok: true, msg: `✓ approved & applied — op ${res.id.slice(0, 8)} (${res.paths.length} path${res.paths.length === 1 ? "" : "s"})` } }));
  } catch (e) {
    return c.html(await renderReview({ flash: { ok: false, msg: `✗ apply failed: ${(e as Error).message}` } }), 409);
  }
});

app.get("/review/:id/edit", async (c) => {
  const p = await getProposal(c.req.param("id"));
  if (!p || p.status !== "pending") return c.html(await renderReview({ flash: { ok: false, msg: "proposal not found or already handled" } }), 404);
  return c.html(renderEditForm(p));
});

app.post("/review/:id/edit", async (c) => {
  const id = c.req.param("id");
  const p = await getProposal(id);
  if (!p || p.status !== "pending") return c.html(await renderReview({ flash: { ok: false, msg: "proposal not found or already handled" } }), 404);
  const body = await c.req.parseBody();
  const intent = String(body.intent ?? "").trim() || p.intent;
  const changeset = p.changeset.map((op, i) =>
    op.op === "put" ? { ...op, content: String(body[`content_${i}`] ?? op.content) } : op,
  );
  const updated = await updateProposal(id, { intent, changeset });
  if (String(body.action) === "approve" && updated) {
    try {
      const res = await applyProposal(updated);
      return c.html(await renderReview({ flash: { ok: true, msg: `✓ edited, approved & applied — op ${res.id.slice(0, 8)}` } }));
    } catch (e) {
      return c.html(await renderReview({ flash: { ok: false, msg: `✗ apply failed: ${(e as Error).message}` } }), 409);
    }
  }
  return c.html(await renderReview({ flash: { ok: true, msg: `proposal ${id.slice(5, 13)} updated` } }));
});

app.post("/review/send-back", async (c) => {
  const body = await c.req.parseBody();
  const id = String(body.id ?? "").trim();
  const feedback = String(body.feedback ?? "").trim();
  const p = await getProposal(id);
  if (!p || p.status !== "pending") return c.html(await renderReview({ flash: { ok: false, msg: "proposal not found or already handled" } }), 404);
  await updateProposal(id, { status: "returned", feedback });
  return c.html(await renderReview({ flash: { ok: true, msg: `↩ sent back${feedback ? " with feedback" : ""} — agents fetch it via GET /proposals?status=returned` } }));
});

app.post("/review/reject", async (c) => {
  const id = String((await c.req.parseBody()).id ?? "").trim();
  const p = await getProposal(id);
  if (!p || p.status !== "pending") return c.html(await renderReview({ flash: { ok: false, msg: "proposal not found or already handled" } }), 404);
  await setStatus(id, "rejected");
  return c.html(await renderReview({ flash: { ok: true, msg: `proposal ${id.slice(5, 13)} rejected` } }));
});

// ── JSON API (programmatic / legacy) ────────────────────────────────────────
// `?ingestable=1` narrows to the capture-destination hubs — the same list the
// capture form's dropdown draws, so an external capture client (a Shortcut
// building its own picker) can offer the same short list the app does.
app.get("/scopes", (c) =>
  c.json({ scopes: c.req.query("ingestable") === "1" ? getIngestableScopes() : getScopes() }));
app.post("/notes", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { content?: string; scope?: string };
  if (!b.content || !b.scope) return c.json({ error: "content and scope are required" }, 400);
  return c.json(await createNote({ content: b.content, scope: b.scope }), 201);
});
// `/health` doubles as the deploy diagnostic. Twice now, a `/srv/.env` edit and
// an image roll have been indistinguishable from outside the box: the feed just
// looks the same, and answering "is the new build live, did the env land?"
// needed SSH. So it reports the build it is running and the knobs it resolved —
// derived from the SAME function the feed uses (icsOptionsFromEnv), so the two
// cannot drift apart.
//
// NOTHING SECRET GOES HERE. This is unauthenticated (Tailscale-only, no auth of
// its own), so it reports the *task and calendar* knobs only — never a token, a
// remote URL, or a notification endpoint, each of which is a bearer credential.
// The suggestion worker follows the same rule: whether it is on and which model
// it runs, never ANTHROPIC_API_KEY or anything derived from it.
app.get("/health", (c) => c.json(healthPayload(gitStore().status())));

// Local-first git store: mark the mounted repo safe, acquire the single-writer
// lease (a no-op unless REQUIRE_LEASE is set), then start the periodic inbound
// reconcile (pull --rebase, coalesced through the one push worker).
const store = gitStore();
await store.init();
if (!(await store.acquireWriterLease())) {
  console.error(
    "FATAL: another instance holds the writer lease — refusing to start a second writer. " +
      "Stop the other instance or wait for its lease to expire.",
  );
  process.exit(1);
}
store.start();

// The suggestion worker, if it was asked for. Opt-in on BOTH halves — the flag
// and a key — so the default deployment makes no outbound call at all and this
// process is the app it was before the feature existed. Started here, beside
// store.start(), because those are the two background loops this container runs.
if (aiSuggestConfig().enabled) startSuggestWorker();

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port });
console.log(`braindance admin app on :${port}`);

// Graceful shutdown — the deploy path depends on it. `docker compose up -d api`
// stops this container and starts its replacement, and the replacement REFUSES
// TO START while another holder owns the writer lease. Nothing used to call
// stop(), so the lease was only ever freed by expiry: the new container
// crash-looped for the whole TTL (60s by default) while the old one was already
// gone. That is invisible when a deploy is a poll that eventually converges,
// and fatal once CI gates the run on /health reporting the new commit — the
// deploy lands, but only after the gate has given up and called it red.
//
// Releasing on the way out makes a rollover immediate: the replacement acquires
// the lease on its first attempt.
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return; // SIGTERM then SIGINT must not double-release
  shuttingDown = true;
  console.log(`${signal} — releasing writer lease, shutting down`);
  // Stop accepting new work first, so nothing acquires mid-release. Both halves
  // are best-effort: an exit that hangs is worse than one that skips a step,
  // because docker escalates to SIGKILL and we lose the release entirely.
  server.close();
  // Bounded: docker sends SIGKILL ~10s after SIGTERM, and an exit that hangs
  // past that loses the release entirely — the very thing this handler exists
  // to prevent. Better to give up early and fall back to TTL expiry.
  const watchdog = setTimeout(() => process.exit(0), 8_000);
  watchdog.unref();
  await store.stop();
  process.exit(0);
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
