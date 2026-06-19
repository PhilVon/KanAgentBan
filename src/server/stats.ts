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

const ms = (iso: string): number => Date.parse(iso);

const DAY_MS = 86400000;
const STALE_MS = 7 * DAY_MS; // aging boundary: tasks older than this are "stale"

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
  days: number;
  from: string; // YYYY-MM-DD (UTC)
  to: string; // YYYY-MM-DD (UTC)
}

export interface BurndownPoint {
  date: string; // YYYY-MM-DD (UTC)
  remaining: number; // created & not done & not archived, as of end-of-day
  done: number; // Done as of end-of-day
  created_cum: number; // created on/before end-of-day
}

export interface ThroughputPoint {
  date: string;
  completed: number;
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
  days_to_drain: number | null; // null when velocity is 0
  eta: string | null; // YYYY-MM-DD, null when no drain date
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

/** One column-stacked day for the cumulative-flow diagram (T-11). */
export interface CfdPoint {
  date: string; // YYYY-MM-DD (UTC)
  counts: Record<WorkflowStatus, number>;
}

export interface BoardStats {
  generated_at: string;
  window: StatsWindow;
  compaction_floor: number;
  partial_history: boolean;
  excluded_partial: string[];
  throughput: { series: ThroughputPoint[]; total: number; rolling_avg_per_day: number; per_week: number };
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
}

const zeroPerStatus = (): Record<WorkflowStatus, number> => {
  const m = {} as Record<WorkflowStatus, number>;
  for (const s of WORKFLOW_STATUSES) m[s] = 0;
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

// ---- date bucketing (UTC calendar days) ----------------------------------

const dayKey = (epoch: number): string => new Date(epoch).toISOString().slice(0, 10);
const endOfDay = (key: string): number => Date.parse(`${key}T23:59:59.999Z`);
const startOfDay = (key: string): number => Date.parse(`${key}T00:00:00.000Z`);

function windowDays(opts: { windowDays?: number }): number {
  const d = Math.floor(opts.windowDays ?? 14);
  return Math.min(365, Math.max(1, Number.isFinite(d) ? d : 14));
}

function dayRange(nowMs: number, days: number): string[] {
  const today = dayKey(nowMs);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(Date.parse(`${today}T00:00:00.000Z`) - i * 86400000));
  return out;
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
 * Board-level analytics over a window: throughput/velocity, WIP & aging,
 * burndown series, and lead/cycle-time summaries. One pass over the event log.
 */
export function boardStats(repo: Repo, opts: { windowDays?: number } = {}): BoardStats {
  const nowMs = Date.now();
  const floor = repo.floor();

  const tasks = repo.allTasks();

  // Clamp the window to the project's actual age — never render days before the
  // board had any tasks. Those buckets are all-zero and make a young board's
  // graph useless/redundant (T-1). Anchored on the earliest task `created_at`
  // (a never-compacted task-row field; there's no meaningful burndown before the
  // first task, and the DB stores no separate board-creation timestamp).
  const requested = windowDays(opts);
  const earliestMs = tasks.reduce((m, t) => Math.min(m, ms(t.created_at)), nowMs);
  const ageDays =
    Math.floor((startOfDay(dayKey(nowMs)) - startOfDay(dayKey(earliestMs))) / 86400000) + 1;
  const days = Math.max(1, Math.min(requested, ageDays));

  const byTask = new Map<string, BoardEvent[]>();
  for (const e of repo.changes(0)) {
    if (!e.task_id) continue;
    const list = byTask.get(e.task_id);
    if (list) list.push(e);
    else byTask.set(e.task_id, [e]);
  }
  const computed = tasks.map((t) => computeTask(t, byTask.get(t.id) ?? [], floor, nowMs));

  // WIP & aging — current (live rows), excludes archived. Each column's tasks are
  // partitioned into fresh ≤1d · aging 1–7d · stale >7d (sums to count, T-5).
  const ageOf = (t: Task) => nowMs - ms(t.created_at);
  const wip: ColumnStat[] = WORKFLOW_STATUSES.map((status) => {
    const inCol = tasks.filter((t) => t.status === status && t.archived_at === null);
    let oldest: ColumnStat['oldest'] = null;
    const aging: AgingBuckets = { fresh: 0, aging: 0, stale: 0 };
    for (const t of inCol) {
      const age = ageOf(t);
      if (!oldest || age > oldest.age_ms) oldest = { id: t.id, age_ms: age };
      if (age <= DAY_MS) aging.fresh++;
      else if (age <= STALE_MS) aging.aging++;
      else aging.stale++;
    }
    return { status, count: inCol.length, oldest, aging };
  });

  // Aging flags — non-Done, non-archived tasks past the stale threshold (T-5).
  const aging_flags: AgingFlag[] = tasks
    .filter((t) => t.archived_at === null && t.status !== 'Done' && ageOf(t) > STALE_MS)
    .map((t) => ({ id: t.id, status: t.status, age_ms: ageOf(t) }))
    .sort((a, b) => b.age_ms - a.age_ms);

  // Timing summary over non-partial, currently-completed tasks.
  const lead: number[] = [];
  const cycle: number[] = [];
  const flowEff: number[] = [];
  for (const c of computed) {
    if (c.timing.partial_history) continue;
    if (c.timing.lead_ms !== null) lead.push(c.timing.lead_ms);
    if (c.timing.cycle_ms !== null) cycle.push(c.timing.cycle_ms);
    if (c.timing.flow_efficiency !== null) flowEff.push(c.timing.flow_efficiency);
  }

  const dates = dayRange(nowMs, days);
  const burndown: BurndownPoint[] = dates.map((date) => {
    const end = endOfDay(date);
    let created_cum = 0;
    let done = 0;
    let remaining = 0;
    for (const c of computed) {
      if (c.createdMs > end) continue;
      created_cum++;
      const archivedByThen = c.archivedMs !== null && c.archivedMs <= end;
      const status = statusAsOf(c.segments, end);
      const isDone = status === 'Done';
      if (isDone) done++;
      if (!isDone && !archivedByThen) remaining++;
    }
    return { date, remaining, done, created_cum };
  });

  // Throughput — terminal completions bucketed by day; windowed series.
  const completedByDay = new Map<string, number>();
  for (const c of computed) {
    if (c.doneMs === null) continue;
    completedByDay.set(dayKey(c.doneMs), (completedByDay.get(dayKey(c.doneMs)) ?? 0) + 1);
  }
  const series: ThroughputPoint[] = dates.map((date) => ({ date, completed: completedByDay.get(date) ?? 0 }));
  const total = series.reduce((a, p) => a + p.completed, 0);
  const rolling_avg_per_day = Math.round((total / days) * 100) / 100;

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
  const windowStart = startOfDay(dates[0]);
  const arrived = tasks.filter((t) => ms(t.created_at) >= windowStart).length;
  const arrival_per_day = round2(arrived / days);
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
  const remaining = tasks.filter((t) => t.archived_at === null && t.status !== 'Done').length;
  const days_to_drain = rolling_avg_per_day > 0 ? Math.ceil(remaining / rolling_avg_per_day) : null;
  const forecast: Forecast = {
    remaining,
    velocity_per_day: rolling_avg_per_day,
    days_to_drain,
    eta: days_to_drain !== null ? dayKey(nowMs + days_to_drain * DAY_MS) : null,
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

  // ---- cumulative-flow diagram (T-11) — one stacked column per window day ----
  const cfd: CfdPoint[] = dates.map((date) => {
    const end = endOfDay(date);
    const counts = zeroPerStatus();
    for (const c of computed) {
      if (c.createdMs > end) continue;
      if (c.archivedMs !== null && c.archivedMs <= end) continue;
      const status = statusAsOf(c.segments, end) ?? c.timing.status;
      counts[status]++;
    }
    return { date, counts };
  });

  return {
    generated_at: new Date(nowMs).toISOString(),
    window: { days, from: dates[0], to: dates[dates.length - 1] },
    compaction_floor: floor,
    partial_history: excluded_partial.length > 0,
    excluded_partial,
    throughput: { series, total, rolling_avg_per_day, per_week: Math.round(rolling_avg_per_day * 7 * 100) / 100 },
    wip,
    aging_flags,
    burndown,
    timing_summary: { lead_ms: summarize(lead), cycle_ms: summarize(cycle), flow_efficiency: summarize(flowEff, round2) },
    input_wait: iw,
    flow,
    quality,
    by_priority,
    forecast,
    by_label,
    by_agent,
    cfd,
  };
}

// startOfDay is exported only so tests can assert bucketing without re-deriving it.
export const _internal = { dayKey, endOfDay, startOfDay, statusAsOf };
