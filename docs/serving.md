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
| `#capture` | armed — a real Obsidian tag, and the signal to act |

**You type it when the thought is finished**, and nothing else about a note
matters to this loop until you do. No quiescence window, no clock to get wrong.

There used to be a disarmed spelling, `##capture`, inert to Obsidian and to us,
so arming was deleting one character and a template could stamp the safe form
into every new note. It is gone: it was machinery for a habit nobody had, and
the protection it offered survives for a better reason — a note is invisible
until you type the word, and you type it when you are done. Old notes carrying
the retired spelling still read as unarmed, which is the only thing it has to do.

**Nothing here writes the marker on your behalf.** `markUnclear` used to disarm a
note it was handing back; it now removes the marker, because the honest way to
say "I could not read this" is to give the note back unarmed. The single
exception is a spawned capture (below), which is armed precisely so it cannot sit
in the vault unreviewed.

Armed it is a real tag on purpose — Obsidian's own search and tag pane show you
everything waiting, with no view to build.

The pair is for **captures**, which is where it earns its keep. A proposal stamps
no marker at all: an answer is one line typed in one go, so you type `#capture`
after it, and the note carries no machine text you did not put there.

## Notes the loop was asked to create

A reply can ask for another note — *"also add one for Parable of the Sower"* —
and the answer is a **capture**, not a filed note. It is written armed, so the
next pass classifies it, proposes a filing, and waits for you to answer that
proposal like any other.

That shape is the whole safety argument, and it is why there is no cap on how
many a reply may ask for: each one is reviewed before anything is filed, so the
review you already do is the review this needs. There is no second path to keep
in step with the first, because there is no second path.

It is the only model-authored prose that enters the vault, so it says so, in the
body: *"Asked for while triaging [[X]]. Written by the classifier, not by you."*
In the body rather than frontmatter deliberately — filing copies the body
verbatim and drops the rest, so provenance in frontmatter would disappear exactly
when it began to matter.

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

## The harness seam

The loop asks a model exactly two questions, and `api/src/harness.ts` is their
contract:

```
classify(note, scopes)                    →  where does this belong?
readIntent(reply, proposal, scopes, day)  →  what did they just tell me to do?
```

Everything else is already independent of who answers them — `validate` and
`validateAction` check values against the live vault, `nextFailure` decides what
a failure costs a note, every write goes through `approval.ts`. So a second
implementation is those two methods and nothing else. `BD_HARNESS` selects one;
`anthropic` is the only entry today.

**The signatures are the least of it.** Three obligations carry the risk, and
each is something this loop has already been broken by:

- **The failure taxonomy has an OS-level floor.** A harness reached over a
  process boundary reports an exit code and maybe a signal, none of which is a
  verdict on anything. `harness-subprocess.ts` settles that generically: every
  signal the operating system gives — a binary that isn't there, a kill, a
  crash, a timeout, any non-zero exit — is `transient`, and the only route to
  blaming a note is a clean exit whose output we then judge ourselves. That
  asymmetry is deliberate. Blaming a note is irreversible after four attempts;
  being too patient only costs retries, and `BD_DAILY_TOKENS` bounds those. An
  implementation may `refine` the verdict harsher (recognising its own refusal
  format) and may never make it softer.
- **The failure taxonomy IS the interface.** Every failure must arrive as one of
  three kinds, because `nextFailure` spends a note's four lives on the
  distinction: a `TransientError` (nothing to do with the note — a 5xx, a rate
  limit, a dead subprocess) never spends one; a `RefusalError` is fatal at once;
  a plain `Error` is a verdict on the note and spends one. Getting this backwards
  is what once turned a fifteen-minute outage into a permanently dead queue. A
  harness that reports failure as an exit code and a line of stderr has to map
  that onto these three, and **that mapping is what to test first**.
- **Usage must be real.** `record()` takes what the provider reported, never an
  estimate — the daily ceiling is computed from those numbers, and an unmetered
  harness is the exact shape of the incident that put the ceiling there.
- **Untrusted text stays data.** `classify` gets a capture someone may have
  pasted from the internet, fenced and neutralised. `readIntent` must not be
  handed the capture at all: it is the call whose output can delete a note, and
  keeping those bytes out of that request is a stated property here, not an
  accident of the current prompt.

One thing is deliberately not abstracted: the daily ceiling is enforced in
`withBudget`, which wraps everything the registry returns. Being a new
implementation is not a way to become unmetered.

## Routing — which harness sees which note

The seam chooses an implementation. Once one of them runs on your own machine
and another is somebody else's API, that choice stops being a deployment detail
and becomes a privacy decision — so it is made **per note**.

A note tagged `#private` may only be answered by the harness named in
`BD_LOCAL_HARNESS`. Everything else goes to the default.

**And if there isn't one, nothing happens.** The capture is not quietly sent to
the cloud harness instead; a `bd_state: held` note appears in `_triage/` saying
what is missing and naming the three ways out, and it waits indefinitely. A
privacy control that degrades to "send it anyway" when misconfigured is a
preference rather than a control, and the failure would be both silent and
unrecoverable.

`#private` is the one place this loop has a second keyword, and the exception is
deliberate: `#capture` is a *loop step*, where a second word would be a wrong
word to reach for, while this is a property of the note on an unrelated axis,
read and never written. It has no disarmed spelling — `##private` in a draft
would mean "send it", which is the wrong default for a safety marker.

Naming a remote provider in `BD_LOCAL_HARNESS` is a way to lie to yourself. No
code here can check that claim, and none pretends to.

## What is enforced by shape

- **The reply boundary is `safe()`.** The reply is the `## Your call` section, so
  a captured article could forge one by emitting a line starting `## Your call`.
  `safe()` guarantees no model-derived string reaching a note body contains a
  newline, and a heading needs a line start. That is the entire boundary, it is
  one function, and `approval.test.ts` asserts it by name.
- **Only named hubs leave the box.** `classifiable` is an egress allowlist: a
  scope carries it only if you have agreed that its NAME and a line of its
  description may be sent to a model on every classification. A plain `scope` is
  a full hub — content, containment, backlinks — that never leaves the machine,
  and that is what most of them should be. There is deliberately no fallback: if
  nothing carries the tag the list is empty, because an allowlist that grows when
  its tag goes missing is not an allowlist. (The tag was `ingestable` and meant
  "offer this in the capture form's dropdown". That form was deleted with the
  api and the tag silently changed jobs; the membership had been chosen to look
  tidy in a phone picker, not as a data-egress policy.)
- **The intent call never sees the capture.** It is the one call whose output has
  authority — it can delete a note — so the untrusted text is not in the request
  at all. Everything a reply plausibly changes is already in the proposal; a
  reply that genuinely needs the note re-read returns `reclassify`, which runs
  the classifier again with its own fencing.
- **Nothing the model says is taken at its word.** `validate()` and
  `validateAction()` check every value against the live vault: a scope must be a
  note that EXISTS, a proposed hub must not already be a name on disk, a date
  must be a real day, a priority must be one TaskNotes actually defines. Anything
  ambiguous degrades to `unclear` — never to `file`.
- **There is a ceiling that does not live in the vault.** Every other guard here
  — `bd_asked`, the failure backoff, the per-pass cap — records itself in a note,
  which means all of them fail together the moment the notes cannot be written.
  That happened: something ran as root in the vault, every write raised `EACCES`,
  and one proposal was re-classified once a minute for 56 hours. The daily token
  cap (`BD_DAILY_TOKENS`, in `usage.ts`) is the answer to *that* class of
  failure specifically — it is enforced at the single point where a request
  leaves the process, it holds no opinion about any note, and the only thing it
  needs to be writable is its own file outside the vault.
- **The prose is never rewritten.** The model is asked about metadata. The body
  that lands is the body you captured, verbatim, minus the marker. The reply
  channel carries *instructions about filing*, never *content* — which is why the
  revision vocabulary is title, funnel, hubs, due, priority and nothing else.
  `url` is the single exception and only because a link is metadata: it lands in
  frontmatter beside `due`, is parsed rather than pattern-matched, and is
  restricted to `http`/`https` because it will be tapped from a phone. A reply
  asking for body text is `unclear`, and should stay that way.

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
