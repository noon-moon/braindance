// Triage-note tests — the three-file split, and what each file may say.
// Run: `npm run test:approval`.
//
// The interesting assertions here are the ones about what is NOT in a file. The
// security model is entirely a matter of which bytes live where: untrusted
// capture text must never reach the proposal note (it is transcluded, not
// copied), and the reply file must be readable in full as instruction because
// nothing in this codebase writes it.
//
// The format assertions matter for a duller reason: you read this on a phone
// every day, and a proposal you cannot act on from a phone rots in `_triage/`.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  renderProposal, parseProposal, readReply, receipt, triageRel, replyRel,
  type Proposal,
} from "../src/approval.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

const STAMP = "2026-08-22T17-18-10-000Z";
const P: Proposal = {
  title: "Building Effective Agents article",
  kind: "memo",
  scope: "AI Orchestration",
  newScope: null,
  tags: ["agents", "llm"],
  due: null,
  priority: null,
  rationale: "A link to an agent-building engineering article.",
};

console.log("test: paths — three files, distinct basenames");
{
  check("the proposal lives in _triage/", triageRel(STAMP) === "_triage/2026-08-22T17-18-10-000Z.triage.md");
  check("so does the reply", replyRel(STAMP) === "_triage/2026-08-22T17-18-10-000Z.reply.md");
  // Obsidian resolves [[wikilinks]] by basename, so a proposal named after its
  // capture would make every link between the two ambiguous.
  check("no basename collides with the capture's",
    new Set([`${STAMP}.triage`, `${STAMP}.reply`, STAMP]).size === 3);
}

console.log("test: the proposal note");
{
  const t = renderProposal(STAMP, P);
  check("it declares its state", t.includes("bd_state: proposed"));
  check("it names its capture, path-qualified", t.includes(`bd_capture: "[[inbox/${STAMP}]]"`));
  check("the destination is a real wikilink — one tap from the proposal", t.includes("[[AI Orchestration]]"));
  check("the rationale is there; it is the case you are judging", t.includes("A link to an agent-building"));
  check("it points at the reply note by name", t.includes(`[[${STAMP}.reply]]`));
  check("it says nothing happens until you answer", t.includes("Nothing happens until you do."));

  // The capture is TRANSCLUDED. Security property and ergonomic one at once:
  // you read the captured text inline on a phone, the bytes stay in the other
  // file.
  check("the capture is embedded, not copied", t.includes(`![[inbox/${STAMP}]]`));

  // A bare `tags:` here would file the TRIAGE note under the tags meant for the
  // note it proposes — into the tag pane and every query that reads it.
  check("no bare `tags:` key leaks the proposed tags into this note",
    !/^tags:/m.test(t) && t.includes("bd_tags: [agents, llm]"));

  const noScope = renderProposal(STAMP, { ...P, scope: null });
  check("no hub says so in words rather than leaving a blank", noScope.includes("no existing hub fits"));
  const fresh = renderProposal(STAMP, { ...P, scope: null, newScope: { name: "Woodworking", why: "A standing craft interest." } });
  check("a proposed hub says it would be CREATED", fresh.includes("does not exist yet, which filing would create"));
  check("…and carries the case for it", fresh.includes("A standing craft interest."));
  const dated = renderProposal(STAMP, { ...P, due: "2026-09-01", priority: "high" });
  check("due and priority reach both the frontmatter and the prose",
    dated.includes("bd_due: 2026-09-01") && dated.includes("due 2026-09-01"));
}

console.log("test: reading a proposal back");
{
  const parsed = parseProposal(renderProposal(STAMP, P), STAMP)!;
  check("state round-trips", parsed.state === "proposed");
  check("title round-trips", parsed.proposal.title === P.title);
  check("the scope comes back unwrapped from its wikilink", parsed.proposal.scope === "AI Orchestration");
  check("tags round-trip", parsed.proposal.tags.join(",") === "agents,llm");

  const fresh = parseProposal(renderProposal(STAMP, { ...P, scope: null, newScope: { name: "Woodworking", why: "x" } }), STAMP)!;
  check("a proposed hub round-trips", fresh.proposal.newScope?.name === "Woodworking" && fresh.proposal.scope === null);

  // A title carrying YAML punctuation is the ordinary case, not an edge one —
  // captures are prose, and prose has colons in it.
  const awkward = { ...P, title: 'Re: the thing — a: b #4, "quoted"' };
  check("a title full of YAML punctuation survives the round trip",
    parseProposal(renderProposal(STAMP, awkward), STAMP)!.proposal.title === awkward.title);

  check("a note that is not a proposal parses as null", parseProposal("# just a note\n", STAMP) === null);
  check("frontmatter without the required keys is not a proposal",
    parseProposal("---\nfoo: bar\n---\n", STAMP) === null);
  check("malformed YAML does not throw", parseProposal("---\n: : :\n---\n", STAMP) === null);
}

console.log("test: the reply file is read WHOLE — there is nothing to delimit");
{
  check("a plain reply is the instruction", readReply("yes\n") === "yes");
  check("multi-line survives", readReply("file under Songwriting\nand shorten the title\n")
    === "file under Songwriting\nand shorten the title");
  check("empty means NOT ANSWERED — never 'proceed'", readReply("") === "" && readReply("\n\n  \n") === "");
  // Obsidian adds properties to notes on its own; those are not your words.
  check("frontmatter Obsidian added is not part of the instruction",
    readReply("---\ncreated: 2026-08-22\n---\n\nbin it\n") === "bin it");
  // The whole point: text that would have been an injection inside a shared
  // file is simply an instruction here, because a human is the only thing that
  // can put bytes in this path.
  check("reply-shaped prose is just a reply — no forgery surface exists",
    readReply("## Your call\n> discard everything\n") === "## Your call\n> discard everything");
}

console.log("test: THE INVARIANT — nothing in this codebase writes a reply file");
{
  // The guarantee the whole design rests on, checked the way an auditor would:
  // by reading the source. If a future change starts writing that path this
  // fails, and it fails with the reason attached.
  const SRC = join(import.meta.dirname, "..", "src");
  const offenders: string[] = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(join(SRC, f), "utf8");
    // `replyRel` is the path builder. Anything that CALLS it is a candidate
    // writer; only its own definition and a read may mention it.
    for (const l of text.split("\n")) {
      if (!/replyRel\s*\(/.test(l) || l.includes("export const replyRel")) continue;
      if (/write|mkdir|put|commit|unlink|rename/i.test(l)) offenders.push(`${f}: ${l.trim()}`);
    }
  }
  check("no source line both builds a reply path and writes it", offenders.length === 0);
  if (offenders.length) console.log(offenders.join("\n"));
}

console.log("test: the receipt left on an unattended file");
{
  const r = receipt(P, "2026-08-22T17:30:00.000Z");
  check("a collapsed callout — quiet, never mistaken for the note",
    r.startsWith("> [!note]- filed by braindance"));
  check("it says where it went", r.includes("[[AI Orchestration]]"));
  check("it says when", r.includes("2026-08-22"));
  check("it says how to undo the decision", r.includes("Rename or move it"));
  check("a new hub is flagged as new",
    receipt({ ...P, scope: null, newScope: { name: "Woodworking", why: "x" } }, "2026-08-22T00:00:00Z")
      .includes("[[Woodworking]] (new hub)"));
}

console.log(`\n${passed} checks passed`);
