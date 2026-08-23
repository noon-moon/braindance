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
const REPLY_PROMPT = `${REPLY_HEADING} — reply below, then write \`##reply\` when you are done`;

/** The marker that says an answer is FINISHED — the mirror of `##capture`, and
 *  for the same reason. obsidian-git commits every few minutes, so without it a
 *  half-typed "file under Ph" syncs, gets judged unreadable, and leaves a mess
 *  the person has to clean up for the crime of saving. Writing the marker is the
 *  last act, so nothing is ever read mid-thought.
 *
 *  DOUBLE hash, and not a tag at all. `#reply` and `#capture` would be real
 *  Obsidian tags: in the tag pane, in search, in the graph, and in the
 *  autocomplete of every note the user ever writes — a permanent addition to
 *  their vocabulary in exchange for a signal that means nothing outside this
 *  loop. `##reply` is inert to Obsidian and means something only here, which is
 *  exactly the right footprint for a piece of machinery. */
export const REPLY_MARKER = "reply";

/** Run `fn` over the prose of a note, leaving CODE alone.
 *
 *  Both markers are ordinary words with a hash in front, and this file writes
 *  one of them into every proposal it renders — the prompt line says to tag it
 *  `#reply`, in backticks. Without this, that line would make every proposal
 *  look answered the moment it was written. It is also simply correct: a note
 *  ABOUT braindance, quoting `#capture` in a code span, is not a capture. */
function overProse(text: string, fn: (s: string) => string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

/** Does this note carry `##name` in its prose?
 *
 *  Prose only, never code — this file writes `##reply` into every proposal it
 *  renders (the prompt says to), so without that exclusion every proposal would
 *  look answered the instant it existed. It is also just correct: a note ABOUT
 *  braindance quoting the marker is not a capture.
 *
 *  Frontmatter is deliberately NOT consulted. A `tags:` entry would be a real
 *  Obsidian tag, which is the pollution the double hash exists to avoid; letting
 *  it in through the back door would give the vocabulary back one note at a time.
 *
 *  `###name` does not match — a third hash means something else, and guessing
 *  which is not this function's business. */
export function hasMarker(text: string, name: string): boolean {
  const re = new RegExp(`(^|[^\\w/#-])##${name}(?![\\w/-])`, "u");
  let found = false;
  overProse(text, (part) => { if (re.test(part)) found = true; return part; });
  return found;
}

/** Remove `##name` from prose, taking the space BEFORE it rather than after —
 *  dropping the trailing one joins a mid-sentence removal to the next word
 *  across a line break. Code spans are left exactly as written. */
export const stripMarker = (text: string, name: string): string =>
  overProse(text, (part) =>
    part.replace(new RegExp(`(^|[ \\t])##${name}(?![\\w/-])`, "gmu"), ""))
    .replace(/[ \t]+$/gm, "")
    .trim();

/** Is the answer finished? */
export const isAnswered = (text: string): boolean => hasMarker(text, REPLY_MARKER);

/** A short fingerprint of an answer that has already been judged. Not for
 *  security — for THRIFT. Without it a reply the model cannot read costs a model
 *  call on every pass, forever, and on a timer that is a bill with no symptom.
 *  The same discipline the suggestion sidecar's retry/dead states exist for. */
export const replyFingerprint = (reply: string): string => {
  let h = 0;
  for (let i = 0; i < reply.length; i++) h = (Math.imul(31, h) + reply.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

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
  asked: "bd_asked",
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
  /** The hubs this would be filed under, in order — the FIRST is primary, the
   *  same rule `Contained By` follows everywhere else in the vault. Plural
   *  because the vault is: `slice-a-knot` carries three, `containment()` takes a
   *  list, and a single-valued field here silently dropped the second hub a
   *  reply asked for. Empty means the vault root. */
  scopes: string[];
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
  if (p.scopes.length) fm.push(`${K.scope}: [${p.scopes.map((x) => `"[[${safe(x)}]]"`).join(", ")}]`);
  if (p.newScope) fm.push(`${K.newScope}: ${scalar(safe(p.newScope.name))}`);
  if (p.tags.length) fm.push(`${K.tags}: [${p.tags.map((t) => scalar(safe(t))).join(", ")}]`);
  if (p.due) fm.push(`${K.due}: ${safe(p.due)}`);
  if (p.priority) fm.push(`${K.priority}: ${safe(p.priority)}`);
  fm.push("---", "");

  const where = p.newScope
    ? `[[${safe(p.newScope.name)}]] — a hub that does not exist yet, which filing would create`
    : p.scopes.length
      ? p.scopes.map((x) => `[[${safe(x)}]]`).join(" + ")
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
      // Accepts a list or a lone scalar: notes written before this went plural
      // carry `bd_scope: "[[Poetry]]"`, and a triage note already sitting in the
      // queue must not stop parsing because the schema moved under it.
      scopes: Array.isArray(data[K.scope])
        ? (data[K.scope] as unknown[]).map((x) => unlink(String(x))).filter(Boolean)
        : str(K.scope) ? [unlink(str(K.scope))] : [],
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
  return stripMarker(out.join("\n"), REPLY_MARKER);
}

/** Ask again, in the note, without touching what the person wrote.
 *
 *  Three things happen and each is load-bearing:
 *
 *   - The QUESTION goes on the heading line, where the prompt already lives, so
 *     the section below it stays entirely theirs. Their answer is left exactly
 *     as typed — it is what they meant, and the failure was in reading it.
 *   - `bd_state` becomes `unclear`, which is visible in Obsidian's properties
 *     panel: the note says it is stuck rather than sitting silently in a queue.
 *   - `bd_asked` records WHICH answer was already judged. The next pass compares
 *     it and spends nothing re-reading an unchanged one — without this, "not
 *     sure yet" costs a model call every tick until someone notices. */
export function markUnclear(text: string, question: string, reply: string): string {
  const fp = replyFingerprint(reply);
  let out = text.replace(/^bd_state:.*$/m, `${K.state}: unclear`);
  out = /^bd_asked:/m.test(out)
    ? out.replace(/^bd_asked:.*$/m, `${K.asked}: ${fp}`)
    : out.replace(/^bd_state:.*$/m, (m) => `${m}\n${K.asked}: ${fp}`);
  out = out.replace(
    new RegExp(`^${REPLY_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "m"),
    `${REPLY_HEADING} — ${safe(question)} · write \`##reply\` again when you have`,
  );
  // The marker means "finished". Asking again makes that untrue, so it goes —
  // otherwise the next keystroke of a corrected answer is read mid-edit, which
  // is the whole thing the marker exists to prevent.
  return stripMarker(out, REPLY_MARKER);
}

/** Has this answer already been judged unreadable? Cheap, local, no model call. */
export const alreadyAsked = (text: string, reply: string): boolean => {
  const m = text.match(/^bd_asked:\s*(\S+)\s*$/m);
  return Boolean(m && m[1] === replyFingerprint(reply));
};
