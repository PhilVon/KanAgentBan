import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRepo, startTestServer, stopTestServer, client, tempDir, type TestServer } from './helpers';
import { openDb } from '../src/server/db';
import { Repo } from '../src/server/repo';
import { countCriteria, fmtCriteria } from '../src/server/derive';
import { runDoctor } from '../src/server/doctor';
import { renderContext, renderShow } from '../src/server/render';
import { runTool } from '../src/mcp/tools';
import { boardPaths } from '../src/shared/board-paths';
import type { Conn } from '../src/cli/board';

// A criterion had exactly two states, so a mis-specified one could only be ticked
// falsely, left unchecked forever, or escalated as a question the agent raised
// about its own planning error. `retire` is the third state; `--human` is for the
// ones only a person can settle (six of one session's ten questions existed only
// to route those); `amend` is for the merely badly-typed.

describe('criterion retire', () => {
  it('records the reason, and the reason is required', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['transcripts render'] });
    const [c] = repo.getCriteria(t.id);
    expect(() => repo.retireCriterion(c.id, '')).toThrow(/reason is the record/);
    expect(() => repo.retireCriterion(c.id, '   ')).toThrow(/reason is the record/);

    const r = repo.retireCriterion(c.id, 'the client has no transcripts, so this cannot be built');
    expect(r.retired_at).toBeTruthy();
    expect(r.retire_reason).toBe('the client has no transcripts, so this cannot be built');
    expect(r.successor_task_id).toBeNull();
  });

  it('records a successor task, and rejects one that does not exist', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const carrier = repo.createTask({ title: 'carries it instead' });
    const [c] = repo.getCriteria(t.id);
    expect(() => repo.retireCriterion(c.id, 'why', { successor: 'T-999' })).toThrow();
    expect(repo.retireCriterion(c.id, 'why', { successor: carrier.id }).successor_task_id).toBe(carrier.id);
  });

  it('leaves both sides of the count, so it never reads as unfinished work', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['a', 'b', 'c'] });
    const crit = repo.getCriteria(t.id);
    repo.checkCriterion(crit[0].id, true);
    expect(countCriteria(repo.getCriteria(t.id))).toMatchObject({ done: 1, total: 3, retired: 0 });

    repo.retireCriterion(crit[2].id, 'turned out to be wrong');
    // 1/2, not 1/3 and not 2/3 — a retired criterion is neither done nor pending.
    expect(countCriteria(repo.getCriteria(t.id))).toMatchObject({ done: 1, total: 2, retired: 1 });
  });

  it('cannot be ticked once retired, and cannot be retired twice', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const [c] = repo.getCriteria(t.id);
    repo.retireCriterion(c.id, 'wrong');
    // The false tick is the exact failure this state exists to prevent.
    expect(() => repo.checkCriterion(c.id, true)).toThrow(/retired/);
    expect(() => repo.retireCriterion(c.id, 'again')).toThrow(/already retired/);
  });

  it('never blocks Done', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    const [c] = repo.getCriteria(t.id);
    repo.retireCriterion(c.id, 'wrong');
    expect(repo.moveTask(t.id, 'Done').status).toBe('Done');
  });

  it('emits an event carrying the reason', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const [c] = repo.getCriteria(t.id);
    repo.retireCriterion(c.id, 'no transcripts', { successor: t.id });
    const ev = repo.changes(0).find((e) => e.type === 'criterion.retired')!;
    expect(ev.payload).toEqual({ id: c.id, reason: 'no transcripts', successor: t.id });
  });
});

describe('criterion --human', () => {
  it('stays in the denominator — it is still work', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    repo.addCriterion(t.id, 'the tape reads right on the page', 'agent', { human: true });
    repo.addCriterion(t.id, 'the build passes');
    const n = countCriteria(repo.getCriteria(t.id));
    expect(n).toMatchObject({ done: 0, total: 2, human_open: 1 });
  });

  it('stops counting as human_open once it is settled', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const id = repo.addCriterion(t.id, 'playtested', 'agent', { human: true });
    repo.checkCriterion(id, true, 'user');
    expect(countCriteria(repo.getCriteria(t.id)).human_open).toBe(0);
  });

  it('doctor names it apart from work the agent is failing to finish', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent', status: 'In Progress' });
    repo.addCriterion(p.id, 'the build passes');
    repo.addCriterion(p.id, 'the playtest feels right', 'agent', { human: true });
    const kid = repo.createTask({ title: 'kid', parent: p.id, status: 'Ready' });
    repo.moveTask(kid.id, 'Done');

    const f = runDoctor(repo).findings.find((x) => x.check === 'done-eligible-parent')!;
    expect(f.detail).toContain('2 of its own 2 criteria unchecked');
    expect(f.detail).toContain('1 of them only the human can settle');
    expect(f.blind_spot).toContain('waiting on the human');
  });

  it('a task whose only criteria are retired counts as having none', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    expect(runDoctor(repo).findings.filter((f) => f.check === 'wip-no-criteria')).toEqual([]);
    repo.retireCriterion(repo.getCriteria(t.id)[0].id, 'wrong');
    // Retired means "turned out wrong", not "met" — so the definition of done is
    // gone and doctor says so again.
    expect(runDoctor(repo).findings.filter((f) => f.check === 'wip-no-criteria')).toHaveLength(1);
  });
});

describe('criterion amend', () => {
  it('rewrites the text and keeps the state', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['AC-1111 AC-1031 the drag offers the sentence'] });
    const [c] = repo.getCriteria(t.id);
    repo.checkCriterion(c.id, true);
    const r = repo.amendCriterion(c.id, 'a drag across a wrapped sentence offers the sentence');
    expect(r.text).toBe('a drag across a wrapped sentence offers the sentence');
    expect(r.checked).toBe(true);
    const ev = repo.changes(0).find((e) => e.type === 'criterion.amended')!;
    expect((ev.payload as any).from).toContain('AC-1111');
  });

  it('rejects empty replacement text', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    expect(() => repo.amendCriterion(repo.getCriteria(t.id)[0].id, '  ')).toThrow(/replacement text/);
  });
});

describe('rendering', () => {
  it('an ordinary task reads exactly as it did — tails append only when non-zero', () => {
    expect(fmtCriteria({ done: 5, total: 6, retired: 0, human_open: 0 })).toBe('5/6');
    expect(fmtCriteria({ done: 5, total: 6, retired: 1, human_open: 0 })).toBe('5/6  ·  1 retired');
    expect(fmtCriteria({ done: 5, total: 6, retired: 0, human_open: 2 })).toBe('5/6  ·  2 for the human');
    expect(fmtCriteria({ done: 5, total: 6, retired: 1, human_open: 2 })).toBe(
      '5/6  ·  1 retired  ·  2 for the human',
    );
  });

  it('show/context render an unremarkable task identically to before', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['a', 'b'] });
    repo.checkCriterion(repo.getCriteria(t.id)[0].id, true);
    expect(renderShow(repo, t.id, { full: true })).toContain('criteria 1/2  ·  blockers');
    const ctx = renderContext(repo, t.id, { full: true });
    expect(ctx).toContain('criteria 1/2:');
    expect(ctx).not.toContain('retired');
    expect(ctx).not.toContain('[human]');
  });

  it('context marks a retired criterion with its reason and successor, and a human one', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['a', 'b'] });
    const carrier = repo.createTask({ title: 'successor' });
    const crit = repo.getCriteria(t.id);
    repo.retireCriterion(crit[1].id, 'the client has no transcripts', { successor: carrier.id });
    repo.addCriterion(t.id, 'the playtest feels right', 'agent', { human: true });

    const ctx = renderContext(repo, t.id, { full: true });
    expect(ctx).toContain('criteria 0/2  ·  1 retired  ·  1 for the human:');
    expect(ctx).toContain(`[~] ${crit[1].id} b  — retired: the client has no transcripts (→ ${carrier.id})`);
    expect(ctx).toContain('[human]');
  });
});

describe('REST, MCP, and templates', () => {
  let h: TestServer;
  afterEach(async () => {
    if (h) await stopTestServer(h);
  });

  it('REST: add --human, amend via PATCH text, retire via its own route', async () => {
    h = await startTestServer();
    const c = client(h);
    const t = (await c('POST', '/api/tasks', { title: 't', status: 'In Progress' })).body;
    const a = (await c('POST', `/api/tasks/${t.id}/criteria`, { text: 'playtest', human: true })).body;
    const b = (await c('POST', `/api/tasks/${t.id}/criteria`, { text: 'typo hree' })).body;

    expect((await c('PATCH', `/api/criteria/${b.id}`, { text: 'typo here' })).body.text).toBe('typo here');
    // The reason is required at the boundary too, not just in the repo.
    expect((await c('POST', `/api/criteria/${b.id}/retire`, {})).status).toBe(400);
    const r = (await c('POST', `/api/criteria/${b.id}/retire`, { because: 'wrong all along' })).body;
    expect(r.retire_reason).toBe('wrong all along');

    const card = (await c('GET', '/api/ui/board')).body.tasks.find((x: any) => x.id === t.id);
    expect(card).toMatchObject({
      criteria_done: 0,
      criteria_total: 1,
      criteria_retired: 1,
      criteria_human_open: 1,
    });
    expect((await c('GET', `/api/tasks/${t.id}?view=context&json=1`)).body.criteria.find((x: any) => x.id === a.id).human).toBe(true);
  });

  it('MCP: the criterion tool carries add/human, retire and amend', async () => {
    h = await startTestServer();
    const conn: Conn = { base: h.url, token: h.token, paths: boardPaths(h.root), agent: 'tester' };
    const c = client(h);
    const t = (await c('POST', '/api/tasks', { title: 't' })).body;

    const added = await runTool(conn, 'criterion', { op: 'add', id: t.id, text: 'playtest', human: true });
    expect(added.content[0].text).toContain('for the human');

    const other = await runTool(conn, 'criterion', { op: 'add', id: t.id, text: 'wrong one' });
    const acid = other.content[0].text.split(' ')[0];

    const noReason = await runTool(conn, 'criterion', { op: 'retire', acid });
    expect(noReason.isError).toBe(true);

    const retired = await runTool(conn, 'criterion', { op: 'retire', acid, because: 'no transcripts' });
    expect(retired.content[0].text).toContain('retired: no transcripts');

    const amended = await runTool(conn, 'criterion', { op: 'amend', acid, text: 'still wrong but typed right' });
    expect(amended.content[0].text).toContain('amended');
  });

  it('a template blueprint does not carry a retired criterion', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'shape', criteria: ['keep me', 'drop me'] });
    repo.retireCriterion(repo.getCriteria(t.id)[1].id, 'was never right');
    repo.saveTemplateFromTask('pr', t.id);
    // A blueprint carries the shape of the work; a retired criterion is a planning
    // error already corrected, and copying it forward would recreate it.
    expect(repo.getTemplate('pr')!.blueprint.criteria).toEqual(['keep me']);
  });
});

describe('migration: a v11 board gains criterion states with no data loss', () => {
  it('every pre-existing criterion stays live, unretired and agent-checkable', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    let repo = new Repo(openDb(dbPath));
    const t = repo.createTask({ title: 'host', status: 'In Progress', criteria: ['done one', 'not yet'] });
    const before = repo.getCriteria(t.id);
    repo.checkCriterion(before[0].id, true);

    repo.db.exec(`
      ALTER TABLE acceptance_criterion DROP COLUMN human;
      ALTER TABLE acceptance_criterion DROP COLUMN retired_at;
      ALTER TABLE acceptance_criterion DROP COLUMN retire_reason;
      ALTER TABLE acceptance_criterion DROP COLUMN successor_task_id;
      INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '11');
    `);
    repo.db.close();

    repo = new Repo(openDb(dbPath));
    const after = repo.getCriteria(t.id);
    expect(after.map((c) => c.text)).toEqual(['done one', 'not yet']);
    expect(after.map((c) => c.checked)).toEqual([true, false]);
    expect(after.every((c) => !c.human && c.retired_at === null)).toBe(true);
    expect(countCriteria(after)).toMatchObject({ done: 1, total: 2, retired: 0, human_open: 0 });
    // …and the new states work on the migrated board.
    expect(repo.retireCriterion(after[1].id, 'wrong').retire_reason).toBe('wrong');

    const v = repo.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(v.value)).toBeGreaterThanOrEqual(12);
    repo.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
