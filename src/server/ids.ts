import type { DB } from './db';

/**
 * Per-board monotonic counters. Allocation MUST happen inside the caller's write
 * transaction so IDs and the event `seq` are gap-free and ordered by commit
 * (see docs/09-concurrency.md).
 */
export function nextCounter(db: DB, name: string): number {
  db.prepare(
    'INSERT INTO counters(name, value) VALUES(?, 1) ' +
      'ON CONFLICT(name) DO UPDATE SET value = value + 1',
  ).run(name);
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as {
    value: number;
  };
  return row.value;
}

export const nextTaskId = (db: DB) => `T-${nextCounter(db, 'task')}`;
export const nextRequestId = (db: DB) => `Q-${nextCounter(db, 'input_request')}`;
export const nextCommentId = (db: DB) => `C-${nextCounter(db, 'comment')}`;
export const nextCriterionId = (db: DB) => `AC-${nextCounter(db, 'acceptance_criterion')}`;
export const nextArtifactId = (db: DB) => `A-${nextCounter(db, 'artifact')}`;
export const nextSeq = (db: DB) => nextCounter(db, 'seq');
