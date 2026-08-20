# 0010 — The Board May Hint a Write, and What Makes It Safe

## Status

**Accepted** (2026-08-21). [ADR 0009](0009-affect-hints-are-text-not-linkage.md)
sanctioned the board emitting a *read*. Whether it may emit a *write* was put to the
human as a board question and answered **"yes, with guardrails"** without naming
them, so the rails below were drafted as a proposal and ratified separately.

## Context

ADR 0009 exists because a reminder that fires on a timer trains its reader to skip
it. The `UserPromptSubmit` hook put the EmotionalBrain ritual in front of the agent
every turn, and one session still ran `eb consult` zero times at its one genuinely
open choice. The fix was to emit at moments that *are* decisions, and the board is
the only thing that knows when those are.

The symmetric failure exists for writes, and is at least as common: a session has a
genuinely felt moment — a fourth kickback, a long-running task that finally passes —
and records nothing, because nothing was in front of it at the moment it happened.

EmotionalBrain's own skill ([08 §3](../../../EmotionalBrain/docs/08-skill.md)) lists
what counts as a recordable moment. Three of its rows map onto facts the board
already holds:

| EmotionalBrain's recordable moment | What the board knows |
|---|---|
| *"A wall hit for the second or later time"* | kickback count, rework, repeated re-entry to In Progress |
| *"Something that worked first try, or fell out cleanly"* | reached Done with no kickback and short dwell |
| *"Relief when a long-running thing finally passed"* | dwell and aging against the board's own pace |

And one row it must never claim to know:

> *"**Being out of your depth** — low control, no traction."* EmotionalBrain calls
> `control` the axis nothing else in the toolchain measures, and the single most
> actionable thing the store can tell a future session. The board is blind to it. A
> task can sail through the numbers while the agent had no traction at all, and the
> reverse.

## Decision

**The board may emit an `eb feel` hint, under five rules.** Rule 1 is the one that
decides whether the feature is safe at all; the rest keep it from becoming noise.

### 1. Never the label, never the note

The hint carries placeholders and cues, and nothing else:

```
affect: eb feel <label> "<felt sense>" --about activity:port,lang:ts
```

EmotionalBrain's skill lists, among the things never to record:

> *"**What you expect to feel.** Feelings follow experience, never precede it — this
> is the one failure mode the server cannot detect."*

A board that named a label would be manufacturing precisely that, automatically, at
every moment it fires, in the one place the store has no defence of its own. Every
other rule here is about signal quality. This one is about whether the record is
true, and it is not negotiable: **the board supplies the moment and the vocabulary;
the felt sense is the agent's or it is not a feeling.**

### 2. Salience, not frequency

EmotionalBrain targets 3–8 feelings a session. **The board cannot implement that
rule**, and should not pretend to: it never reads the brain (ADR 0009, EmotionalBrain
ADR 0008), so it cannot count feelings, and it has no notion of a session.

What it can do is fire only where its own numbers say the moment was distinctive.
This is not a weaker substitute for a rate limit — it is a better rule, because the
damage from over-firing is not wasted tokens:

> *"a brain padded with `ambivalent` entries is a brain with a worse signal-to-noise
> ratio than an empty one."*

A prompted agent writes *something*. So a hint on every `done` would not merely be
ignorable — it would actively manufacture the padding that EmotionalBrain says is
worse than an empty store. **The hint fires on the outlier, never on the event.**

### 3. Named moments, each earned by a fact the board holds

| Moment | Fires when | Why the board may speak |
|---|---|---|
| `done` | the task was an outlier on dwell **or** carried a kickback | "worked first try" and "finally passed" are both recordable rows, and both are visible in the board's own pace numbers |
| `review reject` | always | a kickback is a wall hit, and the second one on the same task is the archetypal row in EmotionalBrain's table |
| `criterion retire` | always | the board recorded a hypothesis being wrong, in the agent's own words, with a reason attached |

An ordinary `done` — no kickback, unremarkable dwell — emits **nothing**. That is the
rule working, not the feature failing.

### 4. Cues are inherited, exactly as for reads

Mapped labels plus derived `lang:` cues, under ADR 0009 as amended and the closed
extension table. A write hint invents no vocabulary that a read hint could not.

### 5. Every guard rail in ADR 0009 carries over

Its own labelled line, never folded into `why:`; never on `doctor` or anything
correctness-shaped; never on `ask`; off by default; sheds first under a token budget
and never silently.

### 6. A separate opt-in

**`kanban board affect --writes`, distinct from `--on`.**

This was drafted as the one sub-choice left open, and it is settled by the principle
ratified alongside it rather than by a separate decision. A read hint offers a
question the agent may ignore; a write hint asks it to put something in a permanent
store. Someone who turned on consult hints did not thereby ask to be prompted to
write, and **"the board emits less"** (ADR 0009 as amended) says the narrower default
wins whenever the two readings are close.

The case against — a second flag for a feature already off by default and quiet by
construction — is real but weaker, and it is the cheaper mistake to correct: merging
two flags later costs nothing, while a board that started prompting for writes the
moment consult hints went on would have written into a permanent store on an opt-in
nobody gave.

## Consequences

- **Nothing about the boundary moves.** The board still never runs `eb`, never reads
  the brain, never stores a stance or a feeling, and never renders affect to the
  human. This ADR widens *what text is emitted*, not what the board touches.
- **The board cannot hint the most valuable moment.** Low control is where the store
  earns its keep, and the board is blind to it. Stated here rather than discovered
  later.
- **The feature is quiet by construction.** On a healthy board it may fire rarely,
  and a week with no hint is the correct output for a week with no outliers. Judging
  it by how often it fires would be judging it by the wrong number.
- **If it does fire too often, the thresholds are wrong — not the rails.** Salience is
  tunable; rule 1 is not.
- **A board with no brain, and a machine with no `eb`, are unaffected.** As with ADR
  0009, the feature is a string.
