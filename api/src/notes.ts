// Naming. What a note is CALLED — a different question from where it goes and
// who writes it, both of which this file used to answer too, back when the api
// committed captures itself over the GitHub REST API. obsidian-git does the
// writing now and ops/applier.sh does the committing, so what is left is the
// two rules for turning a title into a filename.
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
