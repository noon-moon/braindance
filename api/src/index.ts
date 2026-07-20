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
import { getScopes, getNote, listNotes, backlinksFor, invalidate } from "./vault.js";
import { renderMarkdown } from "./render.js";
import { gitStore } from "./git.js";

const app = new Hono();

// ── Static assets ────────────────────────────────────────────────────────────
app.use("/favicon.png", serveStatic({ path: "./public/favicon.png" }));
app.use("/favicon.ico", serveStatic({ path: "./public/favicon.png" }));

// ── Capture: funnel picker (home) ───────────────────────────────────────────
app.get("/", (c) =>
  c.html(layout("capture", html`
    <h1>capture</h1>
    <div class="grid">
      ${FUNNELS.map((f) => html`<a class="card" href="/new/${f.id}"><strong>${f.label}</strong><div class="muted">${f.hint}</div></a>`)}
    </div>`)),
);

// ── Capture: funnel form ────────────────────────────────────────────────────
function control(f: Field, scopes: string[]) {
  const req = f.required ? raw(" required") : "";
  const ph = f.placeholder ?? "";
  if (f.type === "textarea") return html`<textarea name="${f.key}"${req} placeholder="${ph}"></textarea>`;
  if (f.type === "select")
    return html`<select name="${f.key}"${req}>${f.required ? "" : html`<option value=""></option>`}${(f.options ?? []).map((o) => html`<option>${o}</option>`)}</select>`;
  if (f.type === "scope")
    return html`<select name="${f.key}"${req}><option value=""></option>${scopes.map((s) => html`<option>${s}</option>`)}</select>`;
  const t = f.type === "url" ? "url" : f.type === "date" ? "date" : f.type === "number" ? "number" : "text";
  return html`<input type="${t}" name="${f.key}"${req} placeholder="${ph}">`;
}

app.get("/new/:funnel", (c) => {
  const f = funnelById(c.req.param("funnel"));
  if (!f) return c.notFound();
  const scopes = getScopes();
  return c.html(layout(f.label, html`
    <h1>${f.label}</h1>
    <form method="post" action="/ingest">
      <input type="hidden" name="funnel" value="${f.id}">
      <input type="hidden" name="idem" value="${randomUUID()}">
      ${f.fields.map((fl) => html`<label>${fl.label} ${fl.required ? html`<span class="req">*</span>` : ""}</label>${control(fl, scopes)}`)}
      <p><button class="btn" type="submit">[ capture → inbox ]</button></p>
    </form>`));
});

// ── Capture: ingest → main (ctx/vault/inbox/) ───────────────────────────────
app.post("/ingest", async (c) => {
  const body = await c.req.parseBody();
  const funnel = funnelById(String(body.funnel ?? ""));
  if (!funnel) return c.text("unknown funnel", 400);

  const input: Record<string, string> = {};
  for (const fl of funnel.fields) input[fl.key] = String(body[fl.key] ?? "").trim();

  const missing = funnel.fields.filter((fl) => fl.required && !input[fl.key]).map((fl) => fl.label);
  if (missing.length) {
    return c.html(
      layout("missing", html`<p class="flash">missing required: ${missing.join(", ")}</p><p><a href="/new/${funnel.id}">← back</a></p>`),
      400,
    );
  }

  const note = funnel.build(input);
  const composed = compose(note);

  // De-dup double-submits: identical content (any source) or a re-POST of the
  // same rendered form (idempotency token). Coalesce rather than commit twice.
  const idem = String(body.idem ?? "").trim();
  const keys = [`hash:${funnel.id}:${contentHash(composed)}`, ...(idem ? [`idem:${idem}`] : [])];
  if (keys.some((k) => seenRecently(k))) {
    return c.html(layout("duplicate", html`
      <p class="flash">↩ duplicate ignored — this matches a capture just made.</p>
      <p><a href="/">＋ capture another</a> · <a href="/vault">browse vault</a></p>`));
  }

  const path = vaultRel(VAULT_SUBDIR, "inbox", `${stamp()}-${slug(note.title)}.md`);
  await commitCapture(path, composed, `inbox: ${funnel.id} capture`);
  return c.html(layout("captured", html`
    <p class="flash">✓ captured → <code>${path}</code></p>
    <p><a href="/">＋ capture another</a> · <a href="/vault">browse vault</a></p>`));
});

// ── Vault viewer ────────────────────────────────────────────────────────────
app.get("/vault", (c) => {
  const notes = listNotes();
  return c.html(layout("vault", html`
    <h1>vault <span class="muted">(${notes.length})</span></h1>
    <ul class="notes">
      ${notes.map((n) => html`<li><a href="/vault/${encodeURIComponent(n.name)}">${n.name}</a> ${n.tags.slice(0, 3).map((t) => html`<span class="tag">${t}</span>`)}</li>`)}
    </ul>`));
});

app.get("/vault/:name", (c) => {
  const p = c.req.param("name");
  let name = p;
  try { name = decodeURIComponent(p); } catch { /* keep p */ }
  const note = getNote(name) ?? getNote(p);
  if (!note) {
    return c.html(layout(name, html`<p class="flash">no note “${name}”.</p><p><a href="/vault">← vault</a></p>`), 404);
  }
  const backlinks = backlinksFor(note.name);
  return c.html(layout(note.name, html`
    <h1>${note.name}</h1>
    <div class="meta">${note.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>
    <article class="note-body">${raw(renderMarkdown(note.body))}</article>
    ${backlinks.length ? html`<hr><h3>backlinks <span class="muted">(${backlinks.length})</span></h3><ul class="notes">${backlinks.map((b) => html`<li><a href="/vault/${encodeURIComponent(b)}">${b}</a></li>`)}</ul>` : ""}`));
});

// ── History: operation log + undo ───────────────────────────────────────────
const fmtDate = (iso: string): string => iso.slice(0, 16).replace("T", " ");

async function renderHistory(flash?: { ok: boolean; msg: string }) {
  const ops = await gitStore().history({ limit: 100 });
  return layout(
    "history",
    html`
      <h1>history <span class="muted">(${ops.length})</span></h1>
      ${flash ? html`<p class="flash ${flash.ok ? "" : "err"}">${flash.msg}</p>` : ""}
      <p class="muted">each capture, edit, and undo is one operation — revert creates a new undo commit.</p>
      ${ops.map(
        (o) => html`
          <div class="op">
            <div class="msg">
              <strong>${o.message}</strong>
              <div class="meta">
                ${fmtDate(o.date)} · <code>${o.id.slice(0, 8)}</code>${o.paths
                  .slice(0, 4)
                  .map((p) => html` <span class="tag">${p}</span>`)}${o.paths.length > 4
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
  return layout(
    "review",
    html`
      <h1>review <span class="muted">(${proposals.length})</span></h1>
      ${flash ? html`<p class="flash ${flash.ok ? "" : "err"}">${flash.msg}</p>` : ""}
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
  );
}

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
