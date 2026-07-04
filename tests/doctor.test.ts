import { describe, it, expect } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client } from './helpers';
import { runDoctor } from '../src/server/doctor';
import { renderDoctor } from '../src/server/render';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('doctor: hygiene checks', () => {
  it('a fresh, tidy board is healthy', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'In Progress', criteria: ['done when x'] });
    repo.claimTask(t.id, 'alice', { ttlSeconds: 600 });
    const r = runDoctor(repo);
    expect(r.healthy).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('flags an expired lease and an untouched indefinite claim', () => {
    const repo = makeRepo();
    const leased = repo.createTask({ title: 'leased', criteria: ['x'] });
    repo.claimTask(leased.id, 'alice', { ttlSeconds: 600 });
    repo.db.prepare('UPDATE task SET claim_expires_at = ? WHERE id = ?').run(iso(2 * HOUR), leased.id);
    const idle = repo.createTask({ title: 'idle', criteria: ['x'] });
    repo.claimTask(idle.id, 'bob');
    repo.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(iso(30 * HOUR), idle.id);
    const checks = runDoctor(repo).findings.filter((f) => f.check === 'stale-claim');
    expect(checks.map((f) => f.id).sort()).toEqual([leased.id, idle.id].sort());
  });

  it('a fresh indefinite claim and a live lease are not stale', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    repo.claimTask(a.id, 'alice');
    const b = repo.createTask({ title: 'b' });
    repo.claimTask(b.id, 'bob', { ttlSeconds: 3600 });
    expect(runDoctor(repo).findings.filter((f) => f.check === 'stale-claim')).toEqual([]);
  });

  it('flags In Progress without criteria', () => {
    const repo = makeRepo();
    const bare = repo.createTask({ title: 'bare', status: 'In Progress' });
    repo.createTask({ title: 'ok', status: 'In Progress', criteria: ['has one'] });
    repo.createTask({ title: 'ready-no-crit', status: 'Ready' }); // only In Progress is checked
    const f = runDoctor(repo).findings.filter((x) => x.check === 'wip-no-criteria');
    expect(f.map((x) => x.id)).toEqual([bare.id]);
  });

  it('flags aging WIP in active columns only', () => {
    const repo = makeRepo();
    const old = repo.createTask({ title: 'old', status: 'Review' });
    repo.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(iso(8 * DAY), old.id);
    const parked = repo.createTask({ title: 'parked backlog' }); // Backlog never ages
    repo.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(iso(30 * DAY), parked.id);
    const f = runDoctor(repo).findings.filter((x) => x.check === 'aging-wip');
    expect(f.map((x) => x.id)).toEqual([old.id]);
  });

  it('flags open questions older than 48h', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'In Progress', criteria: ['x'] });
    const q = repo.ask(t.id, 'ancient?');
    repo.db.prepare('UPDATE input_request SET created_at = ? WHERE id = ?').run(iso(3 * DAY), q.id);
    repo.ask(t.id, 'fresh?');
    const f = runDoctor(repo).findings.filter((x) => x.check === 'ancient-ask');
    expect(f.map((x) => x.id)).toEqual([q.id]);
    expect(f[0].detail).toContain('ancient?');
  });

  it('flags a stale summary', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', summary: 's', description: 'd' });
    repo.updateTask(t.id, { description: 'd2' }); // description now newer than summary
    const f = runDoctor(repo).findings.filter((x) => x.check === 'stale-summary');
    expect(f.map((x) => x.id)).toEqual([t.id]);
  });

  it('flags a Done-eligible parent', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent', status: 'In Progress', criteria: ['x'] });
    const c1 = repo.createTask({ title: 'c1', parent: p.id, status: 'Ready' });
    repo.moveTask(c1.id, 'Done');
    const f = runDoctor(repo).findings.filter((x) => x.check === 'done-eligible-parent');
    expect(f.map((x) => x.id)).toEqual([p.id]);
  });
});

describe('doctor: render + endpoint', () => {
  it('renders healthy as one line naming the check count', () => {
    const repo = makeRepo();
    expect(renderDoctor(runDoctor(repo))).toMatch(/board healthy — 6 checks clean/);
  });

  it('renders findings grouped by check with the count up top', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'bare', status: 'In Progress' });
    const text = renderDoctor(runDoctor(repo));
    expect(text).toContain('1 finding');
    expect(text).toContain('wip-no-criteria');
    expect(text).toContain('T-1');
  });

  it('GET /api/doctor returns the report with text and healthy flag', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const clean = await c('GET', '/api/doctor?json=1');
      expect(clean.status).toBe(200);
      expect(clean.body.healthy).toBe(true);
      await c('POST', '/api/tasks', { title: 'bare', status: 'In Progress' });
      const dirty = await c('GET', '/api/doctor?json=1');
      expect(dirty.body.healthy).toBe(false);
      expect(dirty.body.findings).toHaveLength(1);
      expect(dirty.body.text).toContain('wip-no-criteria');
    } finally {
      await stopTestServer(h);
    }
  });
});
