import { describe, it, expect } from 'vitest';
import { makeRepo, sleep } from './helpers';
import { recommend, type BlockedSummary } from '../src/server/recommend';

function rec(repo: ReturnType<typeof makeRepo>, n = 1) {
  return recommend(repo, n);
}

describe('recommend: next engine', () => {
  it('returns a blocked summary when the board is empty', () => {
    const repo = makeRepo();
    const r = rec(repo) as BlockedSummary;
    expect(r.none).toBe(true);
    expect(r.blocked).toEqual([]);
  });

  it('ranks ready tasks by priority (P0 before P1)', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'low', status: 'Ready', priority: 'P2' });
    const hi = repo.createTask({ title: 'high', status: 'Ready', priority: 'P0' });
    const r = rec(repo) as { task: any; why: string }[];
    expect(r[0].task.id).toBe(hi.id);
  });

  it('excludes dep-blocked and needs-input tasks, explaining why', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'Ready' });
    const b = repo.createTask({ title: 'b', status: 'Ready' });
    repo.addDep(a.id, b.id); // a waits on b
    repo.ask(b.id, 'decision?'); // b needs input

    const r = rec(repo) as BlockedSummary;
    expect(r.none).toBe(true);
    const byId = Object.fromEntries(r.blocked.map((x) => [x.id, x.reason]));
    expect(byId[a.id]).toContain('waits on');
    expect(byId[a.id]).toContain(b.id);
    expect(byId[b.id]).toContain('needs input');
  });

  it('applies a sticky bias to the most-recently-touched ready task', async () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'Ready', priority: 'P1' });
    await sleep(5);
    const b = repo.createTask({ title: 'b', status: 'Ready', priority: 'P1' });
    // b is newest -> recommended first
    expect((rec(repo) as any[])[0].task.id).toBe(b.id);

    await sleep(5);
    repo.moveTask(a.id, 'In Progress'); // touch a -> now most recent
    const top = (rec(repo) as any[])[0];
    expect(top.task.id).toBe(a.id);
    expect(top.why).toContain('touched it last');
  });
});
