// The applier — one pass over the triage queue.
//
// Reads captures and proposals, decides, writes. Deliberately NOT a server and
// deliberately not a git client: obsidian-git already commits and pushes
// whatever appears in the vault, from whichever client sees it first, so a
// process that files a capture has only to write the file. That is why there is
// no lease here, no reconcile, no adapter.
//
// The pass is idempotent and every step is guarded by state that lives in the
// vault, so running it twice does nothing twice.
import { compose, containment, funnelById, taskLine, appendTaskLine, type BuiltNote } from "./funnels.js";
import { receipt, type Proposal } from "./approval.js";
import type { Revision } from "./intent.js";

/** Apply the reply's diff to what was proposed. Absent keys mean "as proposed" —
 *  the model returns a diff precisely so that a reply saying nothing about the
 *  scope cannot quietly move it. */
export function reviseProposal(p: Proposal, r: Revision): Proposal {
  return {
    ...p,
    title: r.title ?? p.title,
    kind: r.funnel ? (funnelById(r.funnel)?.label.toLowerCase() ?? p.kind) : p.kind,
    // Naming any hub replaces the whole set rather than adding to it — "file it
    // under Songwriting and Phrases" is a statement about where it goes, not an
    // amendment to a list the person cannot see.
    scopes: r.scopes ?? (r.newScope ? [] : p.scopes),
    newScope: r.newScope ? { name: r.newScope, why: r.newScopeWhy ?? "" } : (r.scopes ? null : p.newScope),
    due: r.due !== undefined ? r.due : p.due,
    priority: r.priority !== undefined ? r.priority : p.priority,
  };
}

/** The note a filing produces, from the capture's own text and the proposal.
 *
 *  The PROSE IS NEVER REWRITTEN. The model is asked about metadata — where this
 *  goes and what it is called — and the body it files is the body you captured,
 *  verbatim. That is the containment story for everything the classifier could
 *  get wrong: a bad title is visible in a filename, a bad scope is one move to
 *  fix, and the thing you actually wrote is untouched either way.
 *
 *  The receipt rides at the bottom as a collapsed callout — the record of an
 *  unattended decision, and the prompt to correct it. */
export function fileNote(
  p: Proposal,
  captureBody: string,
  atISO: string,
  note?: string,
): BuiltNote & { content: string } {
  const funnel = funnelById(p.kind) ?? funnelById("memo")!;
  // Order is meaning and is kept: `containment()` writes them in this order and
  // the first is the hub the note primarily belongs to.
  const scope = [...(p.newScope ? [p.newScope.name] : []), ...p.scopes].join(", ");
  const built = funnel.build({
    title: p.title,
    body: captureBody.trim(),
    containedBy: scope,
    due: p.due ?? "",
    priority: p.priority ?? "",
  });
  return { ...built, content: `${compose(built).trimEnd()}\n\n${receipt(p, atISO, note)}\n` };
}

/** A brand-new hub, written the way the `scope` funnel writes one — the same
 *  build(), so a hub minted by the applier is byte-for-byte the shape of one
 *  typed by hand. NOT `ingestable`: that tag is what puts a hub in a capture
 *  picker, and a hub minted while filing one note is a destination, not
 *  somewhere you have thought at yet. */
export const mintHub = (name: string, why: string): string =>
  compose(funnelById("scope")!.build({ title: name, body: why }));

/** A task is a LINE in TaskNotes' predecessor model and a NOTE in TaskNotes'.
 *  Kept here so the applier has one place to change when the vault's task
 *  vocabulary finishes moving — see `_meta/Tags.md`. */
export const taskAtom = (p: Proposal): string =>
  taskLine({ title: p.title, due: p.due ?? "", priority: p.priority ?? "" });

export { appendTaskLine, containment };
