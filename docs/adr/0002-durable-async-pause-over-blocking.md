# 0002 — Durable-Async Pause Over Blocking Long-Poll

## Status

Accepted

## Context

When an agent needs a human decision, the human answers on human timescales —
minutes, or tomorrow morning. Holding a tool call or agent turn open that long is
fragile (harness timeouts), wastes the turn, and conflates "ask" with "block" so
the agent cannot do other useful work while waiting. See
[04-human-in-the-loop](../04-human-in-the-loop.md).

## Decision

The default human-in-the-loop pattern is **durable-async**: `ask → yield → inbox
→ resume`. `kanban ask` creates a durable `input_request` (`Q-n`), marks the task
`needs_input`, broadcasts `input.requested`, and returns the id immediately. The
agent then either picks up other unblocked work or ends the turn cleanly; a later
session resumes from board state via `kanban inbox`. A short blocking `await`
long-poll is retained **only for fast gates**, and on timeout it returns
`pending` (exit `2`, not an error) so the skill falls back to yielding.

## Consequences

- Requests persist in SQLite and survive turn and session boundaries.
- Resume is a cheap delta via `kanban inbox`; answered requests also re-surface
  through plain `kanban next`.
- The lost-wakeup race (human answers between `ask` and `await`) is closed by
  check-then-park: `await` checks committed state before parking on the emitter.
- No held connections, so reliability and token cost both improve.
