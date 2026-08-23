// Triage by linked notes — the agent proposes in one file, you answer in it.
//
// Two files per ambiguous capture:
//
//   <wherever>/<name>.md          THE CAPTURE.  Yours. Untrusted (a pasted
//                                 article may contain "file this under
//                                 Personal"). The agent READS it as data and
//                                 never writes a byte of it, so it files
//                                 byte-identical to how you wrote it.
//   _triage/<name>.triage.md      THE PROPOSAL. The agent writes it; you answer
//                                 in its `## Your call` section.
//
// ── HOW THIS SHAPE WAS ARRIVED AT ───────────────────────────────────────────
//
// Three revisions, and the third was decided by watching someone use the second.
//
//  1. Proposal and reply inside the capture, fenced by markers. Worked; put
//     machine text in notes you keep, and neutralising the untrusted body was a
//     permanent obligation.
//  2. Proposal and reply as SEPARATE notes, the reply in a file nothing here
//     writes. The strongest guarantee available: an auditor checks one line.
//     On first contact the user answered in the proposal note and deleted the
//     line pointing at the reply note. It would have waited forever, silently.
//     A boundary nobody uses is not a boundary, and a system that quietly
//     ignores you is worse than one with a weaker guarantee.
//  3. This. You answer where the question is, because that is what people do.
//
// ── THE INVARIANT THAT REPLACES IT ──────────────────────────────────────────
//
// The reply is the `## Your call` section. For a capture to forge one, the model
// would have to emit a line beginning `## Your call` — which requires a NEWLINE
// in a model-derived string reaching the body.
//
// **`safe()` guarantees no model-derived string contains a newline.** That is
// the whole boundary, it is one function, and `approval.test.ts` asserts it by
// name. Revision 1 had the same property by ACCIDENT — `str()` in suggest.ts
// collapses whitespace while nominally just capping length, and nothing said
// "don't change this or the trust boundary opens". Here it is the stated job of
// a function that exists for no other reason.
import matter from "gray-matter";

/** Where the agent's side lives. Underscore-prefixed, so the vault's existing
 *  scans skip it for the same reason they skip `_meta` and `_templates` — these
 *  are machinery, not notes, and must never read as real work. Tracked, not
 *  gitignored: the whole point is that it reaches the phone. */
export const TRIAGE_DIR = "_triage";

/** The reply section's heading. Matched by PREFIX, and the prompt text lives on
 *  this line rather than under it — anything below the heading is yours, so a
 *  prompt sitting there would be read back as if you had written it. (The first
 *  version put two lines of instructions in the section. The user deleted them
 *  and typed in their place, which is exactly the right instinct and exactly
 *  what a parser must not have to guess about.) */
const REPLY_HEADING = "## Your call";
const REPLY_PROMPT = `${REPLY_HEADING} — reply below: \`yes\`, or what to change`;

/** THE BOUNDARY. Every model-derived string that reaches the note BODY passes
 *  through here, and the guarantee is exactly one thing:
 *
 *      the result contains no newline.
 *
 *  A forged `## Your call` heading needs a line start. Nothing else in this
 *  module prevents one. If you change this function, you are changing the
 *  security model — see `approval.test.ts`, which says so in a test name. */
export const safe = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Frontmatter keys are `bd_`-prefixed for two reasons: they are unmistakably
 *  machine-owned at a glance, and — the load-bearing one — a bare `tags:` here
 *  would file the TRIAGE note under the tags meant for the note it proposes,
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
} as const;

/** A capture's KEY — its basename, which names the triage note beside it. Not a
 *  timestamp: a capture is whatever Obsidian wrote, wherever "default location
 *  for new notes" points, and it may well be called `Building Effective Agents`. */
export const keyOf = (captureRel: string): string =>
  captureRel.slice(captureRel.lastIndexOf("/") + 1).replace(/\.md$/, "");

export const triageRel = (key: string): string => `${TRIAGE_DIR}/${key}.triage.md`;

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
 *  quotes them), and anything with structural punctuation is quoted too. */
const scalar = (v: string): string =>
  /^[\w .\-/]+$/.test(v) ? v : `"${v.replace(/["\\]/g, "\\$&")}"`;

/** Render the proposal note.
 *
 *  The proposal is written TWICE on purpose: as frontmatter, which the agent
 *  reads back on the next pass, and as prose, which you read. The agent never
 *  re-parses its own prose — that text is model output derived from untrusted
 *  input, and running it back through a parser would launder it into something
 *  with authority. The frontmatter has been through `validate()`; the prose is
 *  for human eyes only. */
export function renderProposal(captureRel: string, p: Proposal): string {
  const key = keyOf(captureRel);
  const link = captureRel.replace(/\.md$/, "");
  const fm: string[] = [
    "---",
    `${K.state}: proposed`,
    `${K.capture}: "[[${link}]]"`,
    `${K.kind}: ${scalar(safe(p.kind))}`,
    `${K.title}: ${scalar(safe(p.title))}`,
  ];
  if (p.scope) fm.push(`${K.scope}: "[[${safe(p.scope)}]]"`);
  if (p.newScope) fm.push(`${K.newScope}: ${scalar(safe(p.newScope.name))}`);
  if (p.tags.length) fm.push(`${K.tags}: [${p.tags.map((t) => scalar(safe(t))).join(", ")}]`);
  if (p.due) fm.push(`${K.due}: ${safe(p.due)}`);
  if (p.priority) fm.push(`${K.priority}: ${safe(p.priority)}`);
  fm.push("---", "");

  const where = p.newScope
    ? `[[${safe(p.newScope.name)}]] — a hub that does not exist yet, which filing would create`
    : p.scope
      ? `[[${safe(p.scope)}]]`
      : "the vault root — no existing hub fits";
  const meta = [
    p.tags.length ? p.tags.map((t) => `\`${safe(t)}\``).join(" ") : "",
    p.due ? `due ${safe(p.due)}` : "",
    p.priority ? `priority ${safe(p.priority)}` : "",
  ].filter(Boolean);

  const body: string[] = [
    `# Triage — ${safe(p.title)}`,
    "",
    `**File as** a ${safe(p.kind)} under ${where}${meta.length ? `  ·  ${meta.join("  ·  ")}` : ""}`,
  ];
  if (p.newScope?.why) body.push("", `*New hub, because: ${safe(p.newScope.why)}*`);
  if (p.rationale) body.push("", `*${safe(p.rationale)}*`);
  body.push(
    "",
    REPLY_PROMPT,
    "",
    "",
    "---",
    "",
    "### The capture",
    "",
    // A TRANSCLUSION, not a copy. Obsidian renders the captured text inline so
    // you read the whole decision in one view, while the untrusted bytes stay in
    // the other file. Path-qualified, because a capture at the vault root and
    // this note would otherwise be two plausible targets for one basename.
    `![[${link}]]`,
    "",
  );
  return `${fm.join("\n")}${body.join("\n")}`;
}

export interface ParsedProposal {
  state: string;
  key: string;
  /** Vault-relative path of the capture, off the frontmatter link. */
  captureRel: string;
  proposal: Proposal;
}

const unlink = (s: string): string => s.replace(/^\[\[|\]\]$/g, "").trim();

/** Read a proposal note's frontmatter back — the agent's own validated output,
 *  never its prose. Returns null for anything that isn't one: `_triage/` is a
 *  shared address space, and a file that doesn't parse is not one to act on. */
export function parseProposal(text: string, key: string): ParsedProposal | null {
  let data: Record<string, unknown>;
  try {
    data = (matter(text).data ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string): string => (typeof data[k] === "string" ? (data[k] as string).trim() : "");
  const title = str(K.title);
  const kind = str(K.kind);
  const capture = str(K.capture);
  if (!str(K.state) || !title || !kind || !capture) return null;
  const newScopeName = str(K.newScope);
  return {
    state: str(K.state),
    key,
    captureRel: `${unlink(capture)}.md`,
    proposal: {
      title,
      kind,
      scope: str(K.scope) ? unlink(str(K.scope)) : null,
      newScope: newScopeName ? { name: newScopeName, why: "" } : null,
      tags: Array.isArray(data[K.tags]) ? (data[K.tags] as unknown[]).map(String) : [],
      due: str(K.due) || null,
      priority: str(K.priority) || null,
      rationale: "",
    },
  };
}

/** Your answer: the `## Your call` section, up to the next rule or heading.
 *
 *  Forgiving about HOW you wrote it — quoted, unquoted, one line or several,
 *  with the prompt left in place or deleted (deleting it is what actually
 *  happened, and is the more natural thing). A triage step that ignores what you
 *  typed over a stray angle bracket is worse than no triage step.
 *
 *  Not forgiving about WHERE it may come from. Only this section is read, and
 *  the LAST such heading wins, so text that reached the note some other way sits
 *  above the one the agent wrote. */
export function readReply(text: string): string {
  const lines = text.split("\n");
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith(REPLY_HEADING)) at = i;
  }
  if (at === -1) return "";
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*---\s*$/.test(l) || /^\s*#{1,6}\s/.test(l)) break;
    out.push(l.replace(/^\s*>\s?/, ""));
  }
  return out.join("\n").trim();
}

/** The receipt left on a note the agent filed WITHOUT asking — the low-salience
 *  footer, and the only mark it leaves on a note you keep.
 *
 *  A collapsed callout: quiet, impossible to mistake for the note's own content,
 *  at the bottom where it stays out of the way of what you wrote. It is the
 *  audit trail and the prompt to fix a wrong call; git history is the real undo. */
export function receipt(p: Proposal, atISO: string, note?: string): string {
  const where = p.newScope
    ? `[[${safe(p.newScope.name)}]] (new hub)`
    : p.scope
      ? `[[${safe(p.scope)}]]`
      : "the vault root";
  return [
    "> [!note]- filed by braindance",
    `> ${atISO.slice(0, 10)} · as a ${safe(p.kind)} under ${where}`,
    note ? `> ${safe(note)}` : "",
    p.rationale ? `> ${safe(p.rationale)}` : "",
    "> Wrong? Rename or move it like any note — this footer is just the record.",
  ].filter(Boolean).join("\n");
}
