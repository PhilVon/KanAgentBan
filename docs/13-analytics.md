# 13 — Analytics / Burndown

> **Summary:** `kanban stats` exposes **per-task timing** (lead, cycle, time per
> status), **board throughput / velocity**, **WIP & aging**, and a **burndown
> series** — all derived read-only from the append-only event log plus the live
> task rows. There are **no new events, no schema change, and no writes**; the
> spine already records every status transition (`task.moved {from,to}`), so the
> reporting layer just replays it. Surfaced via the CLI (`kanban stats [id]`),
> REST (`GET /api/stats`, `GET /api/tasks/:id/stats`), and a web metrics/burndown
> panel.
>
> **Decisions:** Pure derivation mirrors the `recommend.ts` → `render.ts` split
> (logic in `src/server/stats.ts`, formatting in `render.ts`). Output honours the
> token-budget contract ([03-token-efficiency](03-token-efficiency.md)) and is
> **never-silent about the compaction floor** — tasks whose history was compacted
> are flagged and excluded from timing aggregates rather than reported wrong. Not
> exposed as an MCP tool (analytics is a human/reporting concern, like `export` /
> `compact`; [12-mcp](12-mcp.md)).
>
> **Open questions:** none. Cloud-scale rollups / cross-board analytics remain
> with the deferred multi-machine work ([11-roadmap](11-roadmap.md)).

Related: [02-data-model](02-data-model.md) · [03-token-efficiency](03-token-efficiency.md) ·
[05-cli-reference](05-cli-reference.md) · [07-api-reference](07-api-reference.md) ·
[08-web-ui](08-web-ui.md) · [11-roadmap](11-roadmap.md)

---

## 1. What it measures

| Group | Metrics |
|---|---|
| **Per-task timing** | lead time (created → terminal Done), cycle time (first In Progress → terminal Done), **flow efficiency** (active / lead), time in current status, total time per status, active In-Progress time (summed stints) |
| **Throughput / velocity** | tasks completed per day over a window; rolling average per day; per-week |
| **WIP & aging** | current count per workflow column; oldest task per column (age); **aging buckets** (fresh / aging / stale); **aging flags** (non-Done tasks >7d) |
| **Burndown** | per-day series of `remaining` vs `done` vs `created_cum` over a window |
| **Flow health** | **net flow** (arrival vs departure); **input-wait latency** (human response time); **rework** (reopen + kickback rates); **completion forecast** (days-to-drain) |
| **Breakdowns** | **per-priority** lead/cycle/WIP; **per-label** throughput; **per-agent** throughput; **CFD** (cumulative-flow series) |

## 2. Derivation — the status timeline

For each task, its ordered events (`repo.changes(0)` filtered by `task_id`) plus
the task row reconstruct a **timeline** of segments `{status, enter, exit}`:

- The timeline starts at the task's `created_at`. `task.created` carries no status
  (its payload is `{title, parent_id?}`), so the **starting column** is recovered
  from the first `task.moved.from`; with no moves, the task has lived in one column
  = its current `status` (this correctly handles a task created directly into a
  non-Backlog status).
- Each `task.moved {from,to}` closes the open segment at the event `ts` and opens
  `{status: to}`. The last segment is open (`exit = null`).
- For durations, the open segment is capped at `archived_at` (if archived) or now.

From the timeline:

- **first_in_progress_at** — enter of the earliest `In Progress` segment (null if
  the task never entered In Progress).
- **done_at** — enter of the **terminal** `Done` segment (the current status). A
  task reopened out of Done (`Done → In Progress`) has `done_at = null` and is
  flagged `reopened` (with `reopen_count`); it counts as open WIP again.
- **lead_ms** = `done_at − created_at` (null unless currently Done).
- **cycle_ms** = `done_at − first_in_progress_at` (null unless currently Done and
  it entered In Progress); the wall-clock first-IP → final-Done span.
- **active_in_progress_ms** / **time_per_status** — summed segment durations, so
  multiple In-Progress stints accumulate.
- **time_in_current_status_ms** = `(archived_at ?? now) − last segment enter`.
- **flow_efficiency** = `active_in_progress_ms / lead_ms`, clamped to `[0,1]`; null
  when `lead_ms` is null/0 (no meaningful denominator). The fraction of a task's
  lead time actually spent in active work — the rest is queue/wait time.

## 3. Burndown & throughput definitions

- **remaining** at end-of-day *D* = tasks `created_at ≤ endOf(D)` AND not Done
  as-of *D* AND not archived as-of *D*. "Status as-of *D*" is the segment active at
  `endOf(D)`. Days bucket by **UTC calendar day** over a window (default 14, max
  365, `--window`). The window is **clamped to the project's age** — the earliest
  task's `created_at` — so a board younger than the requested window never renders
  leading days that predate any task (those buckets are all-zero and misleading);
  `window.days` reflects the clamped value.
- **done** at *D* = tasks whose as-of-*D* status is `Done`. **created_cum** =
  created on/before *D*. Invariant: `remaining + done ≤ created_cum`,
  `remaining ≥ 0`.
- **throughput** — a task is completed on day *D* when its terminal Done segment was
  entered on *D*; `rolling_avg_per_day = total / windowDays`, `per_week = avg × 7`.
- **timing_summary** — p50 / p90 / avg of lead, cycle, and **flow_efficiency** over
  **non-partial, currently-completed** tasks. Duration summaries round to integer
  ms; the flow-efficiency summary rounds to 2 decimals (it is a `[0,1]` ratio).

## 3.5 Expanded metrics (FORMAT_VERSION 7)

All derived in the same single pass over the event log + live rows; no new events.
Each is also surfaced as a render line **after** the core block, so token budgeting
sheds it first ([03-token-efficiency §4](03-token-efficiency.md)).

- **WIP aging buckets** (`wip[].aging`) — each column's live tasks partitioned by
  age-since-creation into `fresh ≤1d`, `aging 1–7d`, `stale >7d`. The three buckets
  **sum to `count`**.
- **aging_flags** — non-archived, **non-Done** tasks older than the stale threshold
  (`>7d`), as `{id, status, age_ms}` sorted oldest-first. A board-level "these have
  been sitting" list, distinct from per-column oldest.
- **input_wait** — human response latency on `ask`/`await`, derived from
  `repo.getAllRequests()`: `wait = answered_at − created_at`. Fields: `open`,
  `oldest_open_ms` (max age of open requests, null when none), `resolved`
  (MetricSummary over **answered** waits), and the `answered` / `expired` /
  `cancelled` counts.
- **flow** (net flow rate) — `arrival_per_day = (tasks created in-window) / days`;
  `departure_per_day = throughput.rolling_avg_per_day`; `net_per_day = arrival −
  departure`; `trend` = `growing` (net>0) / `shrinking` (net<0) / `flat`. Positive
  net ⇒ the backlog is growing faster than it drains.
- **quality** (rework) — `reopened` = count of `Done → (left Done)` transitions
  (summed `reopen_count`); `reopen_rate = reopened / tasks-that-ever-reached-Done`.
  `kickbacks` = count of backward `Review → In Progress` moves across the event log;
  `kickback_rate = kickbacks / moves-into-Review`. Rates are 0 when the denominator
  is 0.
- **by_priority** — for each `P0..P3`: `n` (completed, non-partial), `lead` & `cycle`
  MetricSummaries over that group, and `wip` (current non-archived, non-Done count).
- **forecast** — `remaining` = current non-archived non-Done; `velocity_per_day =
  rolling_avg_per_day`; `days_to_drain = ceil(remaining / velocity)` (**null** when
  velocity is 0); `eta` = that many days from today (`YYYY-MM-DD`, null when no
  drain date); `diverging = net_per_day ≥ 0` (backlog not shrinking).
- **by_label** — grouped by a task's **current** labels: `n` (completed), `cycle`
  MetricSummary, `wip`. The full set is returned sorted by volume; renderers cap to
  the top `LABEL_TOP_N` (8) with a never-silent footer for the remainder.
- **by_agent** — each completed task is credited to the **last `task.claimed`
  assignee before its terminal Done**: `completed`, `cycle` MetricSummary,
  `active_wip` (currently-claimed non-Done). The section is **empty when no claims
  exist** on the board.
- **cfd** (cumulative-flow diagram) — extends the burndown day loop: for each window
  day, count `created ≤ EOD AND not archived-as-of-EOD` tasks bucketed by
  status-as-of-EOD. Invariant: **each day's column sum == created-not-archived as of
  EOD**. Gated behind `?cfd=1` on the REST envelope to keep the default payload lean.

## 4. The compaction floor (never-silent)

Compaction deletes events at/below `meta.compaction_floor`
([02-data-model §3](02-data-model.md)). A task whose `task.created` event has been
compacted (`floor > 0` and its earliest *retained* event is not `task.created`) has
incomplete transition history. Such a task is flagged `partial_history` and
**excluded from timing aggregates** (lead/cycle summaries, `excluded_partial`),
rather than contributing wrong numbers. The live task row is never compacted, so it
still counts toward current WIP and the burndown counts. Every surface makes this
explicit:

- `boardStats` stamps top-level `compaction_floor`, `partial_history`, and
  `excluded_partial[]`.
- `renderStats` appends `[history bounded: metrics cover events since seq F; N
  task(s) excluded from timing — older history compacted]`.
- The web panel shows a banner.

## 5. Surfaces

### CLI ([05-cli-reference](05-cli-reference.md))

```
kanban stats                 # board analytics + burndown/velocity sparklines
kanban stats T-12            # per-task timing
kanban stats --window 30     # 30-day window
kanban stats --json          # full structured object + est_tokens meter
kanban stats --max-tokens N  # token-budgeted; never-silent footer
```

### REST ([07-api-reference](07-api-reference.md))

- `GET /api/stats?window=&json&full&max_tokens&cfd` → `{ text }` (token-budgeted)
  or, with `json`, the full `BoardStats` (`window`, `compaction_floor`,
  `partial_history`, `excluded_partial`, `throughput`, `wip` (+`aging`),
  `aging_flags`, `burndown`, `timing_summary` (+`flow_efficiency`), `input_wait`,
  `flow`, `quality`, `by_priority`, `forecast`, `by_label`, `by_agent`, `cfd`) plus
  `est_tokens`. `cfd` is `[]` unless `?cfd=1` is passed.
- `GET /api/tasks/:id/stats?json&full&max_tokens` → `{ text }` or the `TaskTiming`
  object (`lead_ms`, `cycle_ms`, `flow_efficiency`, `time_per_status`, `reopened`,
  `partial_history`, …). Unknown id → 404.

### Web ([08-web-ui](08-web-ui.md))

A **📊 Metrics** toggle in the header opens a panel: metric tiles (throughput,
lead/cycle p50·p90, flow efficiency, net flow, drain forecast, input wait, rework,
and WIP-per-column folding in the fresh/aging/stale breakdown), per-priority /
per-label / per-agent tables, an aging-flags table, an inline-SVG burndown chart
(remaining vs done vs created), and a stacked-area **cumulative-flow** chart — no
external chart dependency. It refetches `/api/stats?json&cfd=1` on each WebSocket
frame while open, and shows the bounded-history banner when `partial_history`.

## 6. Files

- `src/server/stats.ts` — pure derivation: `taskTiming`, `boardStats`,
  `buildSegments`, internal burndown/throughput/WIP helpers.
- `src/server/render.ts` — `renderStats`, `renderTaskStats`, `fmtDur`, sparkline,
  expansion lines (`FORMAT_VERSION 7`).
- `src/server/server.ts` — `GET /api/stats`, `GET /api/tasks/:id/stats`.
- `src/cli/kanban.ts` — `stats [id]`.
- `web/app.js` / `web/index.html` / `web/style.css` — the metrics panel.
- `tests/stats.test.ts` — timing edge cases, burndown invariant, REST, and the
  compaction partial-history contract.
