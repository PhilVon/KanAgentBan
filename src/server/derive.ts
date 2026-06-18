import type { DB } from './db';
import type { DerivedState, Task } from '../shared/types';

/** A task is blocked by deps if any `blocks` prerequisite is not Done/archived. */
export function blockedByDeps(db: DB, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1
         FROM dependency d
         JOIN task t ON t.id = d.to_task
        WHERE d.from_task = ?
          AND d.type = 'blocks'
          AND t.status != 'Done'
          AND t.archived_at IS NULL
        LIMIT 1`,
    )
    .get(taskId);
  return !!row;
}

/** A task needs input if it has any open input_request. */
export function needsInput(db: DB, taskId: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM input_request WHERE task_id = ? AND status = 'open' LIMIT 1`)
    .get(taskId);
  return !!row;
}

export function deriveState(db: DB, task: Task): DerivedState {
  const blocked_by_deps = blockedByDeps(db, task.id);
  const needs_input = needsInput(db, task.id);
  const ready =
    !blocked_by_deps &&
    !needs_input &&
    task.archived_at === null &&
    (task.status === 'Ready' || task.status === 'In Progress');
  return { blocked_by_deps, needs_input, ready };
}

/** Count of blocking prerequisites still open (used for ranking + context). */
export function remainingBlockerCount(db: DB, taskId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM dependency d
         JOIN task t ON t.id = d.to_task
        WHERE d.from_task = ?
          AND d.type = 'blocks'
          AND t.status != 'Done'
          AND t.archived_at IS NULL`,
    )
    .get(taskId) as { n: number };
  return row.n;
}
