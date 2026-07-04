import { describe, it, expect } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client } from './helpers';
import { ValidationError } from '../src/server/repo';
import { boardStats } from '../src/server/stats';

describe('repo: review gate', () => {
  it('approve moves Review -> Done and stamps the verdict on task.moved', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Review' });
    const got = repo.reviewTask(t.id, 'approve');
    expect(got.status).toBe('Done');
    const ev = repo.changes(0).filter((e) => e.type === 'task.moved');
    expect(ev[ev.length - 1].payload).toEqual({ from: 'Review', to: 'Done', review: 'approved' });
    expect(ev[ev.length - 1].actor_type).toBe('user');
  });

  it('reject kicks back to In Progress, requires a reason, and records it as a comment', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Review' });
    expect(() => repo.reviewTask(t.id, 'reject')).toThrow(ValidationError);
    expect(() => repo.reviewTask(t.id, 'reject', { reason: '   ' })).toThrow(ValidationError);
    const got = repo.reviewTask(t.id, 'reject', { reason: 'tests missing' });
    expect(got.status).toBe('In Progress');
    const ev = repo.changes(0).filter((e) => e.type === 'task.moved');
    expect(ev[ev.length - 1].payload).toEqual({
      from: 'Review',
      to: 'In Progress',
      review: 'rejected',
      reason: 'tests missing',
    });
    const comments = repo.getComments(t.id);
    expect(comments.some((c) => c.body === 'review rejected: tests missing')).toBe(true);
  });

  it('only a Review task passes the gate; approve honours the open-subtask guard', () => {
    const repo = makeRepo();
    const wip = repo.createTask({ title: 'wip', status: 'In Progress' });
    expect(() => repo.reviewTask(wip.id, 'approve')).toThrow(ValidationError);
    const parent = repo.createTask({ title: 'p', status: 'Review' });
    repo.createTask({ title: 'child', parent: parent.id, status: 'Ready' });
    expect(() => repo.reviewTask(parent.id, 'approve')).toThrow(ValidationError);
    // Rejecting the parent is fine — it goes back to In Progress, not Done.
    expect(repo.reviewTask(parent.id, 'reject', { reason: 'kids open' }).status).toBe('In Progress');
  });

  it('an approve reason is optional and recorded when given', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Review' });
    repo.reviewTask(t.id, 'approve', { reason: 'LGTM, nice tests' });
    expect(repo.getComments(t.id).some((c) => c.body === 'review approved: LGTM, nice tests')).toBe(true);
  });

  it('a reject feeds the existing kickback stat', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    repo.moveTask(t.id, 'In Progress');
    repo.moveTask(t.id, 'Review');
    repo.reviewTask(t.id, 'reject', { reason: 'bounce' });
    const q = boardStats(repo).quality;
    expect(q.kickbacks).toBe(1);
    expect(q.kickback_rate).toBe(1);
  });
});

describe('server: review endpoint', () => {
  it('POST /api/tasks/:id/review approves/rejects with actor + agent identity', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const t = (await c('POST', '/api/tasks', { title: 'a', status: 'Review' })).body;
      const bad = await c('POST', `/api/tasks/${t.id}/review`, { verdict: 'reject' });
      expect(bad.status).toBe(400); // reason required
      const rej = await c('POST', `/api/tasks/${t.id}/review`, { verdict: 'reject', reason: 'nope' }, { 'x-actor': 'user', 'x-agent': 'phil' });
      expect(rej.status).toBe(200);
      expect(rej.body.status).toBe('In Progress');
      await c('POST', `/api/tasks/${t.id}/move`, { status: 'Review' });
      const ok = await c('POST', `/api/tasks/${t.id}/review`, { verdict: 'approve' });
      expect(ok.body.status).toBe('Done');
      const unknown = await c('POST', `/api/tasks/${t.id}/review`, { verdict: 'ship-it' });
      expect(unknown.status).toBe(400);
    } finally {
      await stopTestServer(h);
    }
  });
});
