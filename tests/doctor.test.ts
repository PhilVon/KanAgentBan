import { describe, it, expect } from 'vitest';
import { makeRepo, sleep, startTestServer, stopTestServer, client } from './helpers';
import { CHECKS, runDoctor } from '../src/server/doctor';
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

  it('flags a stale summary', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', summary: 's', description: 'd' });
    await sleep(5); // staleness is a strict > on ISO timestamps — avoid a same-ms tie
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

  it('a Done-eligible parent names its unchecked criteria and stays conditional', () => {
    const repo = makeRepo();
    // The exact shape that nearly produced a falsified record: the rollup says
    // closable, the parent's own criteria say otherwise, and the check can only
    // see the first half.
    const p = repo.createTask({ title: 'parent', status: 'In Progress', criteria: ['playtested', 'shipped'] });
    const c1 = repo.createTask({ title: 'c1', parent: p.id, status: 'Ready' });
    repo.moveTask(c1.id, 'Done');
    const f = runDoctor(repo).findings.find((x) => x.check === 'done-eligible-parent')!;
    expect(f.detail).toContain('2 of its own 2 criteria unchecked');
    expect(f.detail).toContain('close only if those are met or retired');
    expect(f.detail).not.toContain('close it:'); // never a bare imperative
    expect(f.blind_spot).toContain('cannot judge whether a criterion is met');
  });

  it('a Done-eligible parent whose own criteria are all met states no conflict', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent', status: 'In Progress', criteria: ['x'] });
    for (const c of repo.getCriteria(p.id)) repo.checkCriterion(c.id, true);
    const c1 = repo.createTask({ title: 'c1', parent: p.id, status: 'Ready' });
    repo.moveTask(c1.id, 'Done');
    const f = runDoctor(repo).findings.find((x) => x.check === 'done-eligible-parent')!;
    expect(f.detail).not.toContain('unchecked');
    // Still conditional, and still says what it is blind to.
    expect(f.detail).toContain('close only if those are met or retired');
    expect(f.blind_spot).toBeTruthy();
  });

  it('every finding states what its check cannot see', () => {
    // The safety property, asserted over the whole report rather than per check —
    // a new check that forgets its blind spot fails here. Every check is provoked
    // so the sweep is real coverage and not three findings out of seven.
    const repo = makeRepo();

    // stale-claim (indefinite, untouched) + wip-no-criteria + aging-wip
    const bare = repo.createTask({ title: 'bare', status: 'In Progress' });
    repo.claimTask(bare.id, 'alice');
    repo.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(iso(9 * DAY), bare.id);

    // stale-summary — set the description stamp strictly after the summary's
    // (same-ms writes tie under the strict >).
    const sum = repo.createTask({ title: 'summarised', summary: 's', description: 'd', criteria: ['x'] });
    repo.db
      .prepare('UPDATE task SET description_updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() + 1000).toISOString(), sum.id);

    // ancient-ask
    const q = repo.ask(sum.id, 'ancient?');
    repo.db.prepare('UPDATE input_request SET created_at = ? WHERE id = ?').run(iso(3 * DAY), q.id);

    // stale-watch — a far longer threshold, because a watch is meant to be open
    const w = repo.expect(sum.id, 'the files land');
    repo.db.prepare('UPDATE input_request SET created_at = ? WHERE id = ?').run(iso(30 * DAY), w.id);

    // answered-elsewhere + done-eligible-parent
    const parent = repo.createTask({ title: 'parent', status: 'In Progress', criteria: ['unmet'] });
    const kid = repo.createTask({ title: 'kid', parent: parent.id, status: 'Ready' });
    repo.moveTask(kid.id, 'Done');
    const shipped = repo.createTask({ title: 'shipped', status: 'In Progress', criteria: ['x'] });
    repo.ask(shipped.id, 'which store?');
    repo.moveTask(shipped.id, 'Done');

    const r = runDoctor(repo);
    expect(new Set(r.findings.map((f) => f.check))).toEqual(new Set(CHECKS));
    for (const f of r.findings) expect(f.blind_spot, `${f.check} has no blind_spot`).toBeTruthy();
  });

  it('flags an open request on a Done task as probably answered elsewhere', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'shipped', status: 'In Progress', criteria: ['x'] });
    const q = repo.ask(t.id, 'which store?');
    repo.moveTask(t.id, 'Done');
    const f = runDoctor(repo).findings.filter((x) => x.check === 'answered-elsewhere');
    expect(f.map((x) => x.id)).toEqual([q.id]);
    expect(f[0].detail).toContain(`kanban answer ${q.id}`);
    expect(f[0].blind_spot).toContain('cancel it rather than inventing one');
  });

  it('flags a Review task with an open ask, but names the sign-off gate it cannot rule out', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'gated', status: 'In Progress', criteria: ['x'] });
    const q = repo.ask(t.id, 'ship it?');
    repo.moveTask(t.id, 'Review');
    const f = runDoctor(repo).findings.find((x) => x.check === 'answered-elsewhere')!;
    expect(f.id).toBe(q.id);
    expect(f.blind_spot).toContain('sign-off gate');
  });

  it('does not flag an open request on a task still being worked', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'live', status: 'In Progress', criteria: ['x'] });
    repo.ask(t.id, 'still deciding?');
    expect(runDoctor(repo).findings.filter((x) => x.check === 'answered-elsewhere')).toEqual([]);
  });
});

describe('doctor: render + endpoint', () => {
  it('renders healthy as one line naming the check count', () => {
    const repo = makeRepo();
    // Derived from CHECKS, not typed as a literal: the count moves whenever a
    // check is added, and a hand-written number just makes that a test edit.
    expect(renderDoctor(runDoctor(repo))).toBe(`board healthy — ${CHECKS.length} checks clean`);
  });

  it('renders the blind spot as a clause on the finding line', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'bare', status: 'In Progress' });
    const line = renderDoctor(runDoctor(repo))
      .split('\n')
      .find((l) => l.includes('T-1'))!;
    expect(line).toContain('[cannot see:');
    expect(line).toContain('invisible to it');
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
