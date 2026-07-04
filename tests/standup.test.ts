import { describe, it, expect } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client } from './helpers';
import { standup } from '../src/server/standup';
import { renderStandup } from '../src/server/render';

describe('standup: narrative board diff', () => {
  it('collects completed, net moves, new tasks, and question traffic since a cursor', () => {
    const repo = makeRepo();
    const before = repo.createTask({ title: 'old work', status: 'Ready' });
    const cursor = repo.maxSeq();

    const fresh = repo.createTask({ title: 'fresh', status: 'Ready' });
    repo.moveTask(before.id, 'In Progress');
    repo.moveTask(before.id, 'Review');
    const done = repo.createTask({ title: 'finisher', status: 'In Progress' });
    repo.moveTask(done.id, 'Done');
    const q1 = repo.ask(fresh.id, 'colour?', { options: ['red', 'blue'] });
    repo.answer(q1.id, 'red', 'phil');
    const q2 = repo.ask(fresh.id, 'shape?');
    repo.cancel(q2.id);

    const r = standup(repo, { since: cursor });
    expect(r.completed.map((c) => c.id)).toEqual([done.id]);
    expect(r.created.map((c) => c.id)).toEqual([fresh.id, done.id]);
    expect(r.moved).toEqual([
      { id: before.id, title: 'old work', from: 'Ready', to: 'Review' }, // net move, not two rows
    ]);
    expect(r.asked.map((a) => a.id)).toEqual([q1.id, q2.id]);
    expect(r.answered).toEqual([{ id: q1.id, task_id: fresh.id, answer: 'red', defaulted: false }]);
    expect(r.resolved).toEqual([{ id: q2.id, task_id: fresh.id, status: 'cancelled' }]);
    expect(r.floor_clamped).toBe(false);
  });

  it('review kickbacks and approvals surface distinctly', () => {
    const repo = makeRepo();
    const cursor = repo.maxSeq();
    const t = repo.createTask({ title: 'gated', status: 'Review' });
    repo.reviewTask(t.id, 'reject', { reason: 'needs tests' });
    repo.moveTask(t.id, 'Review');
    repo.reviewTask(t.id, 'approve');
    const r = standup(repo, { since: cursor });
    expect(r.rejected).toEqual([{ id: t.id, title: 'gated', reason: 'needs tests' }]);
    expect(r.completed).toEqual([{ id: t.id, title: 'gated', via_review: true }]);
    const text = renderStandup(r);
    expect(text).toContain('review kickbacks (1)');
    expect(text).toContain('[review approved]');
  });

  it('a day window with no events renders quiet; aging list still surfaces', () => {
    const repo = makeRepo();
    const old = repo.createTask({ title: 'stuck', status: 'In Progress' });
    repo.db
      .prepare('UPDATE task SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 9 * 86_400_000).toISOString(), old.id);
    // Push the creation events out of the 1-day window.
    repo.db.prepare('UPDATE event SET ts = ?').run(new Date(Date.now() - 9 * 86_400_000).toISOString());
    const r = standup(repo, { days: 1 });
    expect(r.completed).toEqual([]);
    expect(r.aging).toEqual([{ id: old.id, title: 'stuck', status: 'In Progress', age_days: 9 }]);
    const text = renderStandup(r);
    expect(text).toContain('aging >7d (1)');
  });

  it('a cursor below the compaction floor clamps and says so', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    for (let i = 0; i < 5; i++) repo.moveTask(t.id, i % 2 ? 'Ready' : 'In Progress');
    repo.compact(2);
    const r = standup(repo, { since: 0 });
    expect(r.floor_clamped).toBe(true);
    expect(renderStandup(r)).toContain('history bounded');
  });

  it('GET /api/standup returns text + cursor; json carries the report', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      await c('POST', '/api/tasks', { title: 'a', status: 'Ready' });
      const r = await c('GET', '/api/standup?days=1');
      expect(r.status).toBe(200);
      expect(r.body.text).toContain('standup · last 1d');
      const j = await c('GET', '/api/standup?json=1');
      expect(j.body.created).toHaveLength(1);
      expect(j.body.est_tokens).toBeGreaterThan(0);
    } finally {
      await stopTestServer(h);
    }
  });
});
