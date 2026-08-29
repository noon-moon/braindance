# The triage loop

How a thought becomes a filed note, and what runs where. Read this when you are
working on the classifier, the applier, or anything the timer touches.

## The shape

```
Obsidian     write a note, anywhere → arm it: #capture
   ↓ obsidian-git
VPS          ops/applier.sh, every minute:
               pull → classify what is armed  → _triage/<key>.triage.md
                    → act on answered proposals → the filed note
             → commit → push
   ↓ obsidian-git
Obsidian     read the proposal, answer in it, arm it → filed
```

**Obsidian is the whole interface**, identically on a phone and at the desk, and
git is the only transport. Nothing serves HTTP; nothing has a UI.

## The marker

One keyword for the loop, and it means **proceed**. Which step depends on the
file it is in: on a capture, "classify this"; on a proposal, "act on my answer".

| | |
|---|---|
| `##capture` | inert — not a tag to Obsidian, not a signal to us |
| `#capture` | armed — a real Obsidian tag, and the signal to act |

**Arming is deleting one character.** That is the whole point of the pair. A
template can stamp the disarmed form into every new note without queueing
anything; the note carries a visible reminder of what to do with it; and a note
you are three words into still has two hashes, so nothing is ever read
mid-writing. No quiescence window, no clock to get wrong.

Armed it is a real tag on purpose — Obsidian's own search and tag pane show you
everything waiting, with no view to build.

The pair is for **captures**, which is where it earns its keep. A proposal stamps
no marker at all: an answer is one line typed in one go, so you type `#capture`
after it, and the note carries no machine text you did not put there.

## Nothing files unattended

Every capture gets a proposal; every filing is one you approved. The alternative
— high-confidence captures filing themselves — was considered and dropped: it
needs a threshold tuned against a number the model invents about itself.

A proposal is a note in `_triage/`. You answer in its `## Your call` section and
arm the marker. `_triage/` is therefore a queue of things that are **not done**,
and it empties itself: on a successful file or discard the capture and the
proposal are deleted in the same commit as the filed note. An empty `_triage/`
means nothing is pending.

What lingers is deliberate: a proposal awaiting your answer, one marked
`unclear` (with the question on its heading and your marker disarmed), one
`failed` (with a retry time), and one `dead` — four failed attempts, given up,
kept because it is the only record that a capture was abandoned. Deleting a
failure note is how you say "try again".

## What is enforced by shape

- **The reply boundary is `safe()`.** The reply is the `## Your call` section, so
  a captured article could forge one by emitting a line starting `## Your call`.
  `safe()` guarantees no model-derived string reaching a note body contains a
  newline, and a heading needs a line start. That is the entire boundary, it is
  one function, and `approval.test.ts` asserts it by name.
- **The intent call never sees the capture.** It is the one call whose output has
  authority — it can delete a note — so the untrusted text is not in the request
  at all. Everything a reply plausibly changes is already in the proposal; a
  reply that genuinely needs the note re-read returns `reclassify`, which runs
  the classifier again with its own fencing.
- **Nothing the model says is taken at its word.** `validate()` and
  `validateAction()` check every value against the live vault: a scope must be a
  live ingestable hub, a proposed hub must not already be a name on disk, a date
  must be a real day, a priority must be one TaskNotes actually defines. Anything
  ambiguous degrades to `unclear` — never to `file`.
- **The prose is never rewritten.** The model is asked about metadata. The body
  that lands is the body you captured, verbatim, minus the marker.

`suggest.ts` names the one guarantee that was **given up**: it used to write only
to a sidecar outside the vault, so nothing it produced could reach the vault
except through a click. That surface only existed on a desk. What replaces it is
that nothing files without an armed answer.

## Cost

A pass with nothing armed makes **no model call** — it is a filesystem scan and a
`git pull`, which is why a one-minute cadence is affordable. A capture costs one
classify (~3,200 in / ~100 out) plus one intent call (~2,000 / ~80) when you
answer it.

Three things bound the spend, and all three exist because a bill with no symptom
is the failure this loop keeps designing against:

- `--limit` (default 10) caps captures per pass; whatever it skips is named.
- `bd_asked` records an answer already judged unreadable, so it costs nothing to
  skip rather than a model call to re-read.
- A failed capture backs off exponentially and dies after four **note-level**
  failures. A 5xx, a rate limit or a bad key is a verdict on nothing, so it moves
  the backoff and never the counter — conflating those once turned a
  fifteen-minute outage into a permanently dead queue.

`usage.ts` reports what each pass actually used, in tokens rather than dollars:
prices move, and a figure baked into the code would be quietly wrong forever.

## Tasks are TaskNotes notes

A task is a **note** in TaskNotes' folder with metadata in frontmatter, not a
`- [ ] … #task` line. `tasknotes.ts` reads the plugin's own
`.obsidian/plugins/tasknotes/data.json` for the folder, the statuses, the
priorities and the field mapping — all user-configured, so guessing produces a
note that looks right and is invisible to every view. This vault remaps the
plugin's `projects` key to `Contained By`, so a task names its scope the same way
every other note does.

## Failure reports into the vault

A pass that cannot complete writes `_triage/BRAINDANCE PASS FAILING.md` and
pushes it, so a broken box turns up in Obsidian like anything else — the stage it
died at, how long it has been failing, the last 2 KB of output, and what to
check. It **deletes itself on the next good pass**, so its presence always means
"broken right now". A timer whose failures live only in `journalctl` has the same
silent-bill problem the backoff exists to prevent.

Writability is checked on the first line, on stderr, because the failure note is
itself a file in the vault — reporting a problem through the thing the problem
breaks is how one permissions error became eight lines of git internals.

Install and knobs: [`../ops/README.md`](../ops/README.md).
