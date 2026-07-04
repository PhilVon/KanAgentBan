import { describe, it, expect } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client } from './helpers';
import { NotFoundError, ValidationError } from '../src/server/repo';

describe('repo: bulk ops (one transaction, one event each)', () => {
  it('bulk move applies to every id with one event per task', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    const b = repo.createTask({ title: 'b' });
    const c = repo.createTask({ title: 'c' });
    const before = repo.maxSeq();
    const r = repo.bulk('move', [a.id, b.id, c.id, a.id], { status: 'Ready' }); // dupe collapsed
    expect(r.count).toBe(3);
    for (const id of [a.id, b.id, c.id]) expect(repo.getTask(id)!.status).toBe('Ready');
    const evs = repo.changes(before);
    expect(evs.map((e) => e.type)).toEqual(['task.moved', 'task.moved', 'task.moved']);
  });

  it('all-or-nothing: one bad id rolls the whole batch back', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    const before = repo.maxSeq();
    expect(() => repo.bulk('move', [a.id, 'T-999'], { status: 'Ready' })).toThrow(NotFoundError);
    expect(repo.getTask(a.id)!.status).toBe('Backlog'); // untouched
    expect(repo.changes(before)).toEqual([]); // no partial events
  });

  it('guards still apply mid-batch (open subtasks block a bulk Done)', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'Ready' });
    const parent = repo.createTask({ title: 'p', status: 'Ready' });
    repo.createTask({ title: 'child', parent: parent.id });
    expect(() => repo.bulk('move', [a.id, parent.id], { status: 'Done' })).toThrow(ValidationError);
    expect(repo.getTask(a.id)!.status).toBe('Ready'); // rolled back with the batch
  });

  it('bulk label / unlabel and archive work across ids', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    const b = repo.createTask({ title: 'b' });
    repo.bulk('label', [a.id, b.id], { name: 'sweep' });
    expect(repo.getLabels(a.id)).toContain('sweep');
    expect(repo.getLabels(b.id)).toContain('sweep');
    repo.bulk('unlabel', [a.id], { name: 'sweep' });
    expect(repo.getLabels(a.id)).not.toContain('sweep');
    repo.bulk('archive', [a.id, b.id]);
    expect(repo.getTask(a.id)!.archived_at).toBeTruthy();
    expect(repo.getTask(b.id)!.archived_at).toBeTruthy();
  });

  it('rejects an unknown op, empty ids, a bad status, and a missing label name', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    expect(() => repo.bulk('frobnicate' as any, [a.id])).toThrow(ValidationError);
    expect(() => repo.bulk('move', [], { status: 'Ready' })).toThrow(ValidationError);
    expect(() => repo.bulk('move', [a.id], { status: 'To Do' })).toThrow(ValidationError);
    expect(() => repo.bulk('label', [a.id], {})).toThrow(ValidationError);
  });
});

describe('server: POST /api/tasks/bulk', () => {
  it('moves a list atomically and 404s cleanly on a bad id', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const a = (await c('POST', '/api/tasks', { title: 'a' })).body;
      const b = (await c('POST', '/api/tasks', { title: 'b' })).body;
      const ok = await c('POST', '/api/tasks/bulk', { op: 'move', ids: [a.id, b.id], status: 'Ready' });
      expect(ok.status).toBe(200);
      expect(ok.body.count).toBe(2);
      const bad = await c('POST', '/api/tasks/bulk', { op: 'move', ids: [a.id, 'T-99'], status: 'Done' });
      expect(bad.status).toBe(404);
      expect(h.repo.getTask(a.id)!.status).toBe('Ready'); // batch rolled back
    } finally {
      await stopTestServer(h);
    }
  });
});
