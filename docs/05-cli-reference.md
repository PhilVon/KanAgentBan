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
  `--format-version <n>` pins the plaintext schema (current: `24`). No ANSI colour
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
emits the raw `{open, watching, answered, resolved, cursor}` payload — `watching` is the open **watches** (`kanban expect`), listed under their own heading because nothing in it is waiting on the human. `--since <seq>` returns
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

### `kanban add "<title>" [--desc|--description T] [--summary T] [--status S] [--prio P0..P3] [--parent T-1] [--label L,...] [--depends T-3,T-4] [--ac "text" ...]`
Creates a task; prints the new `T-n`. `--depends` adds `blocks` edges;
`--ac` adds acceptance criteria. `--parent` nests it as a subtask under an
existing task (§subtasks). `--label` and `--depends` are repeatable and each
occurrence may be comma-separated (`--label a,b --label c` -> a, b, c).
`--description` is an alias of `--desc`.

### `kanban update <id> [--title T] [--desc|--description T] [--summary T] [--prio P] [--expect-version N]`
Edits fields. `--expect-version` enables optimistic concurrency; a stale version
exits `4`. `--description` is an alias of `--desc` — the description is the field
worth rewriting once a symptom's cause is known, and the long spelling is the one
you reach for, so both work.

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

### `kanban criterion add <id> "<text>" [--human]` / `check <AC-id> [--off]` / `retire <AC-id> --because "<why>" [--successor T-n]` / `amend <AC-id> "<text>"`
Manage acceptance criteria; `check --off` unchecks.

A criterion used to have exactly **two** states, so one that turned out to be wrong
could only be ticked falsely, left unchecked forever, or escalated as a question the
agent raised about its own planning error. Two more states close that:

- **`--human`** — only the human can settle it (a playtest, *"does it read right?"*).
  It stays in the denominator (it is still work), but `doctor` names it apart from
  work the *agent* is failing to finish, and the UI marks it *for you*. Without it an
  agent raises one `Q-n` per such criterion — six of one session's ten questions
  existed only to route criteria the board could not.
- **`retire`** — the criterion turned out to be **wrong**, not undone. It leaves
  **both** sides of the count (`criteria 5/6 · 1 retired`), never blocks `done`, and
  can no longer be ticked. `--because` is **required**: *"the client has no
  transcripts, so this cannot be built; T-321 carries it"* is a better record than
  either a false tick or an unchecked box. This is the exit for a **hypothesis**
  criterion the code disproves (see [06-skill](06-skill.md) §4).
- **`amend`** — the criterion is merely badly *typed*. The text was write-once, so a
  criterion carrying its author's own stray numbering read `AC-1111 AC-1031 …`
  permanently. Use `retire` when it is wrong, `amend` when it is mistyped.

The count line grows its `· N retired` / `· N for the human` tails **only when
non-zero** — an ordinary task still reads exactly `criteria 5/6`. In `context`, a
retired criterion renders `[~] AC-n text — retired: <why> (→ T-n)`, and a human one
carries `[human]`. A retired criterion is also excluded from a `template save`
blueprint: a blueprint carries the shape of the work, and a retired criterion is a
planning error already corrected.

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
past the pace-derived stale threshold, which the finding prints), `ancient-ask`
(open **question** >48h — never a watch), `stale-watch` (an open watch >14d), `answered-elsewhere` (an open `Q-n` on a task that is now Done
or in Review), `stale-summary` (description newer than summary),
`done-eligible-parent` (all subtasks Done, parent still open). **Exit `0` =
healthy, exit `2` = findings** (same semantic-exit pattern as `await`'s pending)
— run it at session start and act on what it reports.

Every finding names its fix **and what its own check cannot see**, as a trailing
`[cannot see: …]` clause (`blind_spot` under `--json`):

```
done-eligible-parent (1):
  T-4  all 18 subtask(s) Done, but 3 of its own 3 criteria unchecked — close only
       if those are met or retired: kanban done T-4  [cannot see: rolls up subtask
       status only — it cannot judge whether a criterion is met, …]
```

This is a safety property, not a courtesy. A finding pre-writes a mutating
command, and a reader handed a pre-written command is inclined to run it — the
bare earlier form of that line (`all 18 subtask(s) Done — close it:`) nearly
closed a task whose own acceptance criteria were unmet. So any check that can be
locally right and globally wrong says which, and phrases its command
conditionally. `answered-elsewhere` is the same shape pointed at the human
channel: an answer given in chat and acted on but never written back leaves
finished work reading as still waiting on them — and the check cannot tell that
from a legitimate `Review` sign-off gate, so it says so.

Thresholds are deliberately not flags: the claim/question ones are fixed (they
measure human latency), and the aging one derives from the board's own completion
pace.

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

### `kanban board affect [--on|--off] [--map label=cue] [--unmap label]`
Opt into **affect hints** (ADR 0009) — **off by default**. With hints on, the board
emits a labelled `affect: eb consult …` line at the moments it knows a choice is
being made, and `context` prints a `cues:` line from the task's labels.

The board emits **text and nothing else**: it never executes `eb`, never reads the
brain, never stores a stance, and never renders affect to the human. EmotionalBrain's
ADR 0008 forbids the linkage form by name and leaves exactly this door open ("the
agent does it"). A machine with no `eb` installed is unaffected — the feature is a
string.

| Moment | Emitted |
|--------|---------|
| `brainstorm start` | `affect: eb consult "<topic>" --about <cues>` |
| `next` with **2+** ready candidates | `affect: eb consult --options "<t1>,<t2>,…"` (capped at 4) |
| `claim` | `affect: eb consult "picking up T-n: <title>" --about <cues>` |
| `context` | `cues: activity:port, lang:ts` |

`--map port=activity:port` is what makes a label a cue: **an unmapped label emits no
cue at all**, because a board minting vocabulary out of its own bookkeeping labels is
cue sprawl at the source, and `eb` cue keys can never be renamed or merged. The cue is
validated when you set it, so the board can never print a command `eb` would reject
(`proj:` is refused outright — `eb` derives it from the cwd). A task with **no** labels
emits no cues, never a guess from its title.

A task`s linked commits also contribute **`lang:` cues** — the languages its
commits touched, commonest first, capped at three. This is the one thing the board
derives rather than being told, and it is allowed for a narrow reason: the
extension → language table is **closed and canonical**, so the board applies a
convention the world already agreed rather than inventing a name. An extension
outside the table contributes nothing, exactly as an unmapped label does.

`json`, `yaml`, `toml` and `md` are deliberately absent — nobody works *in* JSON,
it rides along with whatever the real work was, and a cue on 90% of commits
discriminates nothing. Writing docs genuinely does feel different from writing
code, but that is an `activity:`, not a `lang:`.

Languages are computed **CLI-side at `kanban git link` time** and stored on the
commit artifact — the server never shells out ([ADR 0008](adr/)). Re-running
`git link` stays idempotent and backfills commits linked before the column existed.

`kanban board affect --check` reports the map against the labels actually in use —
what emits a cue, what does not, map entries `eb` would reject, and mappings for
labels no longer on the board. Unmapped labels lead with the number of live tasks
behind them, because that count is the advice: mapping the label on thirteen tasks
buys thirteen times the evidence of mapping the one on a single task.

```
affect hints on · 1 of 3 labels mapped

mapped (1):
  cli  -> activity:cli  (7 tasks)

unmapped (2) — these emit no cues:
  13  docs
   2  bug
  fix: kanban board affect --map <label>=<cue>
```

It is **read-only and exclusive** — combining it with `--on`/`--map` is rejected,
since a report describing state the same command just changed is worth little. An
unmapped label exits **0**: it is a preference, not a fault, and exiting non-zero
would pressure a board into mapping every label mechanically. Only a map entry
`eb` would reject exits **1**. It is deliberately *not* a `doctor` check.

The silence is never unexplained: `context` names the labels that produced no cue and
the command that fixes them (`cues: none — unmapped: docs, feature — kanban board affect
--map <label>=<cue>`), and `board affect` reports an empty map. The hint shows `<cue>`
rather than guessing a slug — picking the right cue is a judgement the agent makes, not
one the board makes for it.

Guard rails: the hint is always its own line and never folded into `why:`; it is
never emitted by `ask` (framing the options *was* the decision — the consult needed
to happen a step earlier) and never appears on `doctor` or anything
correctness-shaped; under `--max-tokens` it sheds **first**, leaving a never-silent
footer. Config lives in `.kanban/board.json` and is read per request — no restart.

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

**Loose retry.** Bare terms are AND-ed, which is right for precision but means a
three-word guess returns nothing — and search is the first thing an agent runs on
a cold board, so a zero-result first impression is expensive. When an all-terms
query finds nothing, the search retries OR-ranked and the result **says so**:

```
$ kanban search "clipping cut polaroid"
[loose: nothing matched every term of "clipping cut polaroid" — these match at least one, best first]
T-8  [task/Done] "Clipping the polaroid edge" — …
```

The header is the first line, so the token budget sheds hits before it, and
`?json` carries `loose: true`. Two guards: a **single term** is never rewritten
(an OR of one is the same query), and a query carrying its own FTS syntax —
quotes, `AND`/`OR`/`NOT`/`NEAR`, `*`, `^`, `:`, `(` `)` — is never rewritten
either, because that caller wrote a query rather than a bag of words. Spelling
the conjunction out (`clipping AND cut`) is therefore how you ask for a strict
result. A hyphenated word (`write-through`) is one term, not an operator. On the
LIKE fallback the retry ranks by how many terms matched (no bm25 to lean on).

---

## Git commands (repo linkage — ADR 0008)

All git/`gh` execution runs **CLI-side in your cwd**; the server never shells
out. Convention: branches named `T-n-<slug>`, commit subjects mentioning `T-n`.

### `kanban git link [T-n] [--depth N]`
Scans recent commits (default 500) and local branches for `T-n` mentions and
records them as `commit`/`branch` artifacts on those tasks (unknown ids are
skipped). Idempotent — re-run freely, e.g. from the post-commit hook.

After the summary it **notes any commit whose subject names more than one task**
(up to five, then a count):

```
linked 12 commit(s), 1 branch(es) (re-runs are idempotent)
note: 1 commit(s) name more than one task — a commit per task keeps the trail readable:
  3fa91c2  T-325, T-326  feat: crop handle + polaroid edge
```

Task boundaries and commit boundaries drift and nothing else reports it. This is
a note about shape, not an error: `git link` never refuses, and whether to split
is the author's call.

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

### `kanban expect <id> "<event>" [--expires-at ISO]`
Raises a **watch** — an event to wait for, not a decision to make. Same
`input_request` row as an `ask`, with `kind = 'watch'`, and the difference is the
whole point: **it does not set `needs_input`**, so the task is *parked* rather
than rendered Blocked and the human is not implicitly being chased for an answer
that does not exist.

```
$ kanban expect T-88 "the producer's seventeen files land in public/audio/"
Q-14  watching on T-88 (not blocking — resolve with: kanban answer Q-14 "…")
```

Written as an `ask`, a watch behaves badly and *stays* badly: it sets
`needs_input`, the UI derives **Blocked** from that, and it reads as a question
the human failed to answer — while every remedy `doctor` offers is wrong for it
(*nudge*: he knows; *re-ask*: resets a clock, changes no fact; *cancel*: throws
away the trigger). Splitting the kinds is what stops the Blocked projection
meaning two different things.

A watch:
- **never blocks** — `next` still recommends the task, the UI shows its real column
- gets its **own heading** in `inbox`, and a `[watch]` tag in `show` / `context`
- is counted apart from question traffic in `standup` (`watching` /
  `watch resolutions`)
- is **not** aged by `ancient-ask`; `doctor`'s `stale-watch` leaves it alone until
  it is 14 days old, and says outright that it cannot see whether the event
  happened
- resolves with `kanban answer <Q-n> "…"` (that resolution is what starts the
  work) or `kanban cancel <Q-n>` to drop the trigger; `--expires-at` drops it
  automatically

Answer-shaping flags are **rejected**, not ignored: a watch has nothing to
choose, so `--options`/`--freeform` mean you wanted `ask`.

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

### `kanban answer <Q-id> "<text>" [--note "<why>"]`
Records an answer from the CLI (parity with the UI). `--note` carries the **why**
beside the choice: `answer` was a single field, so a decision came back as
`lift-it` and the reasoning was lost — and answers get quoted in code comments,
where the reasoning is the half a reader in six months actually needs. The note is
optional, never required, and blank is stored as none.

It renders wherever the answer does: under the answer line in `inbox`, and in a
`decisions (n):` block in `show` (last 2) and `context` (last 3) —
`Q-7 "Redis or Postgres?" → Postgres` with `why: …` beneath. Under a tight budget
the block sheds with the open-input rung, leaving a never-silent footer. A task
with nothing answered renders exactly as before.

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
