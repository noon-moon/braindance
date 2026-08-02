import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { layout } from "./layout.js";
import { FUNNELS, funnelById, compose, taskLine, appendTaskLine, scopeLink, type Field } from "./funnels.js";
import { commitCapture, createNote, stamp, slug } from "./notes.js";
import { VAULT_SUBDIR, vaultRel } from "./config.js";
import { seenRecently, contentHash } from "./dedup.js";
import { randomUUID } from "node:crypto";
import { submitProposal, listProposals, getProposal, setStatus, updateProposal, type Proposal, type ProposalStatus } from "./proposals.js";
import { getScopes, getNote, listNotes, backlinksFor, invalidate, noteExists, readNoteRaw } from "./vault.js";
import { listInbox, getInboxNote, type InboxNote } from "./inbox.js";
import { renderMarkdown, renderInline } from "./render.js";
import { gitStore } from "./git.js";
import {
  listTasks, groupByDue, completedTasks, todayISO, daysBetween, effectiveDate, parseTaskLine,
  canComplete, completeInFile, readTaskFile, groupByScope, timeSpan,
  type Task, type TaskGroup, type ScopeGroup,
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
    // A dropdown over the live MOC list (every `scope`-tagged note, alphabetical) —
    // pick the most relevant one and it becomes the note's leading `Tags: [[MOC]]`
    // link. A native <select> beats a text input on the phone: no typing, and iOS
    // gives its own scrollable picker. `_meta/` scopes (scope_kind: system) never
    // appear — the flat index only reads the vault root.
    // A current value that ISN'T a live scope (a carried-over capture whose MOC was
    // since renamed) is kept as an extra option rather than silently dropped.
    const opts = value && !scopes.includes(value) ? [value, ...scopes] : scopes;
    const blank = f.required ? "— pick a scope —" : "— none —";
    return html`<select name="${f.key}"${req}><option value="">${blank}</option>${opts.map((s) => html`<option${sel(s)}>${s}</option>`)}</select>`;
  }
  const t = f.type === "url" ? "url" : f.type === "date" ? "date" : f.type === "number" ? "number" : "text";
  return html`<input type="${t}" name="${f.key}"${req} placeholder="${ph}" value="${value}">`;
}

// The capture screen: title + body + scope, and a task toggle over due/priority.
//
// Capture stays UNTYPED by default — a thought drops into the inbox as a raw
// memo and the media/resource sorting happens at triage. What capture time knows
// and the desk can only guess at is anything you can't reconstruct later:
//
//   - WHICH SCOPE the thought belongs to (lands as the leading `Tags: [[MOC]]`),
//   - whether it's a thought or an ACTION, and if so when it's due.
//
// So the one classification the form does offer is "this is a task", which
// reveals due + priority (pure CSS — this app runs no JS) and captures a real
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
  /** Set when a capture just landed → success toast. Names the note by its
   *  TITLE, not its timestamped filename — the receipt has to read at a glance
   *  on a phone — and untitled memos (the one-tap path) just say "to inbox". */
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
  const scopes = getScopes();
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
          ${field(of(memo, "title"))}
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

  const path = vaultRel(VAULT_SUBDIR, "inbox", `${stamp()}-${slug(note.title)}.md`);
  await commitCapture(path, composed, `inbox: ${funnel.id} capture`);
  // The TYPED title (may be empty — a memo captures untitled), not the note's
  // fallback "memo": the toast reads it back, and "memo" reads as noise.
  return { kind: "ok", path, title: input.title ?? "" };
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
const PRI_GLYPH: Record<string, string> = {
  highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬",
};

/** The checkbox. A real one for an atom we can complete — a tiny form, because
 *  this app runs no JS — and an inert glyph otherwise: done already, or a `🔁`
 *  rule we won't roll forward (see canComplete), where ticking here would drop
 *  the recurrence. Those stay Obsidian's job, and say so. */
function taskBox(t: Task, showDone: boolean, byScope: boolean) {
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
}

function taskRow(t: Task, o: RowOpts) {
  const date = effectiveDate(t);
  const late = date ? daysBetween(date, o.today) : 0;
  return html`<li class="${t.status === "done" ? "done" : ""}">
    ${taskBox(t, o.showDone ?? false, o.byScope ?? false)}
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
  const showDone = c.req.query("done") === "1";
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
  const here = byScope ? "by=scope" : "";
  const lens = (on: boolean, q: string, label: string) =>
    on ? html`<strong>${label}</strong>` : html`<a href="${url(q, showDone ? "done=1" : "")}">${label}</a>`;

  // Same post/redirect/get receipt the capture screen uses.
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  return c.html(layout("todo", html`
    ${ok !== undefined ? html`<div class="toast">✓ completed${ok ? html` → “${ok}”` : ""}</div>` : ""}
    ${err ? html`<div class="toast err">✗ ${err}</div>` : ""}
    <h1>todo <span class="muted">(${open})</span></h1>
    <div class="meta">${today}${overdue ? html` · <span class="late">${overdue} overdue</span>` : ""}
      · ${lens(!byScope, "", "by date")} · ${lens(byScope, "by=scope", "by scope")}</div>
    ${open === 0
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

// ── Review queue (Slice 4b) — approve applies via the adapter; reject discards ─
async function renderReview(flash?: { ok: boolean; msg: string }) {
  const proposals = await listProposals("pending");
  const inbox = listInbox();
  return layout(
    "review",
    html`
      <h1>review</h1>
      ${flash ? html`<p class="flash ${flash.ok ? "" : "err"}">${flash.msg}</p>` : ""}

      <h2 class="section">inbox <span class="muted">· to triage (${inbox.length})</span></h2>
      ${inbox.length === 0
        ? html`<p class="muted">inbox zero — nothing to triage.</p>`
        : inbox.map(
            (n) => html`
              <div class="card">
                <a href="/review/triage/${encodeURIComponent(n.name)}"><strong>${n.title}</strong></a>
                <div class="meta">${n.createdISO ? fmtDate(n.createdISO) : ""}${n.scope ? html` <span class="tag">${n.scope}</span>` : ""}</div>
                ${n.text ? html`<p class="muted snippet">${n.text.slice(0, 200)}</p>` : ""}
                <div class="actions">
                  <a class="btn" href="/review/triage/${encodeURIComponent(n.name)}">→ triage</a>
                  <form method="post" action="/review/triage/${encodeURIComponent(n.name)}" onsubmit="return confirm('Discard this memo?')">
                    <input type="hidden" name="action" value="discard" />
                    <button class="btn danger" type="submit">✕ discard</button>
                  </form>
                </div>
              </div>`,
          )}

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

// Deterministic pre-fill (no LLM): the memo title → a `title` field, the memo
// body → the funnel's main text field, a URL in the body → a `url` field, and the
// scope picked at capture time → the scope dropdown (so it survives re-typing).
function prefillFor(f: Field, memo: InboxNote): string {
  if (f.key === "title") return memoAtom(memo)?.text || memo.title;
  if (f.type === "scope") return memo.scope ?? "";
  if (f.key === "due") return memoAtom(memo)?.due ?? "";
  if (f.key === "priority") return memoAtom(memo)?.priority ?? "";
  // The atom line is already represented by the title/due/priority fields — a
  // textarea gets the prose AROUND it, not a duplicate of it.
  if (f.type === "textarea") return proseOf(memo);
  if (f.type === "url") return memo.text.match(URL_RE)?.[0] ?? "";
  return "";
}

// A collision-safe destination at the vault ROOT (flat vault) for a filed note.
function uniqueDest(title: string): { rel: string; name: string } {
  const base = slug(title);
  let name = base;
  for (let i = 2; noteExists(name); i++) name = `${base}-${i}`;
  return { rel: vaultRel(VAULT_SUBDIR, `${name}.md`), name };
}

function renderTriageForm(memo: InboxNote, funnelId: string, scopes: string[], values?: Record<string, string>, error?: string) {
  const f = funnelById(funnelId) ?? funnelById("memo")!;
  const val = (fl: Field) => values?.[fl.key] ?? prefillFor(fl, memo);
  const act = `/review/triage/${encodeURIComponent(memo.name)}`;
  return layout(
    "triage",
    html`
      <h1>triage</h1>
      <p><a href="/review">← back to review</a></p>
      ${error ? html`<p class="flash err">${error}</p>` : ""}
      <div class="card">
        <div class="meta">from inbox · ${memo.createdISO ? fmtDate(memo.createdISO) : ""} · <code>${memo.name}</code>${memo.scope ? html` <span class="tag">${memo.scope}</span>` : ""}</div>
        ${memo.text ? html`<p class="muted snippet">${memo.text.slice(0, 400)}</p>` : ""}
      </div>
      <form method="post" action="${act}" class="capture-form">
        <label>type</label>
        <select name="funnel" onchange="location.href='${act}?funnel='+this.value">
          ${FUNNELS.map((x) => html`<option value="${x.id}"${x.id === f.id ? raw(" selected") : ""}>${x.label}</option>`)}
        </select>
        <div class="cap-fields">
          ${f.fields.map((fl) => html`<label>${fl.label} ${fl.required ? html`<span class="req">*</span>` : ""}</label>${control(fl, scopes, val(fl))}`)}
        </div>
        <div class="cap-actions">
          <button class="btn" type="submit" name="action" value="file">file it</button>
        </div>
      </form>
      <form method="post" action="${act}" class="triage-discard" onsubmit="return confirm('Discard this memo?')">
        <input type="hidden" name="action" value="discard" />
        <button class="btn danger" type="submit">✕ discard</button>
      </form>
    `,
    "review",
  );
}

// Resolve the :name param to an inbox note (decoded or raw), or null.
const resolveInbox = (raw0: string): InboxNote | null => {
  let name = raw0;
  try { name = decodeURIComponent(raw0); } catch { /* keep raw */ }
  return getInboxNote(name) ?? getInboxNote(raw0);
};

app.get("/review/triage/:name", async (c) => {
  const memo = resolveInbox(c.req.param("name"));
  if (!memo) return c.html(await renderReview({ ok: false, msg: "inbox note not found (already triaged?)" }), 404);
  return c.html(renderTriageForm(memo, c.req.query("funnel") ?? "memo", getScopes()));
});

app.post("/review/triage/:name", async (c) => {
  const memo = resolveInbox(c.req.param("name"));
  if (!memo) return c.html(await renderReview({ ok: false, msg: "inbox note not found (already triaged?)" }), 404);
  const body = await c.req.parseBody();
  const inboxRel = vaultRel(VAULT_SUBDIR, "inbox", `${memo.name}.md`);

  if (String(body.action) === "discard") {
    try {
      await gitStore().commit({ ops: [{ op: "delete", path: inboxRel }] }, { message: `triage: discard inbox/${memo.name}` });
      invalidate();
      return c.html(await renderReview({ ok: true, msg: `✕ discarded “${memo.title}”` }));
    } catch (e) {
      return c.html(await renderReview({ ok: false, msg: `✗ discard failed: ${(e as Error).message}` }), 409);
    }
  }

  // File it: build the typed note from the chosen funnel + submitted fields.
  const funnelId = String(body.funnel ?? "memo");
  const funnel = funnelById(funnelId);
  if (!funnel) return c.html(await renderReview({ ok: false, msg: `unknown funnel ${funnelId}` }), 400);
  const input: Record<string, string> = {};
  for (const fl of funnel.fields) input[fl.key] = String(body[fl.key] ?? "").trim();
  const missing = funnel.fields.filter((fl) => fl.required && !input[fl.key]).map((fl) => fl.label);
  if (missing.length) {
    return c.html(renderTriageForm(memo, funnelId, getScopes(), input, `missing required: ${missing.join(", ")}`), 400);
  }

  // Filing a TASK is not "make a note" — a task is a line, and it is filed by
  // living in its scope's note ([[Tags]]). So the changeset appends the atom to
  // that note and drops the inbox memo, in one op. With no scope picked there's
  // nothing to append to, so it falls through and files as its own note, which
  // still leaves a real (if scopeless) atom rather than losing the capture.
  const scopeKey = funnel.fields.find((fl) => fl.type === "scope")?.key;
  const target = scopeKey ? input[scopeKey] : "";
  if (funnel.id === "task" && target && noteExists(target)) {
    const raw = readNoteRaw(target);
    if (!raw) return c.html(await renderReview({ ok: false, msg: `✗ could not read “${target}”` }), 409);
    const line = taskLine(input);
    // A task is one line, so any DETAIL the capture carried has nowhere to go on
    // the scope note. Rather than drop it with the memo, it becomes a memo note
    // of its own in the same op — the action files, the context keeps. Clear the
    // detail field at the desk and only the atom lands.
    const detail = input.body?.trim() ?? "";
    const keep = detail ? uniqueDest(input.title || memo.title || "note") : null;
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
          body: `${scopeLink(target)}# ${input.title}\n\n${detail}`,
        }),
      });
    }
    try {
      const res = await gitStore().commit({ ops }, {
        message: `triage: task → ${target}${keep ? ` (+ memo ${keep.name})` : ""} ← inbox/${memo.name}`,
      });
      invalidate();
      return c.html(await renderReview({
        ok: true,
        msg: `✓ filed atom → ${target}${keep ? `, detail kept as ${keep.name}` : ""} (op ${res.id.slice(0, 8)})`,
      }));
    } catch (e) {
      return c.html(await renderReview({ ok: false, msg: `✗ file failed: ${(e as Error).message}` }), 409);
    }
  }

  const note = funnel.build(input);
  if (memo.createdISO) note.frontmatter = { created: memo.createdISO, ...note.frontmatter }; // preserve capture time
  const content = compose(note);
  const dest = uniqueDest(note.title || memo.title || "note");
  try {
    const res = await gitStore().commit(
      { ops: [{ op: "delete", path: inboxRel }, { op: "put", path: dest.rel, content }] },
      { message: `triage: ${funnel.id} ← inbox/${memo.name}` },
    );
    invalidate();
    return c.html(await renderReview({ ok: true, msg: `✓ filed as ${funnel.id} → ${dest.name} (op ${res.id.slice(0, 8)})` }));
  } catch (e) {
    return c.html(await renderReview({ ok: false, msg: `✗ file failed: ${(e as Error).message}` }), 409);
  }
});

app.get("/review", async (c) => c.html(await renderReview()));

app.post("/review/approve", async (c) => {
  const id = String((await c.req.parseBody()).id ?? "").trim();
  const p = await getProposal(id);
  if (!p || p.status !== "pending") return c.html(await renderReview({ ok: false, msg: "proposal not found or already handled" }), 404);
  try {
    const res = await applyProposal(p);
    return c.html(await renderReview({ ok: true, msg: `✓ approved & applied — op ${res.id.slice(0, 8)} (${res.paths.length} path${res.paths.length === 1 ? "" : "s"})` }));
  } catch (e) {
    return c.html(await renderReview({ ok: false, msg: `✗ apply failed: ${(e as Error).message}` }), 409);
  }
});

app.get("/review/:id/edit", async (c) => {
  const p = await getProposal(c.req.param("id"));
  if (!p || p.status !== "pending") return c.html(await renderReview({ ok: false, msg: "proposal not found or already handled" }), 404);
  return c.html(renderEditForm(p));
});

app.post("/review/:id/edit", async (c) => {
  const id = c.req.param("id");
  const p = await getProposal(id);
  if (!p || p.status !== "pending") return c.html(await renderReview({ ok: false, msg: "proposal not found or already handled" }), 404);
  const body = await c.req.parseBody();
  const intent = String(body.intent ?? "").trim() || p.intent;
  const changeset = p.changeset.map((op, i) =>
    op.op === "put" ? { ...op, content: String(body[`content_${i}`] ?? op.content) } : op,
  );
  const updated = await updateProposal(id, { intent, changeset });
  if (String(body.action) === "approve" && updated) {
    try {
      const res = await applyProposal(updated);
      return c.html(await renderReview({ ok: true, msg: `✓ edited, approved & applied — op ${res.id.slice(0, 8)}` }));
    } catch (e) {
      return c.html(await renderReview({ ok: false, msg: `✗ apply failed: ${(e as Error).message}` }), 409);
    }
  }
  return c.html(await renderReview({ ok: true, msg: `proposal ${id.slice(5, 13)} updated` }));
});

app.post("/review/send-back", async (c) => {
  const body = await c.req.parseBody();
  const id = String(body.id ?? "").trim();
  const feedback = String(body.feedback ?? "").trim();
  const p = await getProposal(id);
  if (!p || p.status !== "pending") return c.html(await renderReview({ ok: false, msg: "proposal not found or already handled" }), 404);
  await updateProposal(id, { status: "returned", feedback });
  return c.html(await renderReview({ ok: true, msg: `↩ sent back${feedback ? " with feedback" : ""} — agents fetch it via GET /proposals?status=returned` }));
});

app.post("/review/reject", async (c) => {
  const id = String((await c.req.parseBody()).id ?? "").trim();
  const p = await getProposal(id);
  if (!p || p.status !== "pending") return c.html(await renderReview({ ok: false, msg: "proposal not found or already handled" }), 404);
  await setStatus(id, "rejected");
  return c.html(await renderReview({ ok: true, msg: `proposal ${id.slice(5, 13)} rejected` }));
});

// ── JSON API (programmatic / legacy) ────────────────────────────────────────
app.get("/scopes", (c) => c.json({ scopes: getScopes() }));
app.post("/notes", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { content?: string; scope?: string };
  if (!b.content || !b.scope) return c.json({ error: "content and scope are required" }, 400);
  return c.json(await createNote({ content: b.content, scope: b.scope }), 201);
});
app.get("/health", (c) => c.json({ ok: true, sync: gitStore().status() }));

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

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`braindance admin app on :${port}`);
