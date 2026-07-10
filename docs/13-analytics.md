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
| **Bottleneck** | **dwell by status** (closed-stint p50/p90/avg per column, non-partial tasks, all retained history); the slowest of `Ready`/`In Progress`/`Review` is flagged the **bottleneck** (Backlog is long-lived by design, Done is terminal) |
| **Velocity trend** | recent half of the window vs the prior half (middle day dropped when odd): `up`/`down` on a >10% move, `flat` otherwise or when the window is under 4 days; `delta_pct` is null when the prior half is 0 |

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

## 3. Adaptive bucketing (pace-aware, `src/server/pace.ts`)

Agent-driven boards move in minutes, not days, so fixed calendar-day buckets render
a young board as one useless dot. Instead the **bucket width scales with the board's
age**, so every board — 30 minutes or 60 days old — gets a readable multi-point
series. All three time-series (burndown, throughput, CFD) share one bucket grid.

- **Span.** `--window <days>` (default 14, clamped 1–365) is an **upper bound** on
  the span. The rendered span is `max(MIN_SPAN_MS=30m, min(window·day, board_age))`,
  where `board_age = now − earliest task created_at` (a never-compacted task-row
  field). So the window still clamps to project age (no all-zero leading buckets),
  and the 30-minute floor guarantees ≥2 points on any board with a task older than
  one bucket.
- **Bucket width** is the smallest step in the ladder `[5m, 15m, 30m, 1h, 2h, 4h,
  6h, 12h, 1d, 2d, 7d]` that keeps the series at or under **`TARGET_MAX_BUCKETS`=32**
  points (~33 sparkline chars fit 80 cols; ≥15px/pt in the 560px SVG). A 365-day
  window falls through to weekly (≤53 buckets — accepted overflow).
- **Alignment.** Bucket edges are multiples of the step from the Unix epoch
  (`firstStart = floor((now−span)/step)·step`). Sub-day rungs divide 24h so they land
  on clean UTC clock boundaries; `1d`/`2d` on UTC midnight; `7d` is Thursday-aligned
  (epoch-anchored — deterministic, documented not special-cased).
- **The last bucket is partial** — it ends at `now` (= `generated_at`), so the
  freshest data always shows. `window.to` is that timestamp.
- **`window`** carries `days` (clamped whole-day figure, for CLI/MCP continuity),
  `from`/`to` (ISO timestamps), `span_ms`, `bucket_ms`, `bucket` (label e.g. `"15m"`),
  `buckets` (series length), and `clamped` (true when board age < requested window).

Each time-series point is keyed by **`t`** (ISO 8601 UTC bucket start), *not* a
`YYYY-MM-DD` `date` (the field was renamed on the clean break so stale consumers
fail loudly rather than mis-slicing an ISO string).

- **remaining** for a bucket = tasks `created_at ≤ asOf` AND not Done as-of `asOf`
  AND not archived as-of `asOf`, where **`asOf = min(bucketEnd − 1, now)`** (the last
  instant of the bucket). "Status as-of" is the segment active at `asOf`.
- **done** = tasks whose as-of status is `Done`. **created_cum** = created on/before
  `asOf`. Invariant: `remaining + done ≤ created_cum`, `remaining ≥ 0`.
- **throughput** — a task is completed in a bucket when its terminal Done segment was
  entered within `[bucketStart, bucketEnd)`. Rates normalize by the **fractional
  span**: `rolling_avg_per_day = total / (span_ms/day)` — so a 6-hour board with 10
  completions reads ~40/day, not a day-floored 10/day. `per_week = avg × 7` (kept in
  JSON; the rendered line drops `/week` when the span is under a week).
- **velocity trend** — halves of the bucket series compared, each normalized to
  per-day; the "too small to compare" guard is now **< 4 buckets** (essentially only
  degenerate series, so young boards finally get a real trend). The partial last
  bucket biases the recent half slightly low — accepted (dropping it would ignore the
  newest work).
- **timing_summary** — p50 / p90 / avg of lead, cycle, and **flow_efficiency** over
  **non-partial, currently-completed** tasks. Duration summaries round to integer
  ms; the flow-efficiency summary rounds to 2 decimals (it is a `[0,1]` ratio).

### 3.1 Pace-aware aging thresholds (`paceThresholds` / `boardPace`)

Aging (fresh/stale) no longer uses fixed 1d/7d constants — those read "fresh forever"
on a board whose tasks complete in minutes. `boardPace(repo)` derives thresholds from
the board's own tempo and is the **single source** shared by stats, `doctor`, and
`standup` (so the three never drift):

- With **≥ `MIN_COMPLETIONS`=5** non-partial completions and a usable p90 cycle time:
  `stale = clamp(3 × p90_cycle, 1h … 7d)`, `fresh = max(stale/7, 5m)`,
  `basis = "cycle-time"`. The 7d **ceiling** means pace-awareness only ever
  *tightens* vs. the legacy behaviour; the 1h **floor** guards hyper-fast boards.
- Below the completion floor (or no usable p90): the fixed legacy `stale=7d, fresh=1d`,
  `basis = "default"`.
- **Never-silent:** `BoardStats.pace` (and the standup report's `pace`) carry
  `{stale_ms, fresh_ms, basis, n}`; every rendered aging line states the threshold
  used and tags `(pace)` when tempo-derived. WIP aging buckets and `aging_flags` use
  these thresholds.

### 3.2 Forecast precision

`forecast.ms_to_drain = remaining / velocity_per_day` (in ms; `null` at zero
velocity), with `days_to_drain = ceil(ms_to_drain / day)` kept for continuity and
**`eta` a full ISO timestamp**. The rendered line shows an hour-precision ETA
(`2026-07-10 21:00 UTC`) when the drain is under 3 days, else the day figure.

## 3.5 Expanded metrics (FORMAT_VERSION 7)

All derived in the same single pass over the event log + live rows; no new events.
Each is also surfaced as a render line **after** the core block, so token budgeting
sheds it first ([03-token-efficiency §4](03-token-efficiency.md)).

- **WIP aging buckets** (`wip[].aging`) — each column's live tasks partitioned by
  age-since-creation into `fresh ≤ pace.fresh_ms`, `aging`, `stale > pace.stale_ms`
  (pace-aware thresholds, §3.1). The three buckets **sum to `count`**.
- **aging_flags** — non-archived, **non-Done** tasks older than `pace.stale_ms`, as
  `{id, status, age_ms}` sorted oldest-first. A board-level "these have been sitting"
  list, distinct from per-column oldest.
- **input_wait** — human response latency on `ask`/`await`, derived from
  `repo.getAllRequests()`: `wait = answered_at − created_at`. Fields: `open`,
  `oldest_open_ms` (max age of open requests, null when none), `resolved`
  (MetricSummary over **answered** waits), and the `answered` / `expired` /
  `cancelled` counts.
- **flow** (net flow rate) — `arrival_per_day = (tasks created in-window) /
  (span_ms/day)` (fractional span, matching throughput); `departure_per_day =
  throughput.rolling_avg_per_day`; `net_per_day = arrival − departure`; `trend` =
  `growing` (net>0) / `shrinking` (net<0) / `flat`. Positive net ⇒ the backlog is
  growing faster than it drains. Rendered lines show these via `fmtRate` (per-hour
  when brisk).
- **quality** (rework) — `reopened` = count of `Done → (left Done)` transitions
  (summed `reopen_count`); `reopen_rate = reopened / tasks-that-ever-reached-Done`.
  `kickbacks` = count of backward `Review → In Progress` moves across the event log;
  `kickback_rate = kickbacks / moves-into-Review`. Rates are 0 when the denominator
  is 0.
- **by_priority** — for each `P0..P3`: `n` (completed, non-partial), `lead` & `cycle`
  MetricSummaries over that group, and `wip` (current non-archived, non-Done count).
- **forecast** — `remaining` = current non-archived non-Done; `velocity_per_day =
  rolling_avg_per_day`; `ms_to_drain = remaining / velocity` (in ms, **null** when
  velocity is 0), `days_to_drain = ceil(ms_to_drain / day)`; `eta` = full ISO
  timestamp (null when no drain date); `diverging = net_per_day ≥ 0` (backlog not
  shrinking). See §3.2 for the hour-precision render.
- **by_label** — grouped by a task's **current** labels: `n` (completed), `cycle`
  MetricSummary, `wip`. The full set is returned sorted by volume; renderers cap to
  the top `LABEL_TOP_N` (8) with a never-silent footer for the remainder.
- **by_agent** — each completed task is credited to the **last `task.claimed`
  assignee before its terminal Done**: `completed`, `cycle` MetricSummary,
  `active_wip` (currently-claimed non-Done). The section is **empty when no claims
  exist** on the board.
- **cfd** (cumulative-flow diagram) — extends the burndown bucket loop: for each
  bucket, count `created ≤ asOf AND not archived-as-of-asOf` tasks bucketed by
  status-as-of-`asOf` (§3). Invariant: **each bucket's column sum ==
  created-not-archived as of its `asOf`**. Gated behind `?cfd=1` on the REST envelope
  to keep the default payload lean.

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
  or, with `json`, the full `BoardStats` (`window` (now with `span_ms`, `bucket_ms`,
  `bucket`, `buckets`, `clamped`), `compaction_floor`, `partial_history`,
  `excluded_partial`, `throughput`, `wip` (+`aging`), `aging_flags`, `burndown`,
  `timing_summary` (+`flow_efficiency`), `input_wait`, `flow`, `quality`,
  `by_priority`, `forecast` (+`ms_to_drain`, ISO `eta`), `by_label`, `by_agent`,
  `cfd`, `pace`) plus `est_tokens`. Time-series points are keyed by `t` (ISO), not
  `date`. `cfd` is `[]` unless `?cfd=1` is passed. `window` is still passed in **days**.
- `GET /api/tasks/:id/stats?json&full&max_tokens` → `{ text }` or the `TaskTiming`
  object (`lead_ms`, `cycle_ms`, `flow_efficiency`, `time_per_status`, `reopened`,
  `partial_history`, …). Unknown id → 404.

### Web ([08-web-ui](08-web-ui.md))

A **📊 Metrics** toggle in the header opens a panel: metric tiles (throughput,
lead/cycle p50·p90, flow efficiency, net flow, drain forecast, input wait, rework,
and WIP-per-column folding in the fresh/aging/stale breakdown), per-priority /
per-label / per-agent tables, an aging-flags table, an inline-SVG burndown chart
(remaining vs done vs created), and a stacked-area **cumulative-flow** chart — no
external chart dependency. Chart headers name the adaptive bucket size (and
"board age" vs "window"); x-axis ticks scale to the bucket (`HH:MM` sub-day, `MM-DD`
otherwise) with a middle tick added for orientation. It refetches
`/api/stats?json&cfd=1` on each WebSocket frame while open, and shows the
bounded-history banner when `partial_history`.

## 6. Files

- `src/server/pace.ts` — pure math (no local imports): bucket ladder + `chooseBucket`
  / `bucketRange` / `bucketLabel`, and `paceThresholds`. Shared by stats/doctor/standup.
- `src/server/stats.ts` — pure derivation: `taskTiming`, `boardStats`,
  `buildSegments`, `boardPace` (the shared aging-threshold source), internal
  bucket/burndown/throughput/WIP helpers.
- `src/server/render.ts` — `renderStats`, `renderTaskStats`, `fmtDur`, `fmtRate`,
  `fmtBucketTick`, sparkline, expansion lines (`FORMAT_VERSION 18`).
- `src/server/server.ts` — `GET /api/stats`, `GET /api/tasks/:id/stats`.
- `src/cli/kanban.ts` — `stats [id]`.
- `web/app.js` / `web/index.html` / `web/style.css` — the metrics panel.
- `tests/pace.test.ts` — bucket-ladder selection, alignment, and `paceThresholds`.
- `tests/stats.test.ts` — timing edge cases, adaptive bucketing, burndown invariant,
  REST, and the compaction partial-history contract.
- `tests/pace-consistency.test.ts` — the aging threshold is identical across stats,
  `doctor`, and `standup` (single source, no drift).
