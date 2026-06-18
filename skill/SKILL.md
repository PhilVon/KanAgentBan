---
name: kanban
description: >-
  Agent-first kanban board for planning and tracking multi-step work, recording
  decisions, and requesting human input on a task then resuming later. Use when a
  task has several steps or dependencies, when you need to track progress across a
  session, or when you need a decision from the user before continuing. Trigger
  phrases: "track this", "plan this out", "use the board", "ask the user and
  continue", "what should I do next".
---

# Kanban (agent-first board)

A token-efficient task board you (the agent) own. The human watches a realtime web
UI and answers your questions. Full design: `docs/`. CLI contract:
`docs/05-cli-reference.md`.

## When to use it

- Multi-step or dependency-laden work → create tasks, set `dep`s, track status.
- Need to remember progress across turns/sessions → the board is durable memory.
- Need a human decision → `ask`, then resume (see below).
- **Skip it** for trivial one-shot requests.

## Token discipline (this is the point — see docs/03)

Always read the **narrowest** thing that answers your question:

- `kanban next` — "what should I work on?" (~5 lines)
- `kanban next --context` — cold start: the task to do **and** its full working set, one call
- `kanban context <id>` — full working set for a known task
- `kanban show <id>` — medium detail
- `kanban watch <id> --since <seq>` — cheap mid-task refresh (only what changed)
- **Avoid** dumping the whole board. Trust truncation footers; expand with `--full` only when needed.

## Working a task

```
kanban next --context                  # load only what you need
kanban claim T-12                       # multi-agent: reserve it so peers skip it
kanban move T-12 "In Progress"
kanban criterion add T-12 "handles error responses"
kanban criterion check AC-32
kanban comment T-12 "scaffolded the callback route"
kanban artifact T-12 --kind pr --title "auth PR" --uri https://github.com/acme/app/pull/42
kanban done T-12
```

Claiming is **single-agent: skip it unless several agents share one board.** When
they do, set a distinct `KANBAN_AGENT` per agent (else they collide on the default
`agent` identity). A claim records who's working a task and hides it from peers'
`kanban next`; it does **not** change status. `done` needs no release (Done tasks
never surface in `next`); `kanban release T-12` returns an **unfinished** task you're
abandoning to the pool, and `kanban next --mine` lists only what you hold.

## Asking the human (durable, async — see docs/04)

Default = **ask then yield**, not block:

```
kanban ask T-12 "Which auth provider?" --options Auth0,Cognito   # returns Q-7, non-blocking
kanban await Q-7 --timeout 60                                     # try a short wait
```

Branch on the exit code:

| Exit | Meaning | Do |
|------|---------|----|
| 0 | answered | continue with the answer |
| 2 | pending (timeout) | **yield**: pick up other work via `kanban next`, or end the turn cleanly ("paused T-12 on Q-7") |
| 1/3/4/5 | error / not found / conflict / auth | fix and retry |

Resume later (even a new session):

```
kanban inbox            # answered/open requests
kanban context T-12     # reload, continue
```

## Decision tree

```
need a human decision?
  └─ kanban ask … ──► kanban await --timeout 60
        ├─ exit 0 ► use answer, continue
        └─ exit 2 ► yield turn ──► (later) kanban inbox ► kanban context <id> ► continue
```

## Setup / lifecycle

- `kanban board init` once per project (creates `.kanban/`, DB, token).
- Any command auto-starts the local server; `kanban open` prints the UI URL for the human.
- Server is localhost-only with a per-board token (`docs/10`).

## Command cheat-sheet

- Read: `next [--context|--n]`, `list`, `show <id>`, `context <id> [--full|--max-tokens]`, `watch <id> --since`, `changes --since`, `inbox`
- Write: `add`, `update`, `move`, `done`, `archive`, `claim [--force]`, `release [--force]`, `dep add/rm`, `comment`, `criterion add/check`, `label`, `artifact`, `summarize`
- HITL: `ask`, `await`, `answer`
- Lifecycle: `board init/show`, `serve`, `open`
