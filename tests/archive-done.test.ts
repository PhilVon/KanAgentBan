import { describe, it, expect } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client } from './helpers';

// ---- repo: archiveDoneTasks ------------------------------------------------

describe('repo: archiveDoneTasks', () => {
  it('archives every Done leaf, leaves non-Done untouched, emits one event each', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'Done' });
    const b = repo.createTask({ title: 'b', status: 'Done' });
    const open = repo.createTask({ title: 'open', status: 'In Progress' });

    const before = repo.maxSeq();
    const res = repo.archiveDoneTasks();

    expect(res).toEqual({ archived: 2, skipped: [] });
    expect(repo.requireTask(a.id).archived_at).not.toBeNull();
    expect(repo.requireTask(b.id).archived_at).not.toBeNull();
    expect(repo.requireTask(open.id).archived_at).toBeNull();

    // Exactly N task.archived events, and nothing else, were appended (atomic).
    const events = repo.changes(before);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === 'task.archived')).toBe(true);
    expect(events.map((e) => e.task_id).sort()).toEqual([a.id, b.id].sort());
  });

  it('collapses a fully-Done subtree bottom-up (parent and child both archived)', () => {
    const repo = makeRepo();
    const parent = repo.createTask({ title: 'p' });
    const child = repo.createTask({ title: 'c', parent: parent.id, status: 'Done' });
    repo.moveTask(parent.id, 'Done'); // allowed: child is Done

    const res = repo.archiveDoneTasks();

    expect(res.archived).toBe(2);
    expect(res.skipped).toEqual([]);
    expect(repo.requireTask(parent.id).archived_at).not.toBeNull();
    expect(repo.requireTask(child.id).archived_at).not.toBeNull();
  });

  it('archives a Done child of a non-Done parent, leaving the parent alone', () => {
    const repo = makeRepo();
    const parent = repo.createTask({ title: 'p', status: 'In Progress' });
    const child = repo.createTask({ title: 'c', parent: parent.id, status: 'Done' });

    const res = repo.archiveDoneTasks();

    expect(res.archived).toBe(1);
    expect(repo.requireTask(child.id).archived_at).not.toBeNull();
    expect(repo.requireTask(parent.id).archived_at).toBeNull();
  });

  it('skips a Done parent that still has a live (non-Done) child', () => {
    const repo = makeRepo();
    const parent = repo.createTask({ title: 'p' });
    const child = repo.createTask({ title: 'c', parent: parent.id, status: 'Done' });
    repo.moveTask(parent.id, 'Done'); // ok while child is Done
    repo.moveTask(child.id, 'In Progress'); // child leaves Done -> parent now has a live child

    const before = repo.maxSeq();
    const res = repo.archiveDoneTasks();

    expect(res.archived).toBe(0);
    expect(res.skipped).toEqual([parent.id]);
    expect(repo.requireTask(parent.id).archived_at).toBeNull();
    expect(repo.maxSeq()).toBe(before); // skip emits no event
  });

  it('is a no-op when the Done column is empty', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'backlog' });
    const before = repo.maxSeq();

    expect(repo.archiveDoneTasks()).toEqual({ archived: 0, skipped: [] });
    expect(repo.maxSeq()).toBe(before);
  });

  it('attributes the archive events to the given actor', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'a', status: 'Done' });
    const before = repo.maxSeq();
    repo.archiveDoneTasks('user');
    const ev = repo.changes(before).find((e) => e.type === 'task.archived');
    expect(ev!.actor_type).toBe('user');
  });
});

// ---- server: POST /api/tasks/archive-done ----------------------------------

describe('server: archive-done endpoint', () => {
  it('returns 200 with {archived, skipped} and archives the Done column', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const a = (await c('POST', '/api/tasks', { title: 'a', status: 'Done' })).body;
      await c('POST', '/api/tasks', { title: 'b', status: 'Done' });
      const open = (await c('POST', '/api/tasks', { title: 'open', status: 'In Progress' })).body;

      const res = await c('POST', '/api/tasks/archive-done');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ archived: 2, skipped: [] });

      // Done tasks gone from the board; the In Progress one survives.
      const list = (await c('GET', '/api/tasks?json=1')).body;
      const ids = (list.tasks ?? list).map((t: any) => t.id);
      expect(ids).toContain(open.id);
      expect(ids).not.toContain(a.id);
    } finally {
      await stopTestServer(h);
    }
  });

  it('returns archived:0 on an empty Done column', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      await c('POST', '/api/tasks', { title: 'backlog' });
      const res = await c('POST', '/api/tasks/archive-done');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ archived: 0, skipped: [] });
    } finally {
      await stopTestServer(h);
    }
  });
});
