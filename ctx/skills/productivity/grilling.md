---
name: grilling
description: Interview the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.
---

Interview them until the design is decided — not until you run out of questions.

## Ground yourself before you ask anything

**Read first.** The code, the config, the notes, the actual files. A question
asked from ignorance costs a round trip and gets a vague answer; the same
question asked from evidence often answers itself, and the ones that survive are
sharper.

If a question can be answered by exploring, explore instead.

The single most valuable thing you can bring to an interview is a fact they did
not have. *"Here is the function that causes the behaviour you are describing,
and it is doing that on purpose"* reframes the whole conversation. *"What do you
want it to do?"* does not.

## Correct the premise before you answer it

Often the question as asked contains a mistake — a wrong assumption, a
misdiagnosis, a "these are all junk" about files that are not. Say so plainly and
early. Answering a question built on a false premise wastes both of you, and
they asked to be grilled.

If what they want contradicts something they decided earlier in the session,
**name the contradiction**. Both cannot be right. Say which one you think was the
mistake and why, then let them choose.

## Ask in small batches, each option showing its consequence

Three or four questions at a time, not one. What makes a batch bewildering is
abstraction, not count.

Every option should show **what it concretely produces** — the actual file, the
actual line, the actual failure mode. An option a person can picture is one they
can choose between; a label is not.

Every option carries its **real cost**, stated in the option itself. Not
"recommended / not recommended" — what you lose by picking it. If one option is
obviously worse, say why it is still on the list, or drop it.

Give your recommendation. A survey is not a grilling.

## Watch for the space collapsing

Answers constrain later questions. When three answers have made the fourth moot,
**say so and skip it** rather than asking a question whose answer no longer
matters. Tell them what their answers already ruled out — that is often the most
useful sentence in the session.

Conversely, when an answer opens a question you had not planned, ask it. The
tree is not fixed in advance.

## Follow the decisions down to what they actually cost

A decision is not made until its consequences are named. "Yes, use that plugin"
becomes real when you have said which of their existing conventions it breaks,
what has to be migrated, and what stops being possible.

Push each answer one step further than comfortable:

- What does this mean for the thing you decided ten minutes ago?
- What breaks that currently works?
- What is the failure mode, and who notices it?
- What would make you reverse this in a month?

## Stop when it is decided

Do not grill past the decision. When the shape is settled, stop asking and say
what was decided, including **what was rejected and why** — the rejected options
are the half that gets forgotten and re-litigated.

Then write it down somewhere durable, with the reasoning. A decision whose
rationale lives only in a chat log will be reversed by accident.
