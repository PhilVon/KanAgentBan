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

/** A parent is blocked by its children while any non-archived child isn't Done. */
export function blockedByChildren(db: DB, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1
         FROM task
        WHERE parent_id = ?
          AND status != 'Done'
          AND archived_at IS NULL
        LIMIT 1`,
    )
    .get(taskId);
  return !!row;
}

/** Subtask progress: Done vs total non-archived children (for context/show). */
export function childProgress(db: DB, taskId: string): { done: number; total: number } {
  const row = db
    .prepare(
      `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'Done' THEN 1 ELSE 0 END), 0) AS done
         FROM task
        WHERE parent_id = ?
          AND archived_at IS NULL`,
    )
    .get(taskId) as { done: number; total: number };
  return { done: row.done, total: row.total };
}

export function deriveState(db: DB, task: Task): DerivedState {
  const blocked_by_deps = blockedByDeps(db, task.id);
  const needs_input = needsInput(db, task.id);
  const blocked_by_children = blockedByChildren(db, task.id);
  const ready =
    !blocked_by_deps &&
    !needs_input &&
    !blocked_by_children &&
    task.archived_at === null &&
    (task.status === 'Ready' || task.status === 'In Progress');
  return { blocked_by_deps, needs_input, blocked_by_children, ready };
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
