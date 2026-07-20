import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { layout } from "./layout.js";
import { FUNNELS, funnelById, compose, type Field } from "./funnels.js";
import { commitCapture, createNote, stamp, slug } from "./notes.js";
import { VAULT_SUBDIR, vaultRel } from "./config.js";
import { seenRecently, contentHash } from "./dedup.js";
import { randomUUID } from "node:crypto";
import { submitProposal, listProposals, getProposal, setStatus, updateProposal, type Proposal, type ProposalStatus } from "./proposals.js";
import { getScopes, getNote, listNotes, backlinksFor, invalidate, noteExists } from "./vault.js";
import { listInbox, getInboxNote, type InboxNote } from "./inbox.js";
import { renderMarkdown } from "./render.js";
import { gitStore } from "./git.js";

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
  if (f.type === "scope")
    return html`<select name="${f.key}"${req}><option value=""></option>${scopes.map((s) => html`<option${sel(s)}>${s}</option>`)}</select>`;
  const t = f.type === "url" ? "url" : f.type === "date" ? "date" : f.type === "number" ? "number" : "text";
  return html`<input type="${t}" name="${f.key}"${req} placeholder="${ph}" value="${value}">`;
}

// The capture screen: a funnel-type dropdown + that funnel's fields. Changing
// the dropdown reloads with the selected type's fields (server-rendered).
// Web capture is untyped: everything drops into the inbox as a raw memo.
// The memo/todo/media/resource sorting now happens at triage/review, not here.
// (The typed funnel schema still lives on the JSON /ingest API.)
function captureForm() {
  const f = funnelById("memo") ?? FUNNELS[0];
  const scopes = getScopes();
  return layout(
    "capture",
    html`
      <h1>capture</h1>
      <form method="post" action="/ingest" class="capture-form">
        <input type="hidden" name="idem" value="${randomUUID()}">
        <input type="hidden" name="funnel" value="${f.id}">
        <div class="cap-fields">
          ${f.fields.map((fl) => html`<label>${fl.label} ${fl.required ? html`<span class="req">*</span>` : ""}</label>${control(fl, scopes)}`)}
        </div>
        <div class="cap-actions">
          <button class="btn" type="submit">capture</button>
        </div>
      </form>`,
    "capture",
  );
}

app.get("/", (c) => c.html(captureForm()));
// old per-funnel URLs fold into the single untyped capture form
app.get("/new/:funnel", (c) => c.redirect("/"));

// Shared capture: validate → build → de-dup → commit. Used by the web form
// (HTML) and the JSON API alike, so both behave identically.
type CaptureResult =
  | { kind: "ok"; path: string }
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
  return { kind: "ok", path };
}

// ── Capture: ingest → inbox/ (web form → HTML; JSON body → JSON, for the iOS
//    Share Sheet shortcut & other programmatic callers) ────────────────────────
app.post("/ingest", async (c) => {
  const wantsJson = (c.req.header("content-type") ?? "").includes("application/json");
  const raw = (wantsJson
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody()) as Record<string, unknown>;
  const funnelId = String(raw.funnel ?? "");
  const idem = raw.idem ? String(raw.idem).trim() : undefined;
  const res = await doCapture(funnelId, raw, idem);

  if (wantsJson) {
    if (res.kind === "ok") return c.json({ status: "captured", path: res.path }, 201);
    if (res.kind === "duplicate") return c.json({ status: "duplicate" }, 200);
    return c.json({ error: res.message }, 400);
  }
  if (res.kind === "error") {
    const back = funnelId ? `/?funnel=${encodeURIComponent(funnelId)}` : "/";
    return c.html(layout("missing", html`<p class="flash">${res.message}</p><p><a href="${back}">← back</a></p>`, "capture"), 400);
  }
  if (res.kind === "duplicate") {
    return c.html(layout("duplicate", html`
      <p class="flash">↩ duplicate ignored — this matches a capture just made.</p>
      <p><a href="/">＋ capture another</a> · <a href="/vault">browse vault</a></p>`, "capture"));
  }
  return c.html(layout("captured", html`
    <p class="flash">✓ captured → <code>${res.path}</code></p>
    <p><a href="/">＋ capture another</a> · <a href="/vault">browse vault</a></p>`, "capture"));
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
                <div class="meta">${n.createdISO ? fmtDate(n.createdISO) : ""}</div>
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

// Deterministic pre-fill (no LLM): the memo title → a `title` field, the memo
// body → the funnel's main text field, and a URL in the body → a `url` field.
function prefillFor(f: Field, memo: InboxNote): string {
  if (f.key === "title") return memo.title;
  if (f.type === "textarea") return memo.text;
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
        <div class="meta">from inbox · ${memo.createdISO ? fmtDate(memo.createdISO) : ""} · <code>${memo.name}</code></div>
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
