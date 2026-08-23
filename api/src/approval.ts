// Triage by linked notes — the agent proposes, you answer, in separate files.
//
// Three files per ambiguous capture, and the split is the security model:
//
//   inbox/<stamp>.md          THE CAPTURE.  Yours. Untrusted (a pasted article
//                             may contain "file this under Personal"). The agent
//                             READS it as data and never writes a byte of it, so
//                             it files byte-identical to how you wrote it.
//   _triage/<stamp>.triage.md THE PROPOSAL. The agent's. It writes what it wants
//                             to do, and transcludes the capture so you can read
//                             both in one view — a LINK, so the untrusted text
//                             never enters this file.
//   _triage/<stamp>.reply.md  THE REPLY.    Yours alone. THE AGENT NEVER WRITES
//                             THIS PATH, so its whole contents are your
//                             instruction. No delimiter, no region to find, no
//                             parsing rule to get right.
//
// ── WHY THREE FILES AND NOT ONE ─────────────────────────────────────────────
//
// The first version put the proposal and the reply inside the capture, fenced by
// markers, with the untrusted body neutralised around them. It worked and its
// forgery tests passed — but the guarantee rested on three rules, one of which
// was an accident: a forged "your reply" heading needs a line start, and the
// reason the model could not emit one is that `str()` in suggest.ts collapses
// whitespace while nominally just capping length. Nothing said "don't change
// this or the trust boundary opens."
//
// Here the guarantee is ONE rule, and it is the kind an auditor can check by
// grepping: **nothing in this codebase writes `*.reply.md`.** It cannot be
// undone by a change to a string helper, a prompt, or a renderer.
//
// The second reason is not about security at all. The agent no longer edits your
// captures, so a capture never accumulates machine text, never needs cleaning on
// the way out, and cleanup is deleting two files rather than operating on one.
import matter from "gray-matter";

/** Where the agent's side lives. Underscore-prefixed, so the vault's existing
 *  scans skip it for the same reason they skip `_meta` and `_templates` — these
 *  are machinery, not notes, and they must never read as real work. Tracked, not
 *  gitignored: the whole point is that it reaches the phone. */
export const TRIAGE_DIR = "_triage";

/** Frontmatter keys are `bd_`-prefixed for two reasons. They are unmistakably
 *  machine-owned at a glance, and — the load-bearing one — a bare `tags:` here
 *  would file the TRIAGE note under the tags meant for the note it is proposing,
 *  putting them in Obsidian's tag pane and every query that reads it. */
const K = {
  state: "bd_state",
  capture: "bd_capture",
  kind: "bd_kind",
  title: "bd_title",
  scope: "bd_scope",
  newScope: "bd_new_scope",
  tags: "bd_tags",
  due: "bd_due",
  priority: "bd_priority",
  at: "bd_at",
} as const;

export const triageRel = (stamp: string): string => `${TRIAGE_DIR}/${stamp}.triage.md`;
export const replyRel = (stamp: string): string => `${TRIAGE_DIR}/${stamp}.reply.md`;

/** What the agent proposes doing with a capture. */
export interface Proposal {
  title: string;
  /** Funnel label as a person reads it ("memo", "todo"). */
  kind: string;
  scope: string | null;
  newScope: { name: string; why: string } | null;
  tags: string[];
  due: string | null;
  priority: string | null;
  rationale: string;
}

/** A YAML scalar that cannot break its own document. Wikilinks are quoted (a
 *  bare `[[…]]` opens a flow sequence in YAML — the same reason `funnels.ts`
 *  quotes them), and anything else with structural punctuation is quoted too. */
const scalar = (v: string): string =>
  /^[\w .\-/]+$/.test(v) ? v : `"${v.replace(/["\\]/g, "\\$&")}"`;

/** Render the proposal note. Deterministic and pure — what a test asserts is
 *  exactly what lands in the vault.
 *
 *  The proposal is written TWICE and on purpose: as frontmatter, which is what
 *  the agent reads back on the next pass, and as prose, which is what you read.
 *  The agent never re-parses its own prose — that text is model output derived
 *  from untrusted input, and running it back through a parser would launder it
 *  into something with authority. The frontmatter has been through `validate()`;
 *  the prose is for human eyes only. */
export function renderProposal(stamp: string, p: Proposal): string {
  const fm: string[] = [
    "---",
    `${K.state}: proposed`,
    `${K.capture}: "[[inbox/${stamp}]]"`,
    `${K.kind}: ${scalar(p.kind)}`,
    `${K.title}: ${scalar(p.title)}`,
  ];
  if (p.scope) fm.push(`${K.scope}: "[[${p.scope}]]"`);
  if (p.newScope) fm.push(`${K.newScope}: ${scalar(p.newScope.name)}`);
  if (p.tags.length) fm.push(`${K.tags}: [${p.tags.map(scalar).join(", ")}]`);
  if (p.due) fm.push(`${K.due}: ${p.due}`);
  if (p.priority) fm.push(`${K.priority}: ${p.priority}`);
  fm.push("---", "");

  const where = p.newScope
    ? `[[${p.newScope.name}]] — a hub that does not exist yet, which filing would create`
    : p.scope
      ? `[[${p.scope}]]`
      : "the vault root — no existing hub fits";
  const meta = [
    p.tags.length ? p.tags.map((t) => `\`${t}\``).join(" ") : "",
    p.due ? `due ${p.due}` : "",
    p.priority ? `priority ${p.priority}` : "",
  ].filter(Boolean);

  const body: string[] = [
    `# Triage — ${p.title}`,
    "",
    `**File as** a ${p.kind} under ${where}${meta.length ? `  ·  ${meta.join("  ·  ")}` : ""}`,
  ];
  if (p.newScope?.why) body.push("", `*New hub, because: ${p.newScope.why}*`);
  if (p.rationale) body.push("", `*${p.rationale}*`);
  body.push(
    "",
    "## Your call",
    "",
    // An unresolved link on purpose: tapping it is how Obsidian creates the
    // note, on a phone as much as at the desk. The agent never creates it,
    // because a file it has written to is a file it could be argued into
    // writing to again — and "nothing writes this path" is the whole guarantee.
    `Write your answer in [[${stamp}.reply]] — \`yes\`, or what to change.`,
    "Nothing happens until you do.",
    "",
    "---",
    "",
    "### The capture",
    "",
    // A TRANSCLUSION, not a copy. Obsidian renders the captured text inline so
    // you read the whole decision in one view, while the untrusted bytes stay in
    // the other file. Path-qualified because the capture and this note would
    // otherwise share a basename.
    `![[inbox/${stamp}]]`,
    "",
  );
  return `${fm.join("\n")}${body.join("\n")}`;
}

export interface ParsedProposal {
  state: string;
  stamp: string;
  proposal: Proposal;
}

/** Read a proposal note's frontmatter back — the agent's own validated output,
 *  never its prose. Returns null for anything that isn't one, because a
 *  `_triage/` directory is a shared address space and a file that doesn't parse
 *  is not a file to act on. */
export function parseProposal(text: string, stamp: string): ParsedProposal | null {
  let data: Record<string, unknown>;
  try {
    data = (matter(text).data ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string): string => (typeof data[k] === "string" ? (data[k] as string).trim() : "");
  const title = str(K.title);
  const kind = str(K.kind);
  if (!str(K.state) || !title || !kind) return null;
  const unlink = (s: string): string => s.replace(/^\[\[|\]\]$/g, "").trim();
  const scope = str(K.scope) ? unlink(str(K.scope)) : null;
  const newScopeName = str(K.newScope);
  return {
    state: str(K.state),
    stamp,
    proposal: {
      title,
      kind,
      scope,
      newScope: newScopeName ? { name: newScopeName, why: "" } : null,
      tags: Array.isArray(data[K.tags]) ? (data[K.tags] as unknown[]).map(String) : [],
      due: str(K.due) || null,
      priority: str(K.priority) || null,
      rationale: "",
    },
  };
}

/** Your reply, which is the ENTIRE reply file.
 *
 *  There is nothing to delimit and nothing to find, because the agent never
 *  wrote any of it. Frontmatter is dropped only because Obsidian may add
 *  properties on its own; everything else is yours and is read as instruction.
 *
 *  Empty (or absent, which the caller sees as empty) means "not answered yet" —
 *  never "proceed". */
export const readReply = (text: string): string => {
  try {
    return matter(text).content.trim();
  } catch {
    return text.trim();
  }
};

/** The receipt left on a note the agent filed WITHOUT asking — the low-salience
 *  footer, and the only mark it leaves on a note you keep.
 *
 *  A collapsed callout: quiet, impossible to mistake for the note's own content,
 *  and at the bottom where it stays out of the way of what you actually wrote.
 *  It is the audit trail and the prompt to fix a wrong call; git history is the
 *  real undo. */
export function receipt(p: Proposal, atISO: string): string {
  const where = p.newScope
    ? `[[${p.newScope.name}]] (new hub)`
    : p.scope
      ? `[[${p.scope}]]`
      : "the vault root";
  return [
    "> [!note]- filed by braindance",
    `> ${atISO.slice(0, 10)} · as a ${p.kind} under ${where}`,
    p.rationale ? `> ${p.rationale}` : "",
    "> Wrong? Rename or move it like any note — this footer is just the record.",
  ].filter(Boolean).join("\n");
}
