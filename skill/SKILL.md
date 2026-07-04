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

- `kanban doctor` — session-start hygiene sweep (exit `2` = findings, each naming its fix: stale claims, criteria-less WIP, aging tasks, ancient questions, closable parents). Run it when you sit down at a board; act on what it reports.
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
kanban move T-12 "In Progress"        # Backlog→Ready→In Progress→Review→Done (see Columns below)
kanban criterion add T-12 "handles error responses"
kanban criterion check AC-32
kanban comment T-12 "scaffolded the callback route"   # your own progress note
kanban artifact T-12 --kind pr --title "auth PR" --uri https://github.com/acme/app/pull/42
kanban done T-12
```

**Pausing? Set a checkpoint.** Whenever you yield, end a turn mid-task, or park a
task on an `ask`, write the one-slot resume pointer first:
`kanban checkpoint T-12 "did X, next Y, watch Z"` (latest wins). It renders
first in `show`/`context` and is flagged by `next`, so the next session — yours
or another agent's — resumes from it instead of re-deriving state from notes.

**Git linkage** (all CLI-side; convention: `T-n-slug` branches, `T-n` in commit
subjects): `kanban git branch T-12 --checkout` starts the conventional branch;
`kanban git link` records commits/branches mentioning task ids as
commit/branch artifacts (idempotent — re-run freely); `kanban git status T-12`
merges board artifacts with live PR/CI state via `gh` on demand;
`kanban git install-hooks` (once per repo) auto-tags commits `[T-n]` and
auto-links after each commit.

Claiming is **single-agent: skip it unless several agents share one board.** When
they do, set a distinct `KANBAN_AGENT` per agent (else they collide on the default
`agent` identity). A claim records who's working a task and hides it from peers'
`kanban next`; it does **not** change status. `done` needs no release (Done tasks
never surface in `next`); `kanban release T-12` returns an **unfinished** task you're
abandoning to the pool, and `kanban next --mine` lists only what you hold.
In a fleet, prefer `kanban claim T-12 --ttl 900` — a lease the server auto-releases
past due (re-claim to renew), so your crash never wedges the task for peers.

## Columns & the workflow lifecycle

Five workflow columns, in order. **`kanban next` only ever recommends tasks in
`Ready` or `In Progress`** — a `Backlog` task is parked and invisible to the work
loop until you promote it, so moving a task to `Ready` is what actually *queues* it.

- **Backlog** — captured but not yet startable; the default for a new task. Parked: `next` skips it.
- **Ready** — refined and unblocked; the actionable queue `next` pulls from. Promote here the moment a task is ready to be picked up.
- **In Progress** — actively being worked. Move here on pickup.
- **Review** — work finished, awaiting a human/peer sign-off (not more agent work). The human resolves it with `kanban review approve/reject` (or the UI's card buttons); a rejection kicks the task back to `In Progress` with the reason recorded as a comment — read it before resuming. Pair with a sign-off `ask` (below) when you need to actively pull the human in.
- **Done** — accepted and complete (`kanban done`).

**`Blocked` is not a column you set** — it's a *derived* projection the UI shows
when a task is `needs_input`, waiting on a `dep`, or has open subtasks. Never `move`
to it; clear the underlying cause and the task leaves Blocked on its own.

> Only these five names are valid `move`/`--status` targets. Anything else (e.g.
> `"To Do"`) is rejected with exit `1` — use the column names above verbatim.

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

## Docs — knowledge that outlives a task

Comments are notes *about one task*; a **doc** is durable knowledge the board
stores in full (the one content-storing surface — docs/adr/0007). Five kinds:
`design | adr | spike | research | note`.

- **Hard-to-reverse decision** → `kanban doc add "Use X over Y" --kind adr --link T-12 --summary "one-line tradeoff"`. When the human signs off: `kanban doc update D-3 --status accepted`; replaced later by `--superseded-by D-9`.
- **Reusable research findings** → `--kind research` (immediately `active`).
- **A design spanning several tasks** → `--kind design --link T-12,T-13` (links are many-to-many).

**Always set `--summary`** — lists and `context` show only id/kind/title/summary;
the markdown body costs tokens **only** via `kanban doc show D-n` (budgeted by
default; `--full` to expand). Bodies cap at 64 KB — bigger material stays a file
+ `artifact` reference. Scan with `kanban docs [--kind K|--task T-n]`; check a
task's linked docs in its `context` (`docs (n):` section) before re-deciding or
re-researching something.

**Search before you re-research.** `kanban search "<terms>"` runs ranked
board-wide search over tasks, docs, and comments (one snippet line per hit,
`--type doc` etc. to narrow). Prior findings, past decisions, and old task
discussions surface here — a 20-token search beats redoing an hour of research.

## Brainstorming — when the solution space is wide

For **more than ~3 candidate approaches** (a binary choice is just `kanban ask`),
run a structured session instead of dumping options into chat:

```
kanban brainstorm start "cache strategy" --task T-12   # → B-2 (anchor shows in T-12's context)
kanban brainstorm add B-2 "write-through" --cluster safe
kanban brainstorm add B-2 "ttl only" --cluster simple
kanban idea score I-4 8                                # integers 0–10
kanban idea promote I-4 --prio P1                      # → task, atomically, with provenance
kanban idea drop I-5                                   # one-way discard (stays searchable)
kanban brainstorm close B-2                            # after distilling the outcome (often into a doc)
```

Capture fast, judge later; cluster related ideas (`--cluster` free-form). The
human can score/promote/discard from the web UI's Brainstorm panel — scoring is
a lightweight HITL channel. `kanban brainstorm show B-2` renders clusters ranked
by their best idea. Promoted/discarded ideas are frozen; ideas of any status
surface in `kanban search`.

## Asking the human (durable, async — see docs/04)

Default = **ask then yield**, not block:

```
kanban ask T-12 "Which auth provider?" --options Auth0,Cognito   # returns Q-7, non-blocking
kanban await Q-7 --timeout 60                                     # try a short wait
```

`ask` also takes `--expires-at <ISO>` to auto-expire a stale request, and
`kanban cancel Q-7` withdraws an open request you no longer need (clears the task's
needs-input). Add `--default X` (with `--expires-at`) when there's a safe fallback:
at expiry the request resolves as `answered (defaulted)` instead of dead-ending, so
you stay unblocked when the human is away — use it for reversible choices, never
for destructive ones.

**Write the question so the human can answer it cold.** They see only the board —
not your chat or your reasoning. So make each `ask` count:

- **Self-contained + the tradeoff.** State the decision *and* why it matters in one
  line, not just `"Which one?"`. The human shouldn't need to reconstruct context.
- **One decision per `ask`.** Don't bundle several questions into one request —
  raise separate `Q-n`s so each can be answered independently.
- **Shape the answer.** `--options a,b,c` for a closed, mutually-exclusive set (keep
  each option short and distinct); `--freeform` for an open answer (a value, a path,
  prose) when the set isn't enumerable.

```
kanban ask T-12 "Token store — Redis (fast, +infra to run) or Postgres (simpler, already deployed)?" --options Redis,Postgres
kanban ask T-12 "What callback URL should I register with the provider?" --freeform
```

If the `ask` is a **sign-off gate** (work is finished and you need approval before
proceeding), move the task to `Review` first so the board shows *why* it's parked,
then `ask`.

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

- Read: `next [--context|--n N|--mine]`, `list [--status|--label|--limit]`, `show <id>`, `context <id>`, `watch <id> --since <seq> [--follow]`, `changes --since <seq> [--follow]` (`--follow` streams NDJSON until Ctrl-C — for humans/scripts, not agent turns), `inbox [--since]`, `compact [--keep N]`
- Write: `add [--parent T-1|--depends|--label|--ac|--prio|--status]`, `update [--expect-version N]`, `move <id> <col>`, `done`, `archive`, `review approve/reject <id> --reason` (the human's gate), `claim [--force]`, `release [--force]`, `dep add/rm --on <id>`, `parent <id> --to <pid>|--clear`, `comment <id> "…"`, `criterion add/check [--off]`, `label --add/--rm`, `artifact --kind --title --uri`, `summarize`, `checkpoint <id> "…"|--clear` (resume pointer)
- Docs: `doc add "<title>" --kind design|adr|spike|research|note [--body|--body-file] [--summary] [--link T-n]`, `doc show <D-n> [--full]`, `doc update <D-n> [--status|--superseded-by D-n]`, `doc link/unlink <D-n> <T-n>`, `doc archive <D-n>`, `docs [--kind|--status|--task]`
- Search: `search "<query>" [--type task|doc|comment|idea] [--limit N]` — ranked hits with snippets across the whole board
- Brainstorm: `brainstorm start "<topic>" [--task T-n]`, `brainstorm add <B-n> "<idea>" [--cluster N]`, `brainstorm show/list/close`, `idea score <I-n> <0-10>`, `idea cluster <I-n> <name>`, `idea promote <I-n> [--title|--prio|--parent]`, `idea drop <I-n>`
- Git: `git branch T-n [--checkout]`, `git link [T-n] [--depth N]`, `git status [T-n]`, `git install-hooks [--force]`
- HITL: `ask [--options|--freeform|--expires-at|--default X]`, `await [qid|--task|--any] [--timeout S]`, `answer`, `cancel`
- Lifecycle: `board init/show/nudge`, `serve [--port]`, `export [--out FILE]`, `open`
- Reporting (not the work loop): `stats [id] [--window N]` — board analytics / per-task timing, read-only; `doctor` — hygiene report, exit 2 on findings.
