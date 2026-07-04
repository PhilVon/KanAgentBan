import { describe, it, expect } from 'vitest';
import { makeRepo } from './helpers';
import { ValidationError } from '../src/server/repo';

const DAY = 86_400_000;
const agedIso = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe('repo: auto-archive policy (Done older than N days)', () => {
  it('archives only Done tasks past the age cutoff', () => {
    const repo = makeRepo();
    const oldDone = repo.createTask({ title: 'old done', status: 'Ready' });
    repo.moveTask(oldDone.id, 'Done');
    repo.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(agedIso(10), oldDone.id);
    const freshDone = repo.createTask({ title: 'fresh done', status: 'Ready' });
    repo.moveTask(freshDone.id, 'Done');
    const oldOpen = repo.createTask({ title: 'old open', status: 'In Progress' });
    repo.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(agedIso(30), oldOpen.id);

    const r = repo.archiveDoneOlderThan(7);
    expect(r.archived).toBe(1);
    expect(repo.getTask(oldDone.id)!.archived_at).toBeTruthy();
    expect(repo.getTask(freshDone.id)!.archived_at).toBeNull();
    expect(repo.getTask(oldOpen.id)!.archived_at).toBeNull();
    // Events: one task.archived, actor system.
    const evs = repo.changes(0).filter((e) => e.type === 'task.archived');
    expect(evs).toHaveLength(1);
    expect(evs[0].actor_type).toBe('system');
    // Idempotent second sweep.
    expect(repo.archiveDoneOlderThan(7).archived).toBe(0);
  });

  it('collapses an aged fully-Done subtree bottom-up; skips a parent with a young child', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'p', status: 'Ready' });
    const c1 = repo.createTask({ title: 'c1', parent: p.id, status: 'Ready' });
    repo.moveTask(c1.id, 'Done');
    repo.moveTask(p.id, 'Done');
    repo.db.prepare('UPDATE task SET updated_at = ?').run(agedIso(10));
    expect(repo.archiveDoneOlderThan(7).archived).toBe(2); // child then parent

    const p2 = repo.createTask({ title: 'p2', status: 'Ready' });
    const young = repo.createTask({ title: 'young', parent: p2.id, status: 'Ready' });
    repo.moveTask(young.id, 'Done');
    repo.moveTask(p2.id, 'Done');
    repo.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(agedIso(10), p2.id);
    const r = repo.archiveDoneOlderThan(7);
    expect(r.archived).toBe(0); // young child keeps the parent alive
    expect(r.skipped).toContain(p2.id);
  });

  it('rejects a non-positive day threshold', () => {
    const repo = makeRepo();
    expect(() => repo.archiveDoneOlderThan(0)).toThrow(ValidationError);
    expect(() => repo.archiveDoneOlderThan(-3)).toThrow(ValidationError);
  });
});
