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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compose, funnelById, type BuiltNote } from "./funnels.js";
import { isArmed, stripMarker, type Proposal } from "./approval.js";
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
export function fileNote(p: Proposal, captureBody: string): BuiltNote & { content: string } {
  const funnel = funnelById(p.kind) ?? funnelById("memo")!;
  // A `todo` has no note shape here — tasknotes.ts owns it and the applier
  // routes there. Reaching this with one is a caller bug, and a loud one beats
  // a memo quietly written where a task was meant.
  if (!funnel.build) throw new Error(`${funnel.id} does not build a note — file it through tasknotes.ts`);
  // Order is meaning and is kept: `containment()` writes them in this order and
  // the first is the hub the note primarily belongs to.
  const scope = [...(p.newScope ? [p.newScope.name] : []), ...p.scopes].join(", ");
  const built = funnel.build!({
    title: p.title,
    // The marker must NOT survive filing. A capture's body is copied verbatim
    // into the note it becomes, so an armed one would ride along — and a filed
    // note carrying it gets proposed and filed again, every pass, forever.
    body: stripMarker(captureBody),
    containedBy: scope,
    due: p.due ?? "",
    priority: p.priority ?? "",
  });
  return { ...built, content: `${compose(built).trimEnd()}\n` };
}

/** A brand-new hub, written the way the `scope` funnel writes one — the same
 *  build(), so a hub minted by the applier is byte-for-byte the shape of one
 *  typed by hand. NOT `ingestable`: that tag is what puts a hub in a capture
 *  picker, and a hub minted while filing one note is a destination, not
 *  somewhere you have thought at yet. */
export const mintHub = (name: string, why: string): string =>
  compose(funnelById("scope")!.build!({ title: name, body: why }));

/** Does this note ask to be classified? One marker for the whole loop — see
 *  `MARKER` in approval.ts for why arming is a deleted character. */
export const isCapture = isArmed;

/** Every capture waiting, vault-relative.
 *
 *  Scans the root and one level down, skipping underscore directories for the
 *  reason every other scan in this codebase does — `_meta`, `_templates` and
 *  `_triage` hold machinery, and `_ephemeral` is 264 MB of scratch that must
 *  never be walked. */
export function findCaptures(vaultDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(join(vaultDir, dir), { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!dir && !e.name.startsWith("_") && !e.name.startsWith(".")) walk(rel, rel);
        continue;
      }
      if (!e.name.endsWith(".md")) continue;
      try {
        if (isCapture(readFileSync(join(vaultDir, rel), "utf8"))) out.push(rel);
      } catch { /* unreadable */ }
    }
  };
  walk("", "");
  return out.sort();
}
