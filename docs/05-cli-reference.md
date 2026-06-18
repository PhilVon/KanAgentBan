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
[06-skill](06-skill.md) · [07-api-reference](07-api-reference.md)

---

## Global conventions

- **Board resolution:** the CLI walks up from CWD to find a `.kanban/` marker;
  `--board <path>` overrides. See [10-security-lifecycle](10-security-lifecycle.md).
- **Auto-start:** any command health-checks the server and starts it detached if
  down (`kanban serve`), then proceeds.
- **Output:** terse plaintext by default. `--json` emits a JSON object.
  `--format-version <n>` pins the plaintext schema (current: `1`). No ANSI colour
  when stdout is not a TTY.
- **Token control:** read commands accept `--max-tokens N` and never silently
  truncate — they emit an explicit footer (see [03](03-token-efficiency.md)).

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

### `kanban next [--context] [--n N] [--json]`
The recommendation engine. Returns the single best `ready` task (~5 lines), with a
one-clause *why*. `--context` appends that task's full working set in the **same
call** (cold-start path). `--n N` lists the top N candidates.

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

### `kanban list [--status S] [--label L] [--limit N] [--json]`
Compact one-line-per-task. Flags column: `D`=dep-blocked, `?`=needs-input,
`💬n`=comments.

```
$ kanban list --status "In Progress"
T-12 [P1] In Progress  Wire up OAuth callback        ?  💬2
T-08 [P2] In Progress  Refactor token store          D
```

### `kanban show <id> [--json]`
Medium detail: task line, summary, criteria count, dep counts, open questions,
last 3 comments.

### `kanban context <id> [--full] [--max-tokens N] [--json]`
The flagship. Full curated working set in fixed section order with per-section
truncation footers. Spec and sample output: [03-token-efficiency](03-token-efficiency.md).

### `kanban watch <id> --since <seq> [--json]`
Scoped delta: events touching `<id>` and its **direct** deps since `seq`. Cheap
mid-task refresh. Returns the new high-water `seq`.

### `kanban changes --since <seq> [--json]`
Board-wide delta since `seq`. On a stale/expired cursor returns
`{reset:true, snapshot_cursor}` (exit `0`) signalling a full re-list is needed.

### `kanban inbox [--json]`
Resume entry point: input requests answered (or still open) since the agent last
checked. Backed by a persisted "last seen request seq". See
[04-human-in-the-loop](04-human-in-the-loop.md).

---

## Write & workflow commands

### `kanban add "<title>" [--desc T] [--summary T] [--status S] [--prio P0..P3] [--label L,...] [--depends T-3,T-4] [--ac "text" ...]`
Creates a task; prints the new `T-n`. `--depends` adds `blocks` edges;
`--ac` adds acceptance criteria.

### `kanban update <id> [--title T] [--desc T] [--summary T] [--prio P] [--expect-version N]`
Edits fields. `--expect-version` enables optimistic concurrency; a stale version
exits `4`.

### `kanban move <id> <column>`
Sets workflow `status`. (Being *blocked* is derived, not a column you move to —
see [02-data-model §5](02-data-model.md).)

### `kanban dep add <id> --on <id>` / `kanban dep rm <id> --on <id>`
Add/remove a `blocks` edge. Cycle/self/duplicate rejected (exit `1`).

### `kanban comment <id> "<body>"`
Adds an `agent` comment. (Users comment from the UI.)

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
Long-polls for an answer. **Use only for short gates.** Checks committed state
*before* parking (no lost wakeups).
- answered → prints the answer, exit `0`
- timeout → prints `pending`, exit `2` (not an error)

```
$ kanban await Q-7 --timeout 60
Q-7 answered: Auth0
```

### `kanban answer <Q-id> "<text>"`
Records an answer from the CLI (parity with the UI; mostly for testing/automation).

---

## Lifecycle commands

| Command | Purpose |
|---------|---------|
| `kanban serve [--port N]` | Start the server (usually auto-invoked). |
| `kanban open` | Open the web UI in the browser (mints a one-time UI token URL). |
| `kanban board init [--name N]` | Create `.kanban/` + DB + token for this project. |
| `kanban board show` | Print board id, port, db path, column config. |
| `kanban export [--out FILE]` | Dump board to JSON for backup. |

Every command above maps 1:1 to a REST endpoint in
[07-api-reference](07-api-reference.md).
