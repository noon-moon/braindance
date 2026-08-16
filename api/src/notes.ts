// Capture writes — Slice 1: LOCAL-FIRST git model.
//
// Captures no longer PUT to the GitHub REST Contents API and wait on the
// network. They now land as a LOCAL commit in the api's read-write working
// checkout (see git.ts): write file → `git commit` locally (instant) → enqueue
// an async push to GitHub off the request path. The viewer reads the same
// working tree, so a capture is visible on the next read (no ≤3-min round-trip).
//
// Robustness is unchanged in spirit: unique timestamped capture paths mean two
// writes never touch the same file, so real merge conflicts are near-impossible;
// the old REST retry loop is replaced by the push queue's pull --rebase + retry
// (git.ts), now non-blocking and off the interactive path.
import { gitStore } from "./git.js";
import { invalidate } from "./vault.js";
import { VAULT_SUBDIR, vaultRel } from "./config.js";

/** Commit a capture file into the local checkout under `ctx/vault/inbox/` and
 *  enqueue the async push. `relPath` is repo-relative and must use
 *  filesystem-safe characters. Resolves when the LOCAL commit lands. */
export async function commitCapture(relPath: string, content: string, message: string): Promise<{ path: string }> {
  const res = await gitStore().commitCapture(relPath, content, message);
  invalidate(); // make the capture visible to the viewer immediately
  return res;
}

export const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

export const slug = (s: string): string =>
  (s || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";

/** A filename for a note whose NAME IS ITS IDENTITY — a scope hub.
 *
 *  `slug` is right for a memo: the note is found by its title and its link, and
 *  the filename is just a legible handle. It is wrong for a hub, because a hub is
 *  addressed BY that filename — it is what `Contains: "[[Woodworking]]"` points
 *  at, what the pickers list, and what the generated Topics manifest prints. Slug
 *  a hub and you get `woodworking`, so every link a person writes by hand reads
 *  as the wrong name at best, and the vault's own hubs (`Bass Practice`, `Music`)
 *  stop matching the ones this app creates.
 *
 *  So the typed name is kept, and only what a filename or a wikilink genuinely
 *  cannot hold is removed: the path separators, the wikilink alphabet
 *  (`parseScopes` strips the same set, for the same reason), a leading dot, and
 *  the control characters. Whitespace collapses; nothing is case-folded. */
export const noteName = (s: string): string =>
  (s || "")
    .replace(/[[\]|#/\\:*?"<>\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60)
    .trim() || "note";

// Legacy JSON endpoint: POST /notes { content, scope }
export async function createNote({ content, scope }: { content: string; scope: string }): Promise<{ path: string }> {
  const body = `---\ntags:\n  - ${scope}\n---\n\n${content}\n`;
  return commitCapture(vaultRel(VAULT_SUBDIR, "inbox", `${stamp()}.md`), body, `inbox: ${scope} capture`);
}
