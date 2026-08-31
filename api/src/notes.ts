// Naming. What a note is CALLED — a different question from where it goes and
// who writes it, both of which this file used to answer too, back when the api
// committed captures itself over the GitHub REST API. obsidian-git does the
// writing now and ops/applier.sh does the committing, so what is left is the
// two rules for turning a title into a filename.
export const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

/** Not a filename any more — see `noteName`. Kept because the publish tool
 *  derives site URLs from titles, where lowercasing and hyphens are correct. */
export const slug = (s: string): string =>
  (s || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";

/** THE filename rule, for every note this loop writes.
 *
 *  It used to be one of two: hubs kept their typed name, memos were slugged, on
 *  the reasoning that a hub is addressed BY its filename while a memo is "found
 *  by its title and its link, and the filename is just a legible handle".
 *
 *  The second half was wrong in a flat vault. Obsidian resolves `[[wikilinks]]`
 *  by basename, so `[[Blood Child]]` never reaches `blood-child.md` — every
 *  slugged memo was unlinkable by the name it displays, and `docs/vault.md` had
 *  said "filename = note title" as an invariant the whole time.
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
