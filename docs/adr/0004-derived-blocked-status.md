# 0004 — "Blocked" Is Derived, Not a Stored Status

## Status

Accepted

## Context

A task's `status` is its workflow column (e.g. `In Progress`). Being *blocked* is
a different concern: a task may be unactionable because a prerequisite is not
Done, or because it is waiting on a human answer — and the recommendation engine
needs to explain *why*. Writing "Blocked" into `status` would destroy the
underlying workflow state the task should return to once unblocked. See
[02-data-model §5](../02-data-model.md).

## Decision

"Blocked" is **derived from two independent flags**, never stored as a status
column value:

- `blocked_by_deps` — an unfinished `blocks` prerequisite exists.
- `needs_input` — an open `input_request` targets the task.

The `Blocked` UI column is a **projection** rendered for any task where
`blocked_by_deps OR needs_input`. The engine never moves tasks into `Blocked`; it
preserves their real `status` and overlays the blocked state. Flags are recomputed
on read to stay cheap.

## Consequences

- The recommendation engine reasons on both flags separately and can explain the
  exact reason a task is not actionable.
- A task's workflow `status` is preserved across blocking and restored on unblock.
- Derived state is recomputed on read, so no extra events or columns to maintain.
- `ready` is defined as neither flag set, gating the `next` engine.
