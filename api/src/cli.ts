// The applier, as a command. `tsx src/cli.ts propose <capture>` | `pass [--dry]`
//
// This replaces two scratch scripts that drifted the moment the module they
// called changed shape: `Proposal.scope` went plural and both kept building the
// singular field, failing at the first render with a type error a compiler would
// have caught the second it was written. A tool that operates on a vault has no
// business living outside the typecheck that guards the vault's own writers.
import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_PATH, VAULT_SUBDIR } from "./config.js";
import { suggestFor, scopeCatalogue, type Suggestion } from "./suggest.js";
import { funnelById } from "./funnels.js";
import { getIngestableScopesStrict, takenRootNames, invalidate } from "./vault.js";
import { slug, noteName } from "./notes.js";
import { intentOf, validateAction } from "./intent.js";
import { reviseProposal, fileNote, mintHub, stripCaptureTag, findCaptures } from "./applier.js";
import { renderTask, taskConfig } from "./tasknotes.js";
import {
  parseProposal, readReply, renderProposal, triageRel, keyOf, TRIAGE_DIR,
  markUnclear, alreadyAsked, isAnswered, type Proposal,
} from "./approval.js";

const VAULT = process.env.VAULT_PATH ?? join(REPO_PATH, VAULT_SUBDIR);
const abs = (rel: string): string => join(VAULT, rel);

/** A validated `Suggestion` as a `Proposal`. The one place the classifier's
 *  vocabulary is translated into the filer's, so a change to either shows up
 *  here rather than in three scripts. */
const asProposal = (s: Suggestion): Proposal => ({
  title: s.title,
  kind: funnelById(s.funnel)?.id ?? "memo",
  scopes: s.scope ? [s.scope] : [],
  newScope: s.newScope,
  tags: s.tags,
  due: s.due,
  priority: s.priority,
  rationale: s.rationale,
});

/** The vault's day, not UTC's. `toISOString()` rolls over mid-afternoon in the
 *  Americas, which would stamp a receipt with tomorrow — the same trap `TZ`
 *  already exists to close for `/todo`. */
function localISO(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace("Z", "");
}

/** The app's filing convention: a memo is found by its title and its link, so
 *  its filename is a legible slug; a HUB is addressed BY its filename, so it
 *  keeps the typed name. Collision-checked against the DIRECTORY, case-
 *  insensitively — the only test that can answer "would writing this truncate a
 *  note that already exists". */
function uniqueDest(title: string, asTyped: boolean): string {
  const base = asTyped ? noteName(title) : slug(title);
  const taken = takenRootNames();
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  return `${name}.md`;
}

async function propose(captureRel: string): Promise<void> {
  const text = readFileSync(abs(captureRel), "utf8");
  const p = asProposal(await suggestFor(text, scopeCatalogue()));
  mkdirSync(abs(TRIAGE_DIR), { recursive: true });
  const out = triageRel(keyOf(captureRel));
  writeFileSync(abs(out), renderProposal(captureRel, p));
  console.log(`proposed → ${out}`);
}

async function pass(dry: boolean): Promise<void> {
  let dir: string[];
  try {
    dir = readdirSync(abs(TRIAGE_DIR));
  } catch {
    console.log("nothing waiting"); return;
  }
  const now = localISO();
  for (const f of dir.filter((n) => n.endsWith(".triage.md"))) {
    const rel = `${TRIAGE_DIR}/${f}`;
    const key = f.replace(/\.triage\.md$/, "");
    const parsed = parseProposal(readFileSync(abs(rel), "utf8"), key);
    if (!parsed) { console.log(`skip ${key} — not a proposal`); continue; }

    const text = readFileSync(abs(rel), "utf8");
    const reply = readReply(text);
    if (!reply) { console.log(`wait ${key} — no answer yet`); continue; }
    // An answer is finished when it says so. Without this, obsidian-git commits
    // a half-typed one within a few minutes and it gets judged as if it were
    // the whole thought.
    if (!isAnswered(text)) { console.log(`wait ${key} — answered but not tagged #reply`); continue; }
    // An answer already judged unreadable costs nothing to skip and a model call
    // to re-read. On a timer that difference is the whole running cost.
    if (alreadyAsked(text, reply)) { console.log(`wait ${key} — already asked about this answer`); continue; }
    console.log(`\n── ${key}\n   reply: ${JSON.stringify(reply)}`);

    const scopes = getIngestableScopesStrict();
    // The vault's day, not UTC's — "friday" has to be resolved against the day
    // the person is living in, and UTC is already tomorrow for half of every
    // evening in the Americas. Same trap as the receipt stamp.
    const act = validateAction(
      await intentOf(reply, parsed.proposal, scopes, now.slice(0, 10)), scopes, takenRootNames());
    console.log(`   action: ${act.kind}${act.note ? ` — ${act.note}` : ""}`);
    if (act.kind === "unclear") {
      const q = act.note || "I could not tell what you meant";
      console.log(`   ask again: ${q}`);
      if (!dry) writeFileSync(abs(rel), markUnclear(text, `${q} — say \`yes\`, \`discard\`, or name a hub`, reply));
      continue;
    }
    if (act.kind === "reclassify") { console.log("   left for another pass"); continue; }

    if (!existsSync(abs(parsed.captureRel))) { console.log(`   capture missing — skipped`); continue; }

    if (act.kind === "discard") {
      console.log(`   discard ${parsed.captureRel} + ${rel}`);
      if (!dry) { unlinkSync(abs(parsed.captureRel)); unlinkSync(abs(rel)); }
      continue;
    }

    const p = reviseProposal(parsed.proposal, act.revised);
    const body = readFileSync(abs(parsed.captureRel), "utf8");
    const filedUnder = [...(p.newScope ? [p.newScope.name] : []), ...p.scopes];

    // A TODO is not a note with a checklist line in it — in this vault a task
    // IS a note, in TaskNotes' folder, with its metadata in frontmatter. The
    // capture's prose rides in that note's body, so detail that used to need a
    // memo of its own no longer does.
    const isTask = p.kind === "todo";
    const dest = isTask
      ? `${taskConfig().folder}/${noteName(p.title)}.md`
      : uniqueDest(p.title, p.kind === "scope");
    const content = isTask
      ? renderTask({ title: p.title, scopes: filedUnder, due: p.due, priority: p.priority,
                     body: stripCaptureTag(body), createdISO: now })
      : fileNote(p, body).content;

    console.log(`   file  → ${dest}`);
    if (p.newScope) console.log(`   mint  → ${noteName(p.newScope.name)}.md`);
    if (dry) { console.log(content.split("\n").map((l) => "   | " + l).join("\n")); continue; }
    if (p.newScope) writeFileSync(abs(`${noteName(p.newScope.name)}.md`), mintHub(p.newScope.name, p.newScope.why));
    mkdirSync(abs(dest.slice(0, dest.lastIndexOf("/"))), { recursive: true });
    writeFileSync(abs(dest), content);
    unlinkSync(abs(parsed.captureRel));
    unlinkSync(abs(rel));
    invalidate();
  }
}

/** Everything tagged and not yet proposed. The queue is the TAG, not a folder:
 *  a capture can be written anywhere Obsidian happens to put it, and nothing is
 *  ever picked up by accident. */
function pending(): string[] {
  const proposed = new Set<string>();
  try {
    for (const f of readdirSync(abs(TRIAGE_DIR))) {
      if (f.endsWith(".triage.md")) proposed.add(f.replace(/\.triage\.md$/, ""));
    }
  } catch { /* no queue yet */ }
  return findCaptures(VAULT).filter((rel) => !proposed.has(keyOf(rel)));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "propose" && rest[0]) await propose(rest[0]);
else if (cmd === "propose") {
  const todo = pending();
  if (!todo.length) console.log("nothing tagged #capture is waiting");
  for (const rel of todo) await propose(rel);
} else if (cmd === "find") {
  const todo = pending();
  console.log(todo.length ? todo.join("\n") : "nothing tagged #capture is waiting");
} else if (cmd === "pass") await pass(rest.includes("--dry"));
else {
  console.error("usage: cli.ts find | propose [<capture-path>] | pass [--dry]");
  process.exit(1);
}
