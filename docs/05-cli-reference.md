# 05 — CLI Reference

> **Summary:** `kanban` is the agent-facing surface. It is a thin client over the
> local server's REST API ([07-api-reference](07-api-reference.md)). Output is a
> stable, versioned, terse-plaintext **contract** so the agent can parse it
> reliably; `--json` is opt-in for machine consumption.
>
> **Decisions:** Plaintext default, `--json` opt-in, `--format-version` pinning.
> Exit codes are semantic so the skill can branch without parsing. Read commands
> are cheap and tiered; the agent is steered to the narrowest one that answers its
> question.
>
> **Open questions:** Whether `watch`/`await` should support `--json` streaming
> (NDJSON) in v1 or v2.

Related: [03-token-efficiency](03-token-efficiency.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md) ·
[06-skill](06-skill.md) · [07-api-reference](07-api-reference.md) ·
[12-mcp](12-mcp.md)

> **Other agents:** agents that speak MCP rather than running this CLI use the
> parallel **`kanban-mcp`** stdio server — a curated subset of these commands over
> the Model Context Protocol, backed by the same sole-writer server ([12-mcp](12-mcp.md)).

---

## Global conventions

- **Board resolution:** the CLI walks up from CWD to find a `.kanban/` marker;
  `--board <path>` overrides. See [10-security-lifecycle](10-security-lifecycle.md).
- **Auto-start:** any command health-checks the server and starts it detached if
  down (`kanban serve`), then proceeds.
- **Output:** terse plaintext by default. `--json` emits a JSON object.
  `--format-version <n>` pins the plaintext schema (current: `4`). No ANSI colour
  when stdout is not a TTY.
- **Token control:** read commands accept `--max-tokens N` and never silently
  truncate — they emit an explicit footer (see [03](03-token-efficiency.md)).
- **Agent identity (multi-agent):** `claim`/`release` and `next`'s claim filtering
  key off an agent identity resolved as `--as <id>` > `KANBAN_AGENT` env > default
  `agent`. To run several agents on one board, give each a **distinct**
  `KANBAN_AGENT` — two agents on the default `agent` collide and won't isolate.
  Identity is cooperative, not authenticated ([09 §9](09-concurrency.md)).

### Exit codes (semantic — the skill branches on these)

| Code | Meaning |
|------|---------|
| `0` | success / answered |
| `1` | generic error |
| `2` | `await` timed out, request still **pending** (not an error) |
| `3` | not found |
| `4` | conflict (stale optimistic-concurrency `version`) |
| `5` | auth / server unreachable |

---

## Read & context commands

### `kanban next [--context] [--n N] [--mine] [--max-tokens N] [--full] [--json]`
The recommendation engine. Returns the single best `ready` task (~5 lines), with a
one-clause *why*. `--context` appends that task's full working set in the **same
call** (cold-start path). `--n N` lists the top N candidates. Tasks claimed by
*another* agent are hidden; `--mine` narrows to only the tasks **you** have claimed.

```
$ kanban next
T-12  [P1] In Progress  Wire up OAuth callback
why: highest priority ready task; you touched it last
(use: kanban context T-12  ·  kanban next --context)
```

If nothing is ready, it explains why instead of printing nothing:
```
$ kanban next
no ready tasks. 3 blocked: T-4 needs input (Q-7), T-7 waits on T-2, T-9 waits on T-2
```

### `kanban list [--status S] [--label L] [--limit N] [--max-tokens N] [--full] [--json]`
Compact one-line-per-task. Flags column: `D`=dep-blocked, `?`=needs-input,
`💬n`=comments (`💬n*` when at least one is a **user** comment).

```
$ kanban list --status "In Progress"
T-12 [P1] In Progress  Wire up OAuth callback        ?  💬2*
T-08 [P2] In Progress  Refactor token store          D
```

### `kanban show <id> [--max-tokens N] [--full] [--json]`
Medium detail: task line, summary, criteria count, dep counts, open questions, and
comments split into a protected **user comments** block (the human's directives)
plus recent **agent notes**. Under `--max-tokens`, agent notes shed first; user
comments are kept (shed last). See `comment` below.

### `kanban context <id> [--full] [--max-tokens N] [--json]`
The flagship. Full curated working set in fixed section order with per-section
truncation footers. Budgets to a **default `2000`-token ceiling**; `--full` or
`--max-tokens 0` opts out. Spec and sample output: [03-token-efficiency](03-token-efficiency.md).

### `kanban watch <id> --since <seq> [--json]`
Scoped delta: events touching `<id>` and its **direct** deps since `seq`. Cheap
mid-task refresh. Returns the new high-water `seq`.

### `kanban changes --since <seq> [--json]`
Board-wide delta since `seq`. When the cursor predates the compaction floor the
response is `{reset:true, floor, cursor}` (exit `0`) — a full re-list is needed;
otherwise `{events, cursor, floor}`. `watch` shares these reset semantics.

### `kanban inbox [--since <seq>] [--json]`
Resume entry point. Terse one-line-per-request plaintext (resolutions first — the
resume signal: `answered`, then `cancelled`/`expired` — then still-open); `--json`
emits the raw `{open, answered, resolved, cursor}` payload. `--since <seq>` returns
only requests answered or resolved after that event `seq`
(pass back the `cursor` from a prior call); without it, all open + answered
requests are listed. A `--since` cursor below the compaction floor prints a
never-silent reset footer instead of an answered delta. See
[04-human-in-the-loop](04-human-in-the-loop.md).

### `kanban compact [--keep N]`
Compact the event log, retaining only the most recent `N` events (default: the
server's `KANBAN_EVENT_RETENTION`, 50 000). Prints `removed`/`floor`. State is
unaffected — only delta-replay history below the new floor is dropped; stale
delta cursors get a reset (above). A low-frequency server sweep does this
automatically; this command forces it. See [11-roadmap §2](11-roadmap.md).

### `kanban stats [id] [--window N] [--max-tokens N] [--full] [--json]`
Board analytics, or per-task timing when `<id>` is given. Read-only derivation
over the event log: per-task lead/cycle time and time-per-status; board
throughput/velocity, WIP & aging, and a burndown series (`--window`, default 14
days). Honours the token-budget contract and is never-silent about the compaction
floor (tasks predating it are excluded from timing aggregates).
See [13-analytics](13-analytics.md).

---

## Write & workflow commands

### `kanban add "<title>" [--desc T] [--summary T] [--status S] [--prio P0..P3] [--parent T-1] [--label L,...] [--depends T-3,T-4] [--ac "text" ...]`
Creates a task; prints the new `T-n`. `--depends` adds `blocks` edges;
`--ac` adds acceptance criteria. `--parent` nests it as a subtask under an
existing task (§subtasks).

### `kanban update <id> [--title T] [--desc T] [--summary T] [--prio P] [--expect-version N]`
Edits fields. `--expect-version` enables optimistic concurrency; a stale version
exits `4`.

### `kanban move <id> <column>`
Sets workflow `status`. (Being *blocked* is derived, not a column you move to —
see [02-data-model §5](02-data-model.md).) Moving a parent to `Done` while it has
open subtasks is rejected (exit `1`).

### `kanban dep add <id> --on <id>` / `kanban dep rm <id> --on <id>`
Add/remove a `blocks` edge. Cycle/self/duplicate rejected (exit `1`).

### `kanban parent <id> --to <pid>` / `kanban parent <id> --clear`
Nest `<id>` as a subtask of `<pid>`, or detach it back to the top level.
Single-parent tree (distinct from `blocks` deps); self-parenting and cycles
(making a task a descendant of itself) are rejected (exit `1`). A parent with open
subtasks is hidden from `next` and **cannot** `move`/`done` to `Done` until they
finish; archiving a parent with live children is refused. `show`/`context` and the
UI surface children with a `subtasks d/t` count, and child cards carry a
`⤷T-parent` badge ([02-data-model §6](02-data-model.md)).

### `kanban comment <id> "<body>"`
Adds an `agent` comment — your progress note. **Users comment from the UI**, and
those `user` comments are an inbound channel: read them as directives. The agent
surfaces user comments distinctly and protects them from token-budget shedding —
`next` flags a waiting one (`↳ user comment: …`), `show`/`context` render them in a
labelled **"user comments — the human is talking to you"** block (agent notes shed
first), and `list` marks the task `💬n*`.

### `kanban criterion add <id> "<text>"` / `kanban criterion check <AC-id> [--off]`
Manage acceptance criteria; `check --off` unchecks.

### `kanban label <id> --add L` / `--rm L`

### `kanban artifact <id> --kind link|file|pr|output --title T --uri U`
Records a **reference** (never contents).

### `kanban summarize <id> "<summary>"`
Sets a fresh `summary` (clears the stale-summary flag). Server never
auto-summarizes — this is the manual refresh path.

### `kanban done <id>` / `kanban archive <id>`
`done` moves to Done (recomputes dependents' readiness); `archive` soft-deletes.

### `kanban claim <id> [--force]` / `kanban release <id> [--force]`
Multi-agent coordination ([09 §9](09-concurrency.md)). `claim` sets `assignee` to
your identity so the task drops out of other agents' `next`; idempotent if you
already hold it, conflict (exit `4`) if another agent does (use `--force` to steal).
Claiming a Done/archived task is rejected (exit `1`). `release` returns it to the
pool (no-op if already free; `--force` releases another agent's claim). Claiming is
**orthogonal to status** — it does not move the task; pair with `move`.

```
$ KANBAN_AGENT=alice kanban claim T-12
T-12 claimed by alice
$ KANBAN_AGENT=bob kanban claim T-12
error: T-12 already claimed by alice        # exit 4
```

---

## Human-in-the-loop commands

### `kanban ask <id> "<question>" [--options a,b,c] [--freeform] [--expires-at ISO]`
Creates a durable input request, moves the task to needs-input, broadcasts to the
UI, and **returns `Q-n` immediately (non-blocking)**.

```
$ kanban ask T-12 "Which auth provider?" --options Auth0,Cognito
Q-7  created on T-12 (task now needs input)
```

### `kanban await <Q-id | --task <id> | --any> [--timeout S] [--json]`
Long-polls for any terminal resolution. **Use only for short gates.** Checks
committed state *before* parking (no lost wakeups).
- answered → prints the answer, exit `0`
- cancelled / expired → prints `Q-n cancelled` / `Q-n expired`, exit `0` (resolved,
  just without an answer)
- timeout → prints `pending`, exit `2` (not an error)

```
$ kanban await Q-7 --timeout 60
Q-7 answered: Auth0
```

### `kanban answer <Q-id> "<text>"`
Records an answer from the CLI (parity with the UI; mostly for testing/automation).

### `kanban cancel <Q-id>`
Withdraws an open input request the agent no longer needs (fires `input.cancelled`).
Clears the task's needs-input. Only an `open` request can be cancelled.

---

## Lifecycle commands

| Command | Purpose |
|---------|---------|
| `kanban serve [--port N]` | Start the server (usually auto-invoked). |
| `kanban open` | Open the web UI in the browser (mints a one-time UI token URL). |
| `kanban board init [--name N]` | Create `.kanban/` + DB + token for this project. |
| `kanban board show` | Print board id, port, db path, column config, and nudge config. |
| `kanban board nudge [--url U] [--cmd C] [--header K=V…] [--clear]` | Configure external-nudge auto-resume; no flags prints current config (see [04 §3C](04-human-in-the-loop.md)). |
| `kanban export [--out FILE]` | Dump board to JSON for backup. |

Most commands above map 1:1 to a REST endpoint in
[07-api-reference](07-api-reference.md); `board init` / `board nudge` are local
edits to `.kanban/` and need no running server.
