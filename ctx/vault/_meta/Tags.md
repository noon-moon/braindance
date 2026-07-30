---
tags:
  - scope
scope_kind: system
Contained By:
  - "[[Agent Context]]"
---

# Tag Definitions

## Note types

Two structural note types. Every note is one of these:

### `scope`
A hub note (MOC — Map of Content) for a topic. Scopes are structural: they exist to organise and link other notes. Key property: `Contains` and `Contained By` frontmatter fields linking to related scopes. The relationship is intentionally loose and encompasses "owns / owned by", "contains / contained by", and similar dual relationships.

Optional field: **`scope_kind`** — `content` (default, may be omitted) or `system`. A `content` scope is a user-topic hub (a project, a body of knowledge, a media collection). A `system` scope is the agent / infrastructure / meta layer — it describes *how the repo works*, not what it's *about* — e.g. [[Agent Context]], the generated [[Topics]] manifest, and this note. `scope_kind` is a dedicated field, **not** a stacked tag: it sub-classifies the `scope` type (parallel to `Contains`) rather than adding to the tag namespace. [[Topics]] renders content and system scopes in separate sections, and a content-scope search excludes `system` scopes unless they're explicitly granted (see [[Agent Context]]).

### `memo`
A permanent memorandum on a topic. Memos are substantive notes intended to persist indefinitely — reference material, decisions, observations. Not actionable in themselves.

## Behavioural tags

These stack on top of a note type rather than replacing it — any `scope` or `memo` can also carry one.

### `todo`
Marks a note as actionable. Stacks with the note type (e.g. `[memo, todo]`). Fields:

- `status` — `open`, `in-progress`, or `done`. When done, todos stay in place rather than being deleted; the record persists (see [[TODO]]'s Done section).
- `due` — optional ISO date (`2026-08-01`), a forward deadline. Drives the overdue / due-soon views and surfaces in that day's daily note.
- `completed` — optional wikilink to the daily note logging completion (`"[[2026-07-05]]"`), set when `status` flips to done. Links the finished work to the day it happened.
- `processed` — optional ISO date, used only with `recurring` (below).

[[TODO]] is the master view aggregating everything tagged `todo`. It needs the Dataview community plugin.

### `recurring`
Marks a standing routine that never truly closes. Stacks with `todo`. Instead of a deadline it carries `processed` (ISO date of the last pass); [[TODO]] surfaces it once a day has elapsed since. Bump `processed` to today when you do it.

### `daily`
Marks a daily note (in `daily/`, named `YYYY-MM-DD`). Daily notes are the log of what happened on a day, and the anchor that `due` / `completed` links point at. Enable the core Daily Notes plugin to create them.
