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
> **Resolved:** `watch`/`changes` now stream NDJSON with `--follow` (a WebSocket
> client of `/ws` — no polling). `await` streaming remains out of scope (it is a
> bounded long-poll by design).

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
  `--format-version <n>` pins the plaintext schema (current: `8`). No ANSI colour
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

### `kanban watch <id> [--since <seq>] [--follow] [--json]`
Scoped delta: events touching `<id>` and its **direct** deps since `seq`. Cheap
mid-task refresh. Returns the new high-water `seq`. `--since` is required for the
one-shot read; with `--follow` it defaults to the current board `seq`.

### `kanban changes [--since <seq>] [--follow] [--json]`
Board-wide delta since `seq`. When the cursor predates the compaction floor the
response is `{reset:true, floor, cursor}` (exit `0`) — a full re-list is needed;
otherwise `{events, cursor, floor}`. `watch` shares these reset semantics.

**`--follow` (both commands):** stream events as **NDJSON** (one JSON event per
line) until Ctrl-C (exit `0`), over the server's WebSocket — no polling. The
stream reconnects from the last-seen `seq` after a server restart (a stderr
`reconnecting…` note; duplicates deduped by seq) and passes `reset` frames
through verbatim when compaction outruns the cursor (never silent). `watch
--follow` client-side filters to the task + its direct deps and refreshes that
set when a dep edge on the task changes.

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
throughput/velocity (with a recent-vs-prior-half **trend** annotation), WIP &
aging, a burndown series, and per-status **dwell** times with a bottleneck flag.
`--window` (days, default 14, max 365) is an **upper bound** on the span — the
**bucket width auto-scales** to the board's age, so a board that is hours old
still gets a readable multi-point series (a 6h board → 15-minute buckets) instead
of one daily dot; the header names the bucket size. Rates render per-hour when
brisk, aging thresholds and the drain ETA scale to the board's own pace, and it
stays never-silent about the compaction floor. See [13-analytics](13-analytics.md).

---

## Write & workflow commands

### `kanban add "<title>" [--desc T] [--summary T] [--status S] [--prio P0..P3] [--parent T-1] [--label L,...] [--depends T-3,T-4] [--ac "text" ...]`
Creates a task; prints the new `T-n`. `--depends` adds `blocks` edges;
`--ac` adds acceptance criteria. `--parent` nests it as a subtask under an
existing task (§subtasks). `--label` and `--depends` are repeatable and each
occurrence may be comma-separated (`--label a,b --label c` -> a, b, c).

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

### `kanban artifact <id> --kind link|file|pr|output|commit|branch --title T --uri U`
Records a **reference** (never contents). Idempotent on (task, kind, uri) — the
same reference attached twice returns the original, no duplicate event. Git
conventions: `commit` → `uri: git:<sha>`, `branch` → `uri: branch:<name>`,
`pr` → the PR URL (see the `git` commands below, ADR 0008).

### `kanban summarize <id> "<summary>"`
Sets a fresh `summary` (clears the stale-summary flag). Server never
auto-summarizes — this is the manual refresh path.

### `kanban template save <name> --from T-n` / `apply <name> "<title>"` / `list` / `show <name>` / `delete <name>`
Reusable blueprints — save a task's *shape* once (priority, labels, criteria
texts, direct-subtask skeleton with their criteria; never the title), apply it
many times: `apply` creates the task + criteria + labels + subtasks in **one
transaction** with a `template.applied` provenance event. Overrides
(`--prio/--status/--parent`) beat the blueprint. Same name re-saves (upsert —
a template is config, not history). Names: 1–64 chars, letters/digits/`-`/`_`.
Cuts repeated token spend authoring the same checklist; standardizes
definition-of-done (e.g. `pr-checklist`, `spike`).

### `kanban standup [--since <seq> | --days N] [--json] [--max-tokens N | --full]`
The narrative board diff — one call to catch up (agent cold-start or human
coffee-in-hand): completed (approvals flagged), review kickbacks with reasons,
net moves (first→last column per task, no noise), new tasks, question traffic
(asked / answered incl. `(defaulted)` / cancelled / expired), and the current
aging (>7d) list. Default window: last 1 day; pass `--since <seq>` to diff from
a saved cursor (the head line prints the cursor to save next). A cursor below
the compaction floor clamps to it with an explicit `[history bounded…]` note.
Read-only; reuses the event log + stats internals.

### `kanban doctor [--json] [--max-tokens N | --full]`
One read-only hygiene sweep, findings grouped by check: `stale-claim` (expired
lease, or an indefinite claim untouched >24h), `wip-no-criteria` (In Progress
with no acceptance criteria), `aging-wip` (Ready/In Progress/Review untouched
>7d), `ancient-ask` (open `Q-n` >48h), `stale-summary` (description newer than
summary), `done-eligible-parent` (all subtasks Done, parent still open). Every
finding names its fix. **Exit `0` = healthy, exit `2` = findings** (same
semantic-exit pattern as `await`'s pending) — run it at session start and act on
what it reports. Thresholds are deliberately fixed, not flags.

### `kanban checkpoint <id> ["did X, next Y, watch Z"] [--clear]`
The **one-slot resume pointer** for cross-session continuity: set it whenever you
pause or yield a task; the next session (any agent) reads it *first* — it renders
directly under the task head in `show`/`context`, is flagged on `next`'s
recommendation line, and is never shed under token budget. Latest wins (no
history — the event log keeps the trail as `task.checkpointed`). With no text,
prints the current pointer; `--clear` removes it. Capped at 1000 chars: it is a
pointer, not a log — detail belongs in comments or docs.

### `kanban done <id>` / `kanban archive <id>`
`done` moves to Done (recomputes dependents' readiness); `archive` soft-deletes.

### `kanban board autoarchive [--days N | --off]`
Auto-archive policy: Done tasks untouched for `N` days archive automatically on
the server sweep (≤5 min lag; also once at server start). Config lives in
`board.json` (`auto_archive_days`), read at each sweep — no restart needed;
`KANBAN_AUTO_ARCHIVE_DAYS` overrides at runtime. Policy archives record
`task.archived` with `{auto: true}` (actor `system`). Subtrees collapse
bottom-up; a young child keeps its Done parent alive. No flags prints the
current setting. Keeps list/UI/token costs flat as a board ages — archived
tasks stay in the DB (soft delete) and in `export`.

**Bulk ids.** `move`, `done`, `archive`, and `label` accept a comma-separated id
list (`kanban move T-1,T-2,T-3 Ready`) — applied server-side as **one
transaction, one event per task, all-or-nothing**: a single bad id or guard
failure (open subtasks, live children) rolls the whole batch back. Ids are
de-duplicated.

### `kanban review approve <id> [--reason T]` / `kanban review reject <id> --reason T`
The Review-column sign-off gate — normally the **human's** verb (the web UI puts
Approve/Reject buttons on Review cards). `approve` moves the task to Done (same
open-subtask guard as any Done move); `reject` kicks it back to In Progress and
**requires a reason**, recorded both on the `task.moved` event
(`{review:'rejected', reason}`) and as a comment (`review rejected: …`) so the
next agent session sees why it bounced. Rejections feed the existing
rework/kickback stats unchanged. Only a task in `Review` passes the gate
(anything else is exit `1`).

### `kanban claim <id> [--force] [--ttl <seconds>]` / `kanban release <id> [--force]`
Multi-agent coordination ([09 §9](09-concurrency.md)). `claim` sets `assignee` to
your identity so the task drops out of other agents' `next`; idempotent if you
already hold it, conflict (exit `4`) if another agent does (use `--force` to steal).
Claiming a Done/archived task is rejected (exit `1`). `release` returns it to the
pool (no-op if already free; `--force` releases another agent's claim). Claiming is
**orthogonal to status** — it does not move the task; pair with `move`.

`--ttl N` takes a **lease** instead of an indefinite claim: past-due, the server
sweep auto-releases it (`task.released` with `expired:true`) and any agent may
take it over without `--force` — a dead agent never wedges a task. Re-claiming
your own task renews the lease (or clears it when called without `--ttl`); this
heartbeat emits no event. See [09 §9](09-concurrency.md).

```
$ KANBAN_AGENT=alice kanban claim T-12
T-12 claimed by alice
$ KANBAN_AGENT=bob kanban claim T-12
error: T-12 already claimed by alice        # exit 4
```

---

## Docs commands (board-native knowledge)

Board-native documents — design docs, ADRs, spike write-ups, research notes —
whose markdown bodies live **on the board** (the deliberate exception to
reference-only artifacts; guard rails in [ADR 0007](adr/0007-docs-store-content.md)).
Kinds: `design | adr | spike | research | note`. Statuses: `draft | active |
accepted | rejected | superseded` (ADRs/designs/spikes start `draft`;
research/notes start `active`).

### `kanban doc add "<title>" --kind K [--body MD | --body-file PATH] [--summary T] [--status S] [--link T-1,...]`
Creates a doc, optionally linking tasks in the same call. Bodies over 64 KB are
rejected (exit `1`) — store big material as a file and attach an artifact instead.

```
$ kanban doc add "Use FTS5 for search" --kind adr --summary "FTS5 over LIKE" --body-file adr.md --link T-12
D-3  created [adr/draft]  linked: T-12
```

### `kanban doc show <D-id> [--max-tokens N] [--full] [--json]`
Summary + full markdown body. **Budgeted by default** (2000 tokens): the body
tail sheds with a never-silent `[body trimmed: …]` footer; `--full` renders
everything. This is the only read tier that ever includes a body.

### `kanban doc update <D-id> [--title T] [--body MD | --body-file PATH] [--summary T] [--status S] [--superseded-by D-n]`
Edits fields. `--superseded-by` also flips the status to `superseded` unless a
status is given explicitly. A doc cannot supersede itself.

### `kanban doc link <D-id> <T-id>` / `kanban doc unlink <D-id> <T-id>`
Many-to-many task links; linking is idempotent (re-link emits no event).

### `kanban doc archive <D-id>`
Soft-deletes: the doc drops out of `docs`, task contexts, and the UI.

### `kanban docs [--kind K] [--status S] [--task T-1] [--limit N] [--max-tokens N] [--full] [--json]`
One terse line per doc (id, kind/status, title, summary) — never bodies.
Linked docs also surface in `context <id>` as a `docs (n):` section.

### `kanban search "<query>" [--type task|doc|comment] [--limit N] [--max-tokens N] [--full] [--json]`
Board-wide FTS5 search over tasks (title/description/summary), docs
(title/summary/body), and comments — ranked (bm25), one line per hit with a
matched-text snippet. FTS5 query syntax is allowed; input that isn't valid
syntax retries as a literal phrase. Archived content never surfaces. On a
SQLite build without FTS5 the board degrades to substring matching
(`?json` exposes `fts: false`).

```
$ kanban search "token exchange" --type task
T-12 [task/In Progress] "Wire up OAuth callback" — …the token exchange handles…
```

---

## Git commands (repo linkage — ADR 0008)

All git/`gh` execution runs **CLI-side in your cwd**; the server never shells
out. Convention: branches named `T-n-<slug>`, commit subjects mentioning `T-n`.

### `kanban git link [T-n] [--depth N]`
Scans recent commits (default 500) and local branches for `T-n` mentions and
records them as `commit`/`branch` artifacts on those tasks (unknown ids are
skipped). Idempotent — re-run freely, e.g. from the post-commit hook.

### `kanban git branch <T-n> [--checkout|--create]`
Prints the conventional branch name `T-n-<slugged-title>`; `--checkout` creates
and switches, `--create` just creates.

### `kanban git status [T-n]`
Board git artifacts for the task (default: task ids in the current branch name)
merged with live state: flags the current branch, and — when `gh` is available —
appends `[PR open · checks green]`-style PR/CI status, fetched on demand and
never stored.

### `kanban git install-hooks [--force]`
Installs `prepare-commit-msg` (appends `[T-n]` from the branch name, once) and
`post-commit` (fire-and-forget `kanban git link`; a down server never blocks a
commit). Refuses to overwrite non-kanban hooks without `--force`.

```
$ kanban git branch T-12 --checkout      # T-12-wire-up-oauth-callback
$ git commit -m "handle token errors"    # hook appends [T-12]
$ kanban git status
T-12 "Wire up OAuth callback" [In Progress]
  branch T-12-wire-up-oauth-callback  branch:T-12-wire-up-oauth-callback  ← current
  commit handle token errors [T-12]  git:3f9c…  
  pr     auth PR  https://github.com/acme/app/pull/42  [PR open · checks green]
```

---

## Brainstorm commands (ideation)

Structured ideation: capture ideas fast on a session, then cluster, score, and
promote the winners to tasks. Use when exploring more than ~3 candidate
approaches — otherwise just `add` tasks.

### `kanban brainstorm start "<topic>" [--task T-1]`
Opens a session (B-n). `--task` anchors it to the task that prompted it — the
session then surfaces as a one-line `brainstorm:` anchor in that task's `context`.

### `kanban brainstorm add <B-id> "<text>" [--cluster NAME]`
Captures an idea (I-n, ≤2000 chars — bigger material belongs in a doc). Rejected
on a closed session (exit `1`).

### `kanban brainstorm show <B-id> [--max-tokens N] [--full] [--json]`
Ideas grouped by cluster — clusters ranked by their best idea, ideas score-desc
within — with `→ T-n` on promoted and `✕` on discarded ones. Budgeted: the
lowest-ranked cluster blocks shed first, never silently.

### `kanban brainstorm list [--status open|closed] [--task T-1] [--json]` / `kanban brainstorm close <B-id>`
One line per session (idea/promoted counts). `close` ends capture (idempotent);
closed sessions keep their ideas readable and searchable.

### `kanban idea score <I-id> <0-10>` / `kanban idea cluster <I-id> <name>`
Shape the pool. Scores are integers 0–10; clusters are free-form names.

### `kanban idea promote <I-id> [--title T] [--prio P] [--status S] [--parent T-n]`
Turns an idea into a real task **atomically** — task created (title defaults to
the idea text; description carries a provenance line), idea marked `promoted`
with `promoted_task_id`, `idea.promoted` fired: the task exists iff the idea is
promoted. Promoted ideas are frozen.

### `kanban idea drop <I-id>`
Discards an idea (one-way; re-add if it was wrong). Discarded ideas stay
searchable — they are prior art, not deletions.

```
$ kanban brainstorm start "cache strategy" --task T-12      # → B-2
$ kanban brainstorm add B-2 "write-through" --cluster safe  # → I-4
$ kanban idea score I-4 8
$ kanban idea promote I-4 --prio P1                          # → T-31, atomically
$ kanban brainstorm close B-2
```

---

## Human-in-the-loop commands

### `kanban ask <id> "<question>" [--options a,b,c] [--freeform] [--expires-at ISO] [--default X]`
Creates a durable input request, moves the task to needs-input, broadcasts to the
UI, and **returns `Q-n` immediately (non-blocking)**. `--options` is repeatable
and each occurrence may be comma-separated.

`--default X` (requires `--expires-at`; must be one of `--options` for closed
sets) auto-answers the request with `X` at expiry instead of dead-ending it as
`expired` — the agent stays unblocked when the human is away. The resolution is
flagged everywhere (`answered_by: system:default`, `input.answered` with
`defaulted: true`, `inbox`/`await` print `(defaulted)`); a human answer before
the deadline always wins.

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
| `kanban completion <bash\|zsh\|pwsh>` | Print a static shell completion script (see below). |

Most commands above map 1:1 to a REST endpoint in
[07-api-reference](07-api-reference.md); `board init` / `board nudge` are local
edits to `.kanban/` and need no running server.

### Shell completion

`kanban completion <shell>` prints a **static** completion script whose command
and flag tables are generated by introspecting the live commander program — they
can never drift from the CLI. `powershell` is accepted as a `pwsh` alias.
Completion is commands + long flags only; no dynamic task-id completion (that
would cost a server round-trip per keystroke).

```
# PowerShell (add to $PROFILE to persist)
kanban completion pwsh | Out-String | Invoke-Expression
# bash
eval "$(kanban completion bash)"
# zsh (with the target dir on $fpath)
kanban completion zsh > ~/.zsh/completions/_kanban
```
