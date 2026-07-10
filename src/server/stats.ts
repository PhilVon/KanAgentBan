// Analytics / burndown — a read-only reporting layer derived entirely from the
// append-only event log + the live task rows. No new events, no schema change,
// no writes. Mirrors the recommend.ts/derive.ts split: pure logic here, all
// formatting in render.ts. See docs/13-analytics.md.
//
// The server is model-free, so historical *transitions* live only in the event
// log — which compaction bounds (docs/02-data-model §3). A task whose
// `task.created` event has been compacted (`floor > 0` and its earliest retained
// event is not `task.created`) has incomplete history; its timing is best-effort
// and it is flagged `partial_history` and excluded from timing aggregates. The
// task row (`created_at`/`status`/`archived_at`) is never compacted, so current
// WIP counts stay authoritative.

import type { Repo } from './repo';
import type { BoardEvent, InputRequest, Priority, Task, WorkflowStatus } from '../shared/types';
import { PRIORITIES, WORKFLOW_STATUSES } from '../shared/types';
import { bucketRange, bucketLabel, paceThresholds, MIN_SPAN_MS, type PaceThresholds } from './pace';

const ms = (iso: string): number => Date.parse(iso);

const DAY_MS = 86400000;

/** Top-N rows shown for the per-label breakdown before the render footer kicks in.
 *  `boardStats.by_label` carries the full sorted set; renderers cap to this. */
export const LABEL_TOP_N = 8;

/** A contiguous span the task spent in one workflow status. `exit === null` is
 *  the current/terminal segment (capped at `archived_at` or now for durations). */
export interface Segment {
  status: WorkflowStatus;
  enter: number; // epoch ms
  exit: number | null; // epoch ms, null = still in this status
}

export interface TaskTiming {
  id: string;
  status: WorkflowStatus;
  priority: Priority;
  archived: boolean;
  created_at: string;
  done_at: string | null;
  first_in_progress_at: string | null;
  lead_ms: number | null; // created -> terminal Done
  cycle_ms: number | null; // first In Progress -> terminal Done
  flow_efficiency: number | null; // active_in_progress_ms / lead_ms, clamped [0,1]; null when lead null/0
  active_in_progress_ms: number; // summed across all In-Progress stints
  time_in_current_status_ms: number;
  time_per_status: Record<WorkflowStatus, number>;
  reopened: boolean;
  reopen_count: number; // number of Done stints later left
  never_in_progress: boolean;
  partial_history: boolean;
}

export interface StatsWindow {
  days: number; // clamped requested window in whole days (kept for CLI/MCP continuity)
  from: string; // ISO 8601 UTC — first bucket start
  to: string; // ISO 8601 UTC — end of the (partial) last bucket, = generated_at
  span_ms: number; // clamped span the series covers
  bucket_ms: number; // width of each bucket
  bucket: string; // human label for bucket_ms ("15m" | "1h" | "1d" | …)
  buckets: number; // series length
  clamped: boolean; // true when board age < the requested window
}

export interface BurndownPoint {
  t: string; // ISO 8601 UTC — bucket start
  remaining: number; // created & not done & not archived, as of bucket end
  done: number; // Done as of bucket end
  created_cum: number; // created on/before bucket end
}

export interface ThroughputPoint {
  t: string; // ISO 8601 UTC — bucket start
  completed: number; // terminal completions within the bucket
}

/** Age buckets for tasks currently in a column: fresh ≤1d · aging 1–7d · stale >7d.
 *  The three buckets partition the column and sum to `count` (T-5). */
export interface AgingBuckets {
  fresh: number;
  aging: number;
  stale: number;
}

export interface ColumnStat {
  status: WorkflowStatus;
  count: number;
  oldest: { id: string; age_ms: number } | null;
  aging: AgingBuckets;
}

/** A non-Done task that has sat past the stale threshold (>7d since creation). */
export interface AgingFlag {
  id: string;
  status: WorkflowStatus;
  age_ms: number;
}

export interface MetricSummary {
  p50: number;
  p90: number;
  avg: number;
  n: number;
}

/** Human-response latency on `ask`/`await` requests (T-3). */
export interface InputWaitStats {
  open: number;
  oldest_open_ms: number | null;
  resolved: MetricSummary; // wait = answered_at - created_at, over answered requests
  answered: number;
  expired: number;
  cancelled: number;
}

/** Backlog arrival vs departure (T-4). `net > 0` ⇒ the board is growing. */
export interface FlowRate {
  arrival_per_day: number; // in-window task.created / days
  departure_per_day: number; // = throughput.rolling_avg_per_day
  net_per_day: number; // arrival - departure
  trend: 'growing' | 'shrinking' | 'flat';
}

/** Rework signal (T-6): tasks bounced backward through the flow. */
export interface QualityStats {
  reopened: number; // count of Done→(left Done) transitions
  reopen_rate: number; // reopened / tasks that ever reached Done
  kickbacks: number; // count of Review→In Progress moves
  kickback_rate: number; // kickbacks / moves into Review
}

/** Per-priority cycle/lead time and current WIP (T-7). */
export interface PriorityStat {
  priority: Priority;
  n: number; // completed, non-partial
  lead: MetricSummary;
  cycle: MetricSummary;
  wip: number; // current non-archived, non-Done
}

/** Completion forecast / days-to-drain (T-8). */
export interface Forecast {
  remaining: number; // current non-archived, non-Done
  velocity_per_day: number; // = throughput.rolling_avg_per_day
  ms_to_drain: number | null; // remaining / velocity, in ms; null when velocity is 0
  days_to_drain: number | null; // ceil(ms_to_drain / day); null when velocity is 0
  eta: string | null; // ISO 8601 UTC, null when no drain date
  diverging: boolean; // net flow >= 0 ⇒ backlog not shrinking
}

/** Per-label throughput (T-9), grouped by a task's current labels. */
export interface LabelStat {
  name: string;
  n: number; // completed
  cycle: MetricSummary;
  wip: number;
}

/** Per-agent throughput (T-10), credited to the last claimer before Done. */
export interface AgentStat {
  agent_id: string;
  completed: number;
  cycle: MetricSummary;
  active_wip: number; // currently claimed & non-Done
}

/** One column-stacked bucket for the cumulative-flow diagram (T-11). */
export interface CfdPoint {
  t: string; // ISO 8601 UTC — bucket start
  counts: Record<WorkflowStatus, number>;
}

/** Closed-stint dwell time per workflow status (T-12). Open segments are
 *  excluded — they'd systematically understate, and the current oldest already
 *  shows in `wip[].oldest`. */
export interface DwellStat {
  status: WorkflowStatus;
  closed: MetricSummary;
}

/** Velocity trend (T-13): recent half of the window vs the prior half. */
export interface VelocityTrend {
  recent_per_day: number;
  prior_per_day: number;
  delta_pct: number | null; // null when the prior half is 0 or the window is too short
  direction: 'up' | 'down' | 'flat';
}

export interface BoardStats {
  generated_at: string;
  window: StatsWindow;
  compaction_floor: number;
  partial_history: boolean;
  excluded_partial: string[];
  throughput: {
    series: ThroughputPoint[];
    total: number;
    rolling_avg_per_day: number;
    per_week: number;
    trend: VelocityTrend;
  };
  wip: ColumnStat[];
  aging_flags: AgingFlag[];
  burndown: BurndownPoint[];
  timing_summary: { lead_ms: MetricSummary; cycle_ms: MetricSummary; flow_efficiency: MetricSummary };
  input_wait: InputWaitStats;
  flow: FlowRate;
  quality: QualityStats;
  by_priority: PriorityStat[];
  forecast: Forecast;
  by_label: LabelStat[];
  by_agent: AgentStat[];
  cfd: CfdPoint[];
  dwell: DwellStat[];
  bottleneck: { status: WorkflowStatus; avg_ms: number } | null;
  pace: PaceThresholds; // tempo-derived aging thresholds (never-silent basis)
}

const zeroPerStatus = (): Record<WorkflowStatus, number> => {
  const m = {} as Record<WorkflowStatus, number>;
  for (const s of WORKFLOW_STATUSES) m[s] = 0;
  return m;
};
const zeroPerStatusLists = (): Record<WorkflowStatus, number[]> => {
  const m = {} as Record<WorkflowStatus, number[]>;
  for (const s of WORKFLOW_STATUSES) m[s] = [];
  return m;
};

/**
 * Reconstruct a task's status timeline from its ordered events. `task.created`
 * carries no status, so the starting column is recovered from the first
 * `task.moved.from`; with no moves the task has lived in one column = its current
 * `status`. Each `task.moved {from,to}` closes the open segment and opens the next.
 */
export function buildSegments(task: Task, events: BoardEvent[]): Segment[] {
  const created = ms(task.created_at);
  const moves = events.filter((e) => e.type === 'task.moved');
  const startStatus = (moves.length ? (moves[0].payload.from as WorkflowStatus) : task.status) ?? task.status;
  const segments: Segment[] = [{ status: startStatus, enter: created, exit: null }];
  for (const mv of moves) {
    const at = ms(mv.ts);
    segments[segments.length - 1].exit = at;
    segments.push({ status: mv.payload.to as WorkflowStatus, enter: at, exit: null });
  }
  return segments;
}

interface Computed {
  timing: TaskTiming;
  segments: Segment[];
  createdMs: number;
  doneMs: number | null; // terminal Done enter, ms
  archivedMs: number | null;
}

function computeTask(task: Task, events: BoardEvent[], floor: number, nowMs: number): Computed {
  // Partial when history is bounded: floor advanced and we lack this task's
  // creation event (either nothing retained, or the earliest retained event for
  // it is a later `task.moved`/etc., not `task.created`).
  const partial_history = floor > 0 && (events.length === 0 || events[0].type !== 'task.created');

  const segments = buildSegments(task, events);
  const archivedMs = task.archived_at ? ms(task.archived_at) : null;
  const cap = archivedMs ?? nowMs; // close the open segment here for durations
  const last = segments[segments.length - 1];

  const firstIp = segments.find((s) => s.status === 'In Progress') ?? null;
  // Terminal Done = current status is Done (reopening leaves a non-Done last seg).
  const doneMs = last.status === 'Done' ? last.enter : null;
  const reopen_count = segments.filter((s) => s.status === 'Done' && s.exit !== null).length;

  const time_per_status = zeroPerStatus();
  for (const s of segments) time_per_status[s.status] += Math.max(0, (s.exit ?? cap) - s.enter);

  const lead_ms = doneMs !== null ? doneMs - segments[0].enter : null;
  const cycle_ms = doneMs !== null && firstIp ? doneMs - firstIp.enter : null;
  // Flow efficiency: fraction of lead time actually spent in active work. Clamped
  // to [0,1] (reopen stints stay within the lead span, but guard regardless);
  // undefined for a 0/null lead (no meaningful denominator).
  const flow_efficiency = lead_ms ? Math.min(1, time_per_status['In Progress'] / lead_ms) : null;

  const timing: TaskTiming = {
    id: task.id,
    status: task.status,
    priority: task.priority,
    archived: task.archived_at !== null,
    created_at: task.created_at,
    done_at: doneMs !== null ? new Date(doneMs).toISOString() : null,
    first_in_progress_at: firstIp ? new Date(firstIp.enter).toISOString() : null,
    lead_ms,
    cycle_ms,
    flow_efficiency,
    active_in_progress_ms: time_per_status['In Progress'],
    time_in_current_status_ms: Math.max(0, cap - last.enter),
    time_per_status,
    reopened: reopen_count > 0,
    reopen_count,
    never_in_progress: firstIp === null,
    partial_history,
  };
  return { timing, segments, createdMs: segments[0].enter, doneMs, archivedMs };
}

/** Per-task timing for one task (throws NotFoundError via requireTask). */
export function taskTiming(repo: Repo, id: string): TaskTiming {
  const task = repo.requireTask(id);
  const events = repo.changes(0).filter((e) => e.task_id === id);
  return computeTask(task, events, repo.floor(), Date.now()).timing;
}

// ---- adaptive time bucketing ---------------------------------------------
// Bucket width scales with the board's age (docs/13-analytics §3), so an
// agent-driven board that is only hours old still renders a useful multi-point
// series instead of one daily dot. The final bucket is partial: it ends at
// `nowMs` (= generated_at), so the freshest data is always shown.

interface Bucket {
  t: string; // ISO 8601 UTC — bucket start
  start: number; // epoch ms, inclusive
  end: number; // epoch ms, exclusive (nowMs+1 for the open final bucket)
}

/** Clamp the requested window to whole days in [1, 365] (default 14). */
function windowDays(opts: { windowDays?: number }): number {
  const d = Math.floor(opts.windowDays ?? 14);
  return Math.min(365, Math.max(1, Number.isFinite(d) ? d : 14));
}

/** Epoch-aligned buckets over `[nowMs - spanMs, nowMs]`; the last bucket runs to
 *  `nowMs`. Bucket width is chosen (`bucketRange`) to keep the series readable. */
function computeBuckets(nowMs: number, spanMs: number): { buckets: Bucket[]; step: number } {
  const { starts, step } = bucketRange(nowMs, spanMs);
  const buckets: Bucket[] = starts.map((start, i) => ({
    t: new Date(start).toISOString(),
    start,
    end: i + 1 < starts.length ? starts[i + 1] : nowMs + 1,
  }));
  return { buckets, step };
}

/** Status the task was in at `endMs` (or null if not yet created by then). */
function statusAsOf(segments: Segment[], endMs: number): WorkflowStatus | null {
  let found: WorkflowStatus | null = null;
  for (const s of segments) {
    if (s.enter <= endMs && (s.exit === null || s.exit > endMs)) return s.status;
    if (s.enter <= endMs) found = s.status; // last started-before segment (fallback)
  }
  return found;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Summarize a numeric series. `round` shapes the average (and is also applied to
 *  the percentiles) — default integer for ms durations, `round2` for [0,1] ratios. */
function summarize(values: number[], round: (n: number) => number = Math.round): MetricSummary {
  if (!values.length) return { p50: 0, p90: 0, avg: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = round(values.reduce((a, b) => a + b, 0) / values.length);
  return { p50: round(percentile(sorted, 0.5)), p90: round(percentile(sorted, 0.9)), avg, n: values.length };
}

/**
 * Velocity trend (T-13): compare the recent half of the bucket series against the
 * prior half (dropping the middle bucket when odd). Simpler to explain than a
 * regression slope and robust on small n. Rates are normalized to per-day so the
 * headline numbers stay comparable regardless of bucket width. Direction needs a
 * >10% move to leave `flat`; series under 4 buckets are always `flat` (halves too
 * small to compare). The partial final bucket biases the recent half slightly low
 * — accepted (dropping it would ignore the newest work).
 */
export function computeTrend(series: ThroughputPoint[], bucketMs: number): VelocityTrend {
  const n = series.length;
  const half = Math.floor(n / 2);
  const perDay = bucketMs > 0 ? DAY_MS / bucketMs : 1;
  const rate = (pts: ThroughputPoint[]): number =>
    pts.length ? round2((pts.reduce((a, p) => a + p.completed, 0) / pts.length) * perDay) : 0;
  const prior = rate(series.slice(0, half));
  const recent = rate(series.slice(n - half));
  if (n < 4 || (prior === 0 && recent === 0))
    return { recent_per_day: recent, prior_per_day: prior, delta_pct: null, direction: 'flat' };
  if (prior === 0) return { recent_per_day: recent, prior_per_day: prior, delta_pct: null, direction: 'up' };
  const delta_pct = Math.round(((recent - prior) / prior) * 100);
  const direction = recent > prior * 1.1 ? 'up' : recent < prior * 0.9 ? 'down' : 'flat';
  return { recent_per_day: recent, prior_per_day: prior, delta_pct, direction };
}

/** Statuses eligible for the bottleneck flag: Backlog is long-lived by design
 *  and Done is terminal, so only the active flow competes. */
const BOTTLENECK_STATUSES: WorkflowStatus[] = ['Ready', 'In Progress', 'Review'];

/**
 * Board-level analytics over a window: throughput/velocity, WIP & aging,
 * burndown series, and lead/cycle-time summaries. One pass over the event log.
 */
export function boardStats(repo: Repo, opts: { windowDays?: number } = {}): BoardStats {
  const nowMs = Date.now();
  const floor = repo.floor();

  const tasks = repo.allTasks();

  // Clamp the span to the board's actual age — never render buckets before the
  // board had any tasks (they'd be all-zero and misleading, T-1). Anchored on the
  // earliest task `created_at` (a never-compacted task-row field; the DB stores no
  // separate board-creation timestamp). The bucket *width* then scales with the
  // clamped span (pace.ts) so a young board still gets a multi-point series; the
  // requested window is honoured only as an upper bound on the span.
  const requested = windowDays(opts);
  const earliestMs = tasks.reduce((m, t) => Math.min(m, ms(t.created_at)), nowMs);
  const ageMs = nowMs - earliestMs;
  const spanMs = Math.max(MIN_SPAN_MS, Math.min(requested * DAY_MS, ageMs));
  const clamped = ageMs < requested * DAY_MS;
  const { buckets, step: bucket_ms } = computeBuckets(nowMs, spanMs);
  const days = Math.max(1, Math.ceil(spanMs / DAY_MS));
  const spanDays = spanMs / DAY_MS; // fractional — the true denominator for rates

  const byTask = new Map<string, BoardEvent[]>();
  for (const e of repo.changes(0)) {
    if (!e.task_id) continue;
    const list = byTask.get(e.task_id);
    if (list) list.push(e);
    else byTask.set(e.task_id, [e]);
  }
  const computed = tasks.map((t) => computeTask(t, byTask.get(t.id) ?? [], floor, nowMs));

  // Timing summary over non-partial, currently-completed tasks. Collected before
  // aging so the pace thresholds (derived from cycle p90) can drive it.
  const lead: number[] = [];
  const cycle: number[] = [];
  const flowEff: number[] = [];
  for (const c of computed) {
    if (c.timing.partial_history) continue;
    if (c.timing.lead_ms !== null) lead.push(c.timing.lead_ms);
    if (c.timing.cycle_ms !== null) cycle.push(c.timing.cycle_ms);
    if (c.timing.flow_efficiency !== null) flowEff.push(c.timing.flow_efficiency);
  }
  const cycleSummary = summarize(cycle);
  // Pace-aware aging thresholds — derived from the board's own completion tempo,
  // shared with doctor/standup via boardPace(). Never-silent: `pace.basis` says
  // whether these came from tempo or the fixed fallback.
  const pace = paceThresholds(cycleSummary.p90, cycleSummary.n);

  // WIP & aging — current (live rows), excludes archived. Each column's tasks are
  // partitioned into fresh ≤ pace.fresh_ms · aging · stale > pace.stale_ms
  // (sums to count, T-5).
  const ageOf = (t: Task) => nowMs - ms(t.created_at);
  const wip: ColumnStat[] = WORKFLOW_STATUSES.map((status) => {
    const inCol = tasks.filter((t) => t.status === status && t.archived_at === null);
    let oldest: ColumnStat['oldest'] = null;
    const aging: AgingBuckets = { fresh: 0, aging: 0, stale: 0 };
    for (const t of inCol) {
      const age = ageOf(t);
      if (!oldest || age > oldest.age_ms) oldest = { id: t.id, age_ms: age };
      if (age <= pace.fresh_ms) aging.fresh++;
      else if (age <= pace.stale_ms) aging.aging++;
      else aging.stale++;
    }
    return { status, count: inCol.length, oldest, aging };
  });

  // Aging flags — non-Done, non-archived tasks past the (pace-aware) stale
  // threshold (T-5).
  const aging_flags: AgingFlag[] = tasks
    .filter((t) => t.archived_at === null && t.status !== 'Done' && ageOf(t) > pace.stale_ms)
    .map((t) => ({ id: t.id, status: t.status, age_ms: ageOf(t) }))
    .sort((a, b) => b.age_ms - a.age_ms);

  const burndown: BurndownPoint[] = buckets.map((b) => {
    const asOf = Math.min(b.end - 1, nowMs);
    let created_cum = 0;
    let done = 0;
    let remaining = 0;
    for (const c of computed) {
      if (c.createdMs > asOf) continue;
      created_cum++;
      const archivedByThen = c.archivedMs !== null && c.archivedMs <= asOf;
      const status = statusAsOf(c.segments, asOf);
      const isDone = status === 'Done';
      if (isDone) done++;
      if (!isDone && !archivedByThen) remaining++;
    }
    return { t: b.t, remaining, done, created_cum };
  });

  // Throughput — terminal completions bucketed by the adaptive bucket; the series
  // covers only the windowed span. Rates normalize by the *fractional* span so a
  // 6h-old board reads its true per-day velocity, not a day-floored understatement.
  const series: ThroughputPoint[] = buckets.map((b) => {
    let completed = 0;
    for (const c of computed) if (c.doneMs !== null && c.doneMs >= b.start && c.doneMs < b.end) completed++;
    return { t: b.t, completed };
  });
  const total = series.reduce((a, p) => a + p.completed, 0);
  const rolling_avg_per_day = round2(total / spanDays);

  const excluded_partial = computed.filter((c) => c.timing.partial_history).map((c) => c.timing.id);

  // ---- input-wait latency (T-3) — human response time on ask/await ----------
  const requests = repo.getAllRequests();
  const waits: number[] = [];
  const iw: InputWaitStats = {
    open: 0,
    oldest_open_ms: null,
    resolved: summarize([]),
    answered: 0,
    expired: 0,
    cancelled: 0,
  };
  for (const r of requests) {
    if (r.status === 'open') {
      iw.open++;
      const age = nowMs - ms(r.created_at);
      iw.oldest_open_ms = Math.max(iw.oldest_open_ms ?? 0, age);
    } else if (r.status === 'answered') {
      iw.answered++;
      if (r.answered_at) waits.push(ms(r.answered_at) - ms(r.created_at));
    } else if (r.status === 'expired') iw.expired++;
    else if (r.status === 'cancelled') iw.cancelled++;
  }
  iw.resolved = summarize(waits);

  // ---- net flow rate (T-4) — arrival vs departure ---------------------------
  const windowStart = buckets[0].start;
  const arrived = tasks.filter((t) => ms(t.created_at) >= windowStart).length;
  const arrival_per_day = round2(arrived / spanDays);
  const net_per_day = round2(arrival_per_day - rolling_avg_per_day);
  const flow: FlowRate = {
    arrival_per_day,
    departure_per_day: rolling_avg_per_day,
    net_per_day,
    trend: net_per_day > 0 ? 'growing' : net_per_day < 0 ? 'shrinking' : 'flat',
  };

  // ---- rework / kickback rate (T-6) -----------------------------------------
  // Reopen = Done→(left Done), already counted per task. Kickback = a backward
  // Review→In Progress move; rate is over moves that ever entered Review.
  const everDone = computed.filter((c) => c.doneMs !== null || c.timing.reopen_count > 0).length;
  const reopened = computed.reduce((a, c) => a + c.timing.reopen_count, 0);
  let kickbacks = 0;
  let reviewEntries = 0;
  for (const events of byTask.values())
    for (const e of events) {
      if (e.type !== 'task.moved') continue;
      if (e.payload.to === 'Review') reviewEntries++;
      if (e.payload.from === 'Review' && e.payload.to === 'In Progress') kickbacks++;
    }
  const quality: QualityStats = {
    reopened,
    reopen_rate: everDone ? round2(reopened / everDone) : 0,
    kickbacks,
    kickback_rate: reviewEntries ? round2(kickbacks / reviewEntries) : 0,
  };

  // ---- per-priority cycle/lead time (T-7) -----------------------------------
  const by_priority: PriorityStat[] = PRIORITIES.map((priority) => {
    const inPrio = computed.filter((c) => c.timing.priority === priority);
    const done = inPrio.filter((c) => c.doneMs !== null && !c.timing.partial_history);
    return {
      priority,
      n: done.length,
      lead: summarize(done.map((c) => c.timing.lead_ms!).filter((v) => v !== null)),
      cycle: summarize(done.map((c) => c.timing.cycle_ms).filter((v): v is number => v !== null)),
      wip: tasks.filter((t) => t.priority === priority && t.archived_at === null && t.status !== 'Done').length,
    };
  });

  // ---- completion forecast (T-8) --------------------------------------------
  // Drain time in ms so a fast board gets an hour-precision ETA, not a day-floored
  // one. `days_to_drain` is kept (ceil of the ms figure) for continuity.
  const remaining = tasks.filter((t) => t.archived_at === null && t.status !== 'Done').length;
  const ms_to_drain = rolling_avg_per_day > 0 ? Math.round((remaining / rolling_avg_per_day) * DAY_MS) : null;
  const forecast: Forecast = {
    remaining,
    velocity_per_day: rolling_avg_per_day,
    ms_to_drain,
    days_to_drain: ms_to_drain !== null ? Math.ceil(ms_to_drain / DAY_MS) : null,
    eta: ms_to_drain !== null ? new Date(nowMs + ms_to_drain).toISOString() : null,
    diverging: net_per_day >= 0,
  };

  // ---- per-label throughput (T-9) — grouped by current labels ---------------
  const labelAgg = new Map<string, { cycles: number[]; n: number; wip: number }>();
  const labelBucket = (name: string) => {
    let b = labelAgg.get(name);
    if (!b) labelAgg.set(name, (b = { cycles: [], n: 0, wip: 0 }));
    return b;
  };
  for (const c of computed) {
    const labels = repo.getLabels(c.timing.id);
    const completed = c.doneMs !== null && !c.timing.partial_history;
    const isWip = c.timing.status !== 'Done' && !c.timing.archived;
    for (const name of labels) {
      const b = labelBucket(name);
      if (completed) {
        b.n++;
        if (c.timing.cycle_ms !== null) b.cycles.push(c.timing.cycle_ms);
      }
      if (isWip) b.wip++;
    }
  }
  const by_label: LabelStat[] = [...labelAgg.entries()]
    .map(([name, b]) => ({ name, n: b.n, cycle: summarize(b.cycles), wip: b.wip }))
    .sort((a, b) => b.n - a.n || b.wip - a.wip || a.name.localeCompare(b.name));

  // ---- per-agent throughput (T-10) — credited to last claimer before Done ---
  const agentAgg = new Map<string, { cycles: number[]; completed: number; active_wip: number }>();
  const agentBucket = (id: string) => {
    let b = agentAgg.get(id);
    if (!b) agentAgg.set(id, (b = { cycles: [], completed: 0, active_wip: 0 }));
    return b;
  };
  let anyClaims = false;
  for (const c of computed) {
    if (c.doneMs === null) continue;
    const claims = (byTask.get(c.timing.id) ?? []).filter(
      (e) => e.type === 'task.claimed' && ms(e.ts) <= c.doneMs!,
    );
    if (!claims.length) continue;
    anyClaims = true;
    const agent = String(claims[claims.length - 1].payload.assignee);
    const b = agentBucket(agent);
    b.completed++;
    if (c.timing.cycle_ms !== null) b.cycles.push(c.timing.cycle_ms);
  }
  for (const t of tasks) {
    if (t.assignee && t.archived_at === null && t.status !== 'Done') {
      agentBucket(t.assignee).active_wip++;
      anyClaims = anyClaims || byTask.get(t.id)?.some((e) => e.type === 'task.claimed') || false;
    }
  }
  const by_agent: AgentStat[] = anyClaims
    ? [...agentAgg.entries()]
        .map(([agent_id, b]) => ({
          agent_id,
          completed: b.completed,
          cycle: summarize(b.cycles),
          active_wip: b.active_wip,
        }))
        .sort((a, b) => b.completed - a.completed || b.active_wip - a.active_wip)
    : [];

  // ---- per-status dwell / bottleneck (T-12) ---------------------------------
  // Closed stints only, from non-partial-history tasks; all retained history
  // (matches timing_summary semantics — the window governs series, not lifetimes).
  const dwellDurations = zeroPerStatusLists();
  for (const c of computed) {
    if (c.timing.partial_history) continue;
    for (const s of c.segments) if (s.exit !== null) dwellDurations[s.status].push(s.exit - s.enter);
  }
  const dwell: DwellStat[] = WORKFLOW_STATUSES.map((status) => ({
    status,
    closed: summarize(dwellDurations[status]),
  }));
  let bottleneck: BoardStats['bottleneck'] = null;
  for (const d of dwell) {
    if (!BOTTLENECK_STATUSES.includes(d.status) || d.closed.n === 0) continue;
    if (!bottleneck || d.closed.avg > bottleneck.avg_ms) bottleneck = { status: d.status, avg_ms: d.closed.avg };
  }

  // ---- cumulative-flow diagram (T-11) — one stacked column per window bucket --
  const cfd: CfdPoint[] = buckets.map((b) => {
    const asOf = Math.min(b.end - 1, nowMs);
    const counts = zeroPerStatus();
    for (const c of computed) {
      if (c.createdMs > asOf) continue;
      if (c.archivedMs !== null && c.archivedMs <= asOf) continue;
      const status = statusAsOf(c.segments, asOf) ?? c.timing.status;
      counts[status]++;
    }
    return { t: b.t, counts };
  });

  return {
    generated_at: new Date(nowMs).toISOString(),
    window: {
      days,
      from: buckets[0].t,
      to: new Date(nowMs).toISOString(),
      span_ms: spanMs,
      bucket_ms,
      bucket: bucketLabel(bucket_ms),
      buckets: buckets.length,
      clamped,
    },
    compaction_floor: floor,
    partial_history: excluded_partial.length > 0,
    excluded_partial,
    throughput: {
      series,
      total,
      rolling_avg_per_day,
      per_week: round2(rolling_avg_per_day * 7),
      trend: computeTrend(series, bucket_ms),
    },
    wip,
    aging_flags,
    burndown,
    timing_summary: { lead_ms: summarize(lead), cycle_ms: cycleSummary, flow_efficiency: summarize(flowEff, round2) },
    input_wait: iw,
    flow,
    quality,
    by_priority,
    forecast,
    by_label,
    by_agent,
    cfd,
    dwell,
    bottleneck,
    pace,
  };
}

/**
 * The board's pace-aware aging thresholds (fresh/stale), derived from its own
 * completion tempo (p90 cycle time over non-partial, currently-completed tasks).
 * The single source of truth shared by `boardStats`, `doctor`, and `standup` so
 * the three never drift. Falls back to fixed legacy thresholds below the
 * completion floor (see `paceThresholds`).
 */
export function boardPace(repo: Repo, nowMs: number = Date.now()): PaceThresholds {
  const floor = repo.floor();
  const byTask = new Map<string, BoardEvent[]>();
  for (const e of repo.changes(0)) {
    if (!e.task_id) continue;
    const list = byTask.get(e.task_id);
    if (list) list.push(e);
    else byTask.set(e.task_id, [e]);
  }
  const cycle: number[] = [];
  for (const t of repo.allTasks()) {
    const c = computeTask(t, byTask.get(t.id) ?? [], floor, nowMs);
    if (!c.timing.partial_history && c.timing.cycle_ms !== null) cycle.push(c.timing.cycle_ms);
  }
  const summary = summarize(cycle);
  return paceThresholds(summary.p90, summary.n);
}

// Exported only so tests can assert bucketing/timeline logic without re-deriving it.
export const _internal = { computeBuckets, bucketRange, statusAsOf };
