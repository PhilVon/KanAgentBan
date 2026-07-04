import type { Repo } from './repo';
import type { BoardEvent, Task } from '../shared/types';

const DAY_MS = 86_400_000;
/** Attention threshold — matches stats' aging boundary and doctor's aging-wip. */
const AGING_MS = 7 * DAY_MS;

export interface StandupReport {
  /** Cursor the digest starts from (post-clamp) and the cursor to save next. */
  since: number;
  cursor: number;
  /** True when the requested cursor predated the compaction floor (clamped). */
  floor_clamped: boolean;
  floor: number;
  window_days: number | null;
  completed: { id: string; title: string; via_review: boolean }[];
  /** Net movement per task within the window (excluding arrivals in Done). */
  moved: { id: string; title: string; from: string; to: string }[];
  created: { id: string; title: string; status: string }[];
  asked: { id: string; task_id: string; question: string }[];
  answered: { id: string; task_id: string; answer: string; defaulted: boolean }[];
  /** Cancelled/expired — resolutions a resuming agent must still see. */
  resolved: { id: string; task_id: string; status: string }[];
  rejected: { id: string; title: string; reason: string }[];
  /** Tasks in active columns currently untouched > 7d (attention list). */
  aging: { id: string; title: string; status: string; age_days: number }[];
}

/**
 * The narrative board diff: everything that happened since a cursor (or in the
 * last N days), in one call — completed, net moves, new tasks, question
 * traffic, review kickbacks, plus the current aging list. Read-only, derived
 * from the retained event log (a cursor below the compaction floor clamps and
 * says so — never silent).
 */
export function standup(
  repo: Repo,
  opts: { since?: number; days?: number } = {},
): StandupReport {
  const cursor = repo.maxSeq();
  const floor = repo.floor();
  const window_days = opts.since !== undefined ? null : (opts.days ?? 1);

  // Resolve the starting cursor: explicit seq wins; otherwise walk back N days
  // by event timestamp. Then clamp to the compaction floor.
  let since: number;
  if (opts.since !== undefined) {
    since = opts.since;
  } else {
    const cutoff = new Date(Date.now() - (window_days as number) * DAY_MS).toISOString();
    const row = repo.db
      .prepare('SELECT COALESCE(MIN(seq), 0) s FROM event WHERE ts >= ?')
      .get(cutoff) as { s: number };
    // No events in the window -> start at the cursor (empty digest).
    since = row.s > 0 ? row.s - 1 : cursor;
  }
  const floor_clamped = since < floor;
  if (floor_clamped) since = floor;

  const events = repo.changes(since);
  const title = (id: string): string => repo.getTask(id)?.title ?? '(archived)';

  const completed: StandupReport['completed'] = [];
  const rejected: StandupReport['rejected'] = [];
  const firstFrom = new Map<string, string>();
  const lastTo = new Map<string, string>();
  const created: StandupReport['created'] = [];
  const asked: StandupReport['asked'] = [];
  const answered: StandupReport['answered'] = [];
  const resolved: StandupReport['resolved'] = [];

  for (const e of events) {
    const p = e.payload as any;
    switch (e.type) {
      case 'task.created':
        if (e.task_id) created.push({ id: e.task_id, title: p.title ?? title(e.task_id), status: repo.getTask(e.task_id)?.status ?? '?' });
        break;
      case 'task.moved':
        if (!e.task_id) break;
        if (p.to === 'Done') {
          completed.push({ id: e.task_id, title: title(e.task_id), via_review: p.review === 'approved' });
        } else {
          if (!firstFrom.has(e.task_id)) firstFrom.set(e.task_id, p.from);
          lastTo.set(e.task_id, p.to);
        }
        if (p.review === 'rejected')
          rejected.push({ id: e.task_id, title: title(e.task_id), reason: p.reason ?? '' });
        break;
      case 'input.requested':
        if (e.task_id) asked.push({ id: p.request_id, task_id: e.task_id, question: p.question });
        break;
      case 'input.answered':
        if (e.task_id) answered.push({ id: p.request_id, task_id: e.task_id, answer: p.answer, defaulted: !!p.defaulted });
        break;
      case 'input.cancelled':
      case 'input.expired':
        if (e.task_id) resolved.push({ id: p.request_id, task_id: e.task_id, status: e.type.slice('input.'.length) });
        break;
    }
  }

  // Net movement: first `from` -> last `to` per task; drop no-ops and tasks
  // that ended in Done (already in `completed`).
  const doneIds = new Set(completed.map((c) => c.id));
  const moved: StandupReport['moved'] = [];
  for (const [id, to] of lastTo) {
    if (doneIds.has(id)) continue;
    const from = firstFrom.get(id) ?? '?';
    if (from === to) continue;
    moved.push({ id, title: title(id), from, to });
  }

  // Current attention list — active-column tasks untouched past the boundary.
  const nowMs = Date.now();
  const aging: StandupReport['aging'] = repo
    .listTasks({})
    .filter((t: Task) => ['Ready', 'In Progress', 'Review'].includes(t.status))
    .map((t: Task) => ({ t, age: nowMs - new Date(t.updated_at).getTime() }))
    .filter((x) => x.age > AGING_MS)
    .map((x) => ({ id: x.t.id, title: x.t.title, status: x.t.status, age_days: Math.floor(x.age / DAY_MS) }));

  return {
    since,
    cursor,
    floor_clamped,
    floor,
    window_days,
    completed,
    moved,
    created,
    asked,
    answered,
    resolved,
    rejected,
    aging,
  };
}
