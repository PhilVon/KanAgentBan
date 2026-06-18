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
import type { BoardEvent, Task, WorkflowStatus } from '../shared/types';
import { WORKFLOW_STATUSES } from '../shared/types';

const ms = (iso: string): number => Date.parse(iso);

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
  archived: boolean;
  created_at: string;
  done_at: string | null;
  first_in_progress_at: string | null;
  lead_ms: number | null; // created -> terminal Done
  cycle_ms: number | null; // first In Progress -> terminal Done
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

export interface ColumnStat {
  status: WorkflowStatus;
  count: number;
  oldest: { id: string; age_ms: number } | null;
}

export interface MetricSummary {
  p50: number;
  p90: number;
  avg: number;
  n: number;
}

export interface BoardStats {
  generated_at: string;
  window: StatsWindow;
  compaction_floor: number;
  partial_history: boolean;
  excluded_partial: string[];
  throughput: { series: ThroughputPoint[]; total: number; rolling_avg_per_day: number; per_week: number };
  wip: ColumnStat[];
  burndown: BurndownPoint[];
  timing_summary: { lead_ms: MetricSummary; cycle_ms: MetricSummary };
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

  const timing: TaskTiming = {
    id: task.id,
    status: task.status,
    archived: task.archived_at !== null,
    created_at: task.created_at,
    done_at: doneMs !== null ? new Date(doneMs).toISOString() : null,
    first_in_progress_at: firstIp ? new Date(firstIp.enter).toISOString() : null,
    lead_ms,
    cycle_ms,
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

function summarize(values: number[]): MetricSummary {
  if (!values.length) return { p50: 0, p90: 0, avg: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  return { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), avg, n: values.length };
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

  // WIP & aging — current (live rows), excludes archived.
  const wip: ColumnStat[] = WORKFLOW_STATUSES.map((status) => {
    const inCol = tasks.filter((t) => t.status === status && t.archived_at === null);
    let oldest: ColumnStat['oldest'] = null;
    for (const t of inCol) {
      const age = nowMs - ms(t.created_at);
      if (!oldest || age > oldest.age_ms) oldest = { id: t.id, age_ms: age };
    }
    return { status, count: inCol.length, oldest };
  });

  // Timing summary over non-partial, currently-completed tasks.
  const lead: number[] = [];
  const cycle: number[] = [];
  for (const c of computed) {
    if (c.timing.partial_history) continue;
    if (c.timing.lead_ms !== null) lead.push(c.timing.lead_ms);
    if (c.timing.cycle_ms !== null) cycle.push(c.timing.cycle_ms);
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

  return {
    generated_at: new Date(nowMs).toISOString(),
    window: { days, from: dates[0], to: dates[dates.length - 1] },
    compaction_floor: floor,
    partial_history: excluded_partial.length > 0,
    excluded_partial,
    throughput: { series, total, rolling_avg_per_day, per_week: Math.round(rolling_avg_per_day * 7 * 100) / 100 },
    wip,
    burndown,
    timing_summary: { lead_ms: summarize(lead), cycle_ms: summarize(cycle) },
  };
}

// startOfDay is exported only so tests can assert bucketing without re-deriving it.
export const _internal = { dayKey, endOfDay, startOfDay, statusAsOf };
