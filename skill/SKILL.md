---
name: kanban
description: >-
  Agent-first kanban board for planning and tracking multi-step work, recording
  decisions, and requesting human input via durable on-board requests (never
  chat-only) then resuming later. Use when a task has several steps or
  dependencies, when you need to track progress across a
  session, or when you need a decision from the user before continuing. Trigger
  phrases: "track this", "plan this out", "use the board", "ask the user and
  continue", "what should I do next".
---

# Kanban (agent-first board)

A token-efficient task board you (the agent) own. The human watches a realtime web
UI and answers your questions. Full design: `docs/`. CLI contract:
`docs/05-cli-reference.md`.

> **Hard rule — a human decision goes on the board, not in chat.** The moment you
> need a decision or answer from the human while working a task, raise it with
> `kanban ask` (then `await`/yield — see below). **Never ask only in your chat
> reply.** A chat-only question isn't durable: it doesn't park the task as
> `needs_input`, never shows up in `kanban inbox`, and is gone the instant the
> session ends — the human never even sees it waiting.

## When to use it

- Multi-step or dependency-laden work → create tasks, set `dep`s, nest **subtasks**, track status.
- Need to remember progress across turns/sessions → the board is durable memory.
- Need a human decision → **`kanban ask`**, then resume (see below) — **never ask in chat only**.
- **Skip it** for trivial one-shot requests.

## Reading efficiently (see docs/03)

You drive this board — the **whole** command surface (cheat-sheet below) is yours to
use. These read tiers just help you pull the *narrowest* view that answers the
question, so you don't burn tokens dumping the board when one task's working set
would do:

- `kanban next` — "what should I work on?" (~5 lines; flags any waiting user comment)
- `kanban next --context` — cold start: the task to do **and** its full working set, one call
- `kanban context <id>` — full working set for a known task
- `kanban show <id>` — medium detail
- `kanban watch <id> --since <seq>` — cheap mid-task refresh (only what changed)
- Reads carry never-silent truncation footers; expand with `--full` (or raise
  `--max-tokens`) whenever you need the dropped detail.

## Working a task

```
kanban next --context                  # load only what you need (incl. user comments)
kanban claim T-12                       # multi-agent: reserve it so peers skip it
kanban move T-12 "In Progress"
kanban criterion add T-12 "handles error responses"
kanban criterion check AC-32
kanban comment T-12 "scaffolded the callback route"   # your own progress note
kanban artifact T-12 --kind pr --title "auth PR" --uri https://github.com/acme/app/pull/42
kanban done T-12
```

Claiming is **single-agent: skip it unless several agents share one board.** When
they do, set a distinct `KANBAN_AGENT` per agent (else they collide on the default
`agent` identity). A claim records who's working a task and hides it from peers'
`kanban next`; it does **not** change status. `done` needs no release (Done tasks
never surface in `next`); `kanban release T-12` returns an **unfinished** task you're
abandoning to the pool, and `kanban next --mine` lists only what you hold.

## User comments = the human talking to you

Comments are a **two-way** channel, not just your scratchpad. The human leaves
comments on tasks from the web UI to steer you — corrections, extra requirements,
answers you didn't formally `ask` for. **Treat a user comment as a directive:**

- **Read them before you start or resume a task.** `kanban next` flags a waiting
  one (`↳ user comment: …`); `kanban show`/`context` print them in their own
  **"user comments — the human is talking to you"** block; `kanban list` marks the
  task `💬n*` (the `*` = at least one user comment).
- They're **protected from token-budget trimming** — agent notes get shed first, so
  a human directive won't silently vanish under `--max-tokens`. If you ever see a
  `[user comment(s) hidden …]` footer, re-read with `--full`.
- **Act on them, then acknowledge** — adjust the work, and reply with your own
  `kanban comment <id> "…"` (or `kanban ask` if you need a decision) so the human
  sees you got it. Don't silently ignore a comment.

## Subtasks (decomposing a task)

For a task that breaks into pieces, nest children under it — a single-parent tree,
distinct from `dep` blocking edges:

```
kanban add "child step" --parent T-8      # create directly as a subtask of T-8
kanban parent T-12 --to T-8               # re-nest an existing task under T-8
kanban parent T-12 --clear               # detach back to top level
```

A parent with **open** subtasks is hidden from `next` and **cannot** `move`/`done`
to Done until its children finish (rejection = exit `1`). Self-parenting and cycles
are rejected. `show`/`context` surface a `subtasks d/t` count.

## Asking the human (durable, async — see docs/04)

Default = **ask then yield**, not block:

```
kanban ask T-12 "Which auth provider?" --options Auth0,Cognito   # returns Q-7, non-blocking
kanban await Q-7 --timeout 60                                     # try a short wait
```

`ask` also takes `--expires-at <ISO>` to auto-expire a stale request, and
`kanban cancel Q-7` withdraws an open request you no longer need (clears the task's
needs-input).

Branch on the exit code:

| Exit | Meaning | Do |
|------|---------|----|
| 0 | **resolved** — answered, *or* cancelled/expired | if answered, continue with the answer; if cancelled/expired the request is gone — drop it or re-`ask` |
| 2 | pending (timeout) | **yield**: pick up other work via `kanban next`, or end the turn cleanly ("paused T-12 on Q-7") |
| 1/3/4/5 | error / not found / conflict / auth | fix and retry |

Resume later (even a new session):

```
kanban inbox            # open / answered / resolved (cancelled+expired) requests
kanban context T-12     # reload, continue
```

## Decision tree

```
need a human decision?
  └─ kanban ask … ──► kanban await --timeout 60
        ├─ exit 0 ► resolved: use answer & continue (or re-ask if cancelled/expired)
        └─ exit 2 ► yield turn ──► (later) kanban inbox ► kanban context <id> ► continue
```

## Setup / lifecycle

- `kanban board init` once per project (creates `.kanban/`, DB, token).
- Any command auto-starts the local server; `kanban open` prints the UI URL for the human.
- Server is localhost-only with a per-board token (`docs/10`).

## Command cheat-sheet

The full surface — nothing here is off-limits. Any read takes `--json` and
`--max-tokens N`/`--full`; global flags `--board <path>` and `--as <id>` (or
`KANBAN_AGENT`) apply everywhere. Full flag detail: `docs/05-cli-reference.md`.

- Read: `next [--context|--n N|--mine]`, `list [--status|--label|--limit]`, `show <id>`, `context <id>`, `watch <id> --since <seq>`, `changes --since <seq>`, `inbox [--since]`, `compact [--keep N]`
- Write: `add [--parent T-1|--depends|--label|--ac|--prio|--status]`, `update [--expect-version N]`, `move <id> <col>`, `done`, `archive`, `claim [--force]`, `release [--force]`, `dep add/rm --on <id>`, `parent <id> --to <pid>|--clear`, `comment <id> "…"`, `criterion add/check [--off]`, `label --add/--rm`, `artifact --kind --title --uri`, `summarize`
- HITL: `ask [--options|--freeform|--expires-at]`, `await [qid|--task|--any] [--timeout S]`, `answer`, `cancel`
- Lifecycle: `board init/show/nudge`, `serve [--port]`, `export [--out FILE]`, `open`
- Reporting (not the work loop): `stats [id] [--window N]` — board analytics / per-task timing, read-only.
