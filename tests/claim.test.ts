import { describe, it, expect } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client } from './helpers';
import { ConflictError, ValidationError } from '../src/server/repo';
import { recommend, type BlockedSummary } from '../src/server/recommend';
import { renderList, renderShow, renderContext } from '../src/server/render';

// ---- repo: claim / release ------------------------------------------------

describe('repo: claiming', () => {
  it('claim sets assignee, bumps version, and emits one task.claimed event', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    const before = repo.maxSeq();
    const claimed = repo.claimTask(t.id, 'alice');
    expect(claimed.assignee).toBe('alice');
    expect(claimed.version).toBe(t.version + 1);
    const events = repo.changes(before).filter((e) => e.type === 'task.claimed');
    expect(events).toHaveLength(1);
    expect((events[0].payload as any).assignee).toBe('alice');
  });

  it('re-claim by the same agent is an idempotent no-op (no event, no version bump)', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    const first = repo.claimTask(t.id, 'alice');
    const seq = repo.maxSeq();
    const again = repo.claimTask(t.id, 'alice');
    expect(again.version).toBe(first.version);
    expect(repo.maxSeq()).toBe(seq); // no new event
  });

  it('claim by another agent throws ConflictError', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    repo.claimTask(t.id, 'alice');
    expect(() => repo.claimTask(t.id, 'bob')).toThrow(ConflictError);
  });

  it('force steals another agent’s claim and records stolen_from', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    repo.claimTask(t.id, 'alice');
    const before = repo.maxSeq();
    const stolen = repo.claimTask(t.id, 'bob', { force: true });
    expect(stolen.assignee).toBe('bob');
    const ev = repo.changes(before).find((e) => e.type === 'task.claimed');
    expect((ev!.payload as any).stolen_from).toBe('alice');
  });

  it('cannot claim a Done or archived task', () => {
    const repo = makeRepo();
    const done = repo.createTask({ title: 'done', status: 'Ready' });
    repo.moveTask(done.id, 'Done');
    expect(() => repo.claimTask(done.id, 'alice')).toThrow(ValidationError);

    const arch = repo.createTask({ title: 'arch', status: 'Ready' });
    repo.archiveTask(arch.id);
    expect(() => repo.claimTask(arch.id, 'alice')).toThrow(ValidationError);
  });

  it('release by owner clears assignee, bumps version, emits task.released', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    repo.claimTask(t.id, 'alice');
    const before = repo.maxSeq();
    const released = repo.releaseTask(t.id, 'alice');
    expect(released.assignee).toBeNull();
    const ev = repo.changes(before).find((e) => e.type === 'task.released');
    expect((ev!.payload as any).released_from).toBe('alice');
  });

  it('release of an unassigned task is an idempotent no-op', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    const seq = repo.maxSeq();
    const r = repo.releaseTask(t.id, 'alice');
    expect(r.assignee).toBeNull();
    expect(repo.maxSeq()).toBe(seq); // no event
  });

  it('release by a non-owner needs --force', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    repo.claimTask(t.id, 'alice');
    expect(() => repo.releaseTask(t.id, 'bob')).toThrow(ConflictError);
    expect(repo.releaseTask(t.id, 'bob', { force: true }).assignee).toBeNull();
  });
});

// ---- recommend: multi-agent visibility ------------------------------------

describe('recommend: claims', () => {
  it('hides a task claimed by another agent but shows it to its owner', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    repo.claimTask(t.id, 'alice');
    expect(recommend(repo, 1, 'bob')).toMatchObject({ none: true });
    expect((recommend(repo, 1, 'alice') as any[])[0].task.id).toBe(t.id);
  });

  it('keeps unassigned tasks visible to everyone', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    expect((recommend(repo, 1, 'bob') as any[])[0].task.id).toBe(t.id);
  });

  it('reports "claimed by" when every ready task is held by others', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    repo.claimTask(t.id, 'alice');
    const r = recommend(repo, 1, 'bob') as BlockedSummary;
    expect(r.none).toBe(true);
    expect(r.blocked[0].reason).toContain('claimed by alice');
  });

  it('biases my own claimed task above an equal-rank unassigned one', () => {
    const repo = makeRepo();
    const mine = repo.createTask({ title: 'mine', status: 'Ready', priority: 'P1' });
    repo.createTask({ title: 'free', status: 'Ready', priority: 'P1' });
    repo.claimTask(mine.id, 'alice');
    const top = (recommend(repo, 1, 'alice') as any[])[0];
    expect(top.task.id).toBe(mine.id);
    expect(top.why).toContain('claimed');
  });

  it('--mine shows only my claims (empty otherwise)', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'Ready' });
    repo.createTask({ title: 'free', status: 'Ready' });
    repo.claimTask(a.id, 'alice');
    const mine = recommend(repo, 5, 'alice', true) as any[];
    expect(mine.map((r) => r.task.id)).toEqual([a.id]);
    expect(recommend(repo, 5, 'bob', true)).toMatchObject({ none: true, blocked: [] });
  });

  it('ignores claims when called with no agent (regression)', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    repo.claimTask(t.id, 'alice');
    expect((recommend(repo, 1) as any[])[0].task.id).toBe(t.id);
  });
});

// ---- render: assignee surfacing -------------------------------------------

describe('render: assignee', () => {
  it('list/show/context show the assignee when set and omit it when null', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'Ready' });
    expect(renderList(repo, {})).not.toContain('@alice');
    repo.claimTask(t.id, 'alice');
    expect(renderList(repo, {})).toContain('@alice');
    expect(renderShow(repo, t.id)).toContain('assignee alice');
    expect(renderContext(repo, t.id)).toContain('assignee: alice');
  });
});

// ---- server: claim / release endpoints ------------------------------------

describe('server: claim endpoints', () => {
  it('claims, rejects a second claimer, and filters next per agent', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const t1 = (await c('POST', '/api/tasks', { title: 't1', status: 'Ready' })).body;
      await c('POST', '/api/tasks', { title: 't2', status: 'Ready' });

      const claim = await c('POST', `/api/tasks/${t1.id}/claim`, undefined, { 'x-agent': 'alice' });
      expect(claim.status).toBe(200);
      expect(claim.body.assignee).toBe('alice');

      const stolen = await c('POST', `/api/tasks/${t1.id}/claim`, undefined, { 'x-agent': 'bob' });
      expect(stolen.status).toBe(409);

      // bob's next excludes alice's claim -> recommends t2.
      const next = await c('GET', '/api/next?json=1', undefined, { 'x-agent': 'bob' });
      expect(next.body.next[0].task.title).toBe('t2');
    } finally {
      await stopTestServer(h);
    }
  });

  it('release honors ownership and --force, and Done cannot be claimed', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const t = (await c('POST', '/api/tasks', { title: 't', status: 'Ready' })).body;
      await c('POST', `/api/tasks/${t.id}/claim`, undefined, { 'x-agent': 'alice' });

      expect((await c('POST', `/api/tasks/${t.id}/release`, undefined, { 'x-agent': 'bob' })).status).toBe(409);
      const forced = await c('POST', `/api/tasks/${t.id}/release`, { force: true }, { 'x-agent': 'bob' });
      expect(forced.status).toBe(200);
      expect(forced.body.assignee).toBeNull();

      await c('POST', `/api/tasks/${t.id}/move`, { status: 'Done' });
      expect((await c('POST', `/api/tasks/${t.id}/claim`, undefined, { 'x-agent': 'alice' })).status).toBe(400);
    } finally {
      await stopTestServer(h);
    }
  });
});
