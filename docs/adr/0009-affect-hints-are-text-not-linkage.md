# 0009 — Affect Hints Are Text, Not Linkage

## Status

Accepted

## Context

The board should prompt an `eb consult` (EmotionalBrain) at the moments it knows a
choice is being made. The argument for it is not that consulting is good; it is that
the existing nudge is a `UserPromptSubmit` hook that fires **every turn**, and a
reminder that is usually irrelevant trains the reader to skip it when it is not. One
session recorded five feelings and ran `eb consult` zero times — including at its one
genuinely open choice, with the ritual in front of it the whole time.

So the fix has to be *contextual*: emitted at a moment that is actually a decision
rather than on a timer. **The board knows when those moments are. It is the only thing
that does.**

The obvious implementation — the board runs `eb consult` and renders the stance — is
refused by EmotionalBrain's own [ADR
0008](../../../EmotionalBrain/docs/adr/0008-no-project-linkage.md) ("No Linkage to
Project or Task Stores"), which anticipates this request by name: no task ids in the
brain, the brain never reads another server, and *no other tool reads the brain*. It
leaves exactly one door open — **"if that is ever wanted, the agent does it."** Its
ADR 0005 (read-only Cortex) adds a second objection: an affective annotation appearing
automatically on a human's board is the store leaking to the human.

## Decision

**The board emits a labelled line of text and nothing else.** It never executes `eb`,
never opens a socket to the brain, never stores a stance, cue aggregate or feeling, and
never renders affect to the human. The agent chooses whether to run the command it is
handed, so the influence contract and the one-clause disclosure rule stay exactly where
EmotionalBrain put them.

What the board contributes is the half `eb` cannot supply for itself: **the moment**,
and **the vocabulary**. A task's **mapped** labels become cue keys, so the cue namespace
is *inherited* rather than reinvented each session — which is the failure mode
`eb doctor`'s `cue-sprawl` check exists to catch. A label with no mapping emits nothing
(amended 2026-08-21 — see the amendment below).

Three emission points, ranked by how certain the moment is:

1. **`brainstorm start`** — the strongest by construction. More than about three
   candidate approaches *is* the definition of an open choice.
2. **`next` with two or more ready candidates** — the emotionalbrain skill names this
   trigger itself (*"picking up a piece of work when several are available"*), and
   `next` is the top of every work loop.
3. **`claim`** — about to commit to a piece of work: the estimating-difficulty trigger.

`context` additionally prints a `cues:` line, so an `eb feel` written *during* the work
inherits the same vocabulary.

**Deliberately not `ask`.** By the time a question is being composed the options are
already framed, and framing them was the decision — the consult needed to happen a step
earlier. It is named here because it is the obvious wrong place to put it.

## Constraints inherited from `eb`

- `consult --options` accepts **at most four** candidates and **cannot** be combined
  with `--about` or a query: a candidate set and a prospective action are different
  questions. The board emits neither alongside `--options`.
- `proj:` is derived by `eb` from the cwd basename. The board must never emit one — a
  board emitting `proj:` would be inventing a fact about a project rather than passing
  on a cue.
- Cue namespaces are a closed set (`tool: lang: activity: context: collab:`, plus the
  `eb`-derived `proj:`); an unknown one is a rejected write, `eb` exit 4. A configured
  cue is validated at `board affect --map` time so the board can never emit a command
  the agent cannot run.

## Guard rails

- The hint is **always its own line**, prefixed `affect:`, never folded into `why:` —
  otherwise it reads as the board's judgement rather than the agent's, and the human
  cannot tell them apart.
- **Never on `doctor`**, or anything correctness-shaped. Affect adjusts preference,
  never permission.
- **Off by default** (`kanban board affect --on`).
- Under a token budget the hint **sheds first**, and never silently.

## Consequences

- A board with no brain, and a machine with no `eb` installed, are unaffected: the
  feature is a string.
- The payoff is deferred, and this is stated rather than hidden. An empty brain answers
  `stance: open`, and will for a while. The reason to build this is the **writes** — a
  cue vocabulary the board enforces — not the reads it gives today. Building it for the
  reads would be the wrong reason.
- The board gains no dependency on `eb` and `eb` gains none on the board, so either can
  be absent, versioned or replaced without touching the other.

## Amendment — 2026-08-21: an unmapped label emits no cue

As shipped, a label with no `--map` entry fell back to `activity:<label>`. **That default
is withdrawn: only mapped labels become cues.** The rest of this ADR stands unchanged.

The default existed so the vocabulary would work with no configuration. Measured against
this repo's own board, it did the opposite: 23 labels across 73 of 102 tasks, 14 of them
occurring at most twice, `test`/`tests` and `web`/`webui` splitting one concept across two
keys, and `tier-1`, `epic`, `planning` and `archive` describing the board's own
bookkeeping rather than any activity. At the time of the amendment the brain this board
writes to was failing `eb doctor`'s `cue-sprawl` check — 11 of 27 cues at `n=1` — and two
of those eleven had been minted by this board minutes earlier out of its own labels. The
first cue it ever emitted, `activity:docs`, drew a near-duplicate warning against
`activity:writing-docs` from `eb`'s starter vocabulary.

The asymmetry that decides it: `eb` cue keys are immutable — no rename, no merge
([EmotionalBrain ADR 0006](../../../EmotionalBrain/docs/adr/0006-cue-key-ids.md)) — so **a
bad cue costs evidence permanently, while silence costs one prompt.**

> **The board emits less; the agent is not allowed less.** The map is *advisory to the
> agent* and *binding on the board*.

This is the distinction the amendment turns on. Nothing about the agent's own writes
changes: `eb feel --about <anything>` is exactly as free as it was, and cue *values* were
never constrained by this board. What is withdrawn is the board's licence to mint
vocabulary on the agent's behalf — and a board is not an agent, so removing it takes no
option away from anyone who can actually have a feeling.

**Never silently.** `context` names the labels that produced no cue and the single command
that fixes them, and `board affect` says so when the map is empty. The fix hint shows a
literal `<cue>` placeholder rather than a slug of the label: suggesting `activity:docs`
would have the board proposing the very near-duplicate described above, which is the
same error one step removed.
