import { describe, it, expect } from 'vitest';
import { makeRepo, sleep, startTestServer, stopTestServer, client } from './helpers';
import { boardStats, taskTiming, buildSegments } from '../src/server/stats';
import { renderStats, renderTaskStats } from '../src/server/render';

describe('stats: per-task timing', () => {
  it('computes lead and cycle for a full lifecycle (cycle <= lead)', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' }); // Backlog
    repo.moveTask(t.id, 'Ready');
    repo.moveTask(t.id, 'In Progress');
    await sleep(5);
    repo.moveTask(t.id, 'Review');
    repo.moveTask(t.id, 'Done');

    const tt = taskTiming(repo, t.id);
    expect(tt.done_at).not.toBeNull();
    expect(tt.first_in_progress_at).not.toBeNull();
    expect(tt.never_in_progress).toBe(false);
    expect(tt.lead_ms).not.toBeNull();
    expect(tt.cycle_ms).not.toBeNull();
    expect(tt.cycle_ms!).toBeLessThanOrEqual(tt.lead_ms!);
    expect(tt.partial_history).toBe(false);
  });

  it('Backlog -> Done directly: lead set, cycle null, never_in_progress', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' });
    repo.moveTask(t.id, 'Done');
    const tt = taskTiming(repo, t.id);
    expect(tt.cycle_ms).toBeNull();
    expect(tt.never_in_progress).toBe(true);
    expect(tt.lead_ms).not.toBeNull();
  });

  it('sums multiple In-Progress stints in time_per_status', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' });
    repo.moveTask(t.id, 'In Progress');
    await sleep(5);
    repo.moveTask(t.id, 'Review');
    await sleep(2);
    repo.moveTask(t.id, 'In Progress');
    await sleep(5);
    repo.moveTask(t.id, 'Done');

    const events = repo.changes(0).filter((e) => e.task_id === t.id);
    const segs = buildSegments(repo.requireTask(t.id), events);
    const ipSegs = segs.filter((s) => s.status === 'In Progress');
    expect(ipSegs.length).toBe(2);
    const expected = ipSegs.reduce((a, s) => a + ((s.exit ?? 0) - s.enter), 0);

    const tt = taskTiming(repo, t.id);
    expect(tt.time_per_status['In Progress']).toBe(expected);
    expect(tt.active_in_progress_ms).toBe(tt.time_per_status['In Progress']);
  });

  it('reopened from Done: done_at null, reopened, counts as WIP', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' });
    repo.moveTask(t.id, 'In Progress');
    repo.moveTask(t.id, 'Done');
    repo.moveTask(t.id, 'In Progress');
    const tt = taskTiming(repo, t.id);
    expect(tt.done_at).toBeNull();
    expect(tt.reopened).toBe(true);
    expect(tt.reopen_count).toBe(1);
    expect(tt.status).toBe('In Progress');

    const ip = boardStats(repo).wip.find((c) => c.status === 'In Progress')!;
    expect(ip.count).toBe(1);
  });

  it('still-open task: lead/cycle null, current-status time tracked', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' });
    repo.moveTask(t.id, 'In Progress');
    await sleep(5);
    const tt = taskTiming(repo, t.id);
    expect(tt.lead_ms).toBeNull();
    expect(tt.cycle_ms).toBeNull();
    expect(tt.time_in_current_status_ms).toBeGreaterThan(0);
  });

  it('created directly In Progress: first_in_progress_at is non-null without a move', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x', status: 'In Progress' });
    const tt = taskTiming(repo, t.id);
    expect(tt.first_in_progress_at).not.toBeNull();
    expect(tt.never_in_progress).toBe(false);
  });
});

describe('stats: board aggregates', () => {
  it('WIP counts match listTasks and exclude archived', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'a', status: 'Ready' });
    repo.createTask({ title: 'b', status: 'In Progress' });
    const c = repo.createTask({ title: 'c', status: 'In Progress' });
    repo.archiveTask(c.id);

    const wip = boardStats(repo).wip;
    for (const status of ['Backlog', 'Ready', 'In Progress', 'Review', 'Done'] as const) {
      const col = wip.find((w) => w.status === status)!;
      expect(col.count).toBe(repo.listTasks({ status }).length);
    }
    expect(wip.find((w) => w.status === 'In Progress')!.count).toBe(1); // c archived out
  });

  it('throughput totals completed tasks within the window', () => {
    const repo = makeRepo();
    for (let i = 0; i < 3; i++) {
      const t = repo.createTask({ title: `t${i}` });
      repo.moveTask(t.id, 'Done');
    }
    repo.createTask({ title: 'open' });
    const s = boardStats(repo);
    expect(s.throughput.total).toBe(3);
    expect(s.throughput.series.reduce((a, p) => a + p.completed, 0)).toBe(3);
  });

  it('burndown has one contiguous ascending point per window day with a sound invariant', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    repo.moveTask(a.id, 'Done');
    repo.createTask({ title: 'b' });
    // Backdate the oldest task so the project is 7 days old — the window now
    // clamps to project age, so a fresh board would otherwise yield 1 point.
    const old = new Date(Date.now() - 6 * 86400000).toISOString();
    repo.db.prepare('UPDATE task SET created_at = ? WHERE id = ?').run(old, a.id);

    const s = boardStats(repo, { windowDays: 7 });
    expect(s.burndown).toHaveLength(7);
    for (let i = 1; i < s.burndown.length; i++)
      expect(s.burndown[i].date > s.burndown[i - 1].date).toBe(true);
    for (const p of s.burndown) {
      expect(p.remaining).toBeGreaterThanOrEqual(0);
      expect(p.remaining + p.done).toBeLessThanOrEqual(p.created_cum);
    }
    // Today: one done, one remaining.
    const today = s.burndown[s.burndown.length - 1];
    expect(today.done).toBe(1);
    expect(today.remaining).toBe(1);
  });

  it('clamps the window to project age — no buckets before the first task (T-1)', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' }); // created today

    // Fresh board: even a 14-day request collapses to today only.
    const fresh = boardStats(repo, { windowDays: 14 });
    expect(fresh.window.days).toBe(1);
    expect(fresh.burndown).toHaveLength(1);
    expect(fresh.throughput.series).toHaveLength(1);

    // Backdate to make the project 3 days old: window expands to min(14, age=4).
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    repo.db.prepare('UPDATE task SET created_at = ? WHERE id = ?').run(old, a.id);
    const aged = boardStats(repo, { windowDays: 14 });
    expect(aged.window.days).toBe(4);
    expect(aged.burndown).toHaveLength(4);

    // A small request still wins when it's narrower than the project age.
    expect(boardStats(repo, { windowDays: 2 }).window.days).toBe(2);
  });
});

describe('stats: compaction / partial history (never-silent)', () => {
  it('flags and excludes tasks whose creation predates the floor', () => {
    const repo = makeRepo();
    const early = repo.createTask({ title: 'early', status: 'In Progress' }); // seq 1
    for (let i = 0; i < 10; i++) repo.createTask({ title: `t${i}` }); // more events
    const last = repo.listTasks({}).slice(-1)[0]; // newest task, event survives compaction

    repo.compact(3); // keep newest 3 events; floor advances past `early`'s creation
    expect(repo.floor()).toBeGreaterThan(0);

    const et = taskTiming(repo, early.id);
    expect(et.partial_history).toBe(true);

    const lt = taskTiming(repo, last.id);
    expect(lt.partial_history).toBe(false); // created after the floor

    const s = boardStats(repo);
    expect(s.partial_history).toBe(true);
    expect(s.excluded_partial).toContain(early.id);
    expect(s.excluded_partial).not.toContain(last.id);
    expect(s.compaction_floor).toBe(repo.floor());
    expect(renderStats(s)).toContain('history bounded');
  });
});

describe('stats: rendering + REST', () => {
  it('renderStats budgets never-silently and renderTaskStats shows durations', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' });
    repo.moveTask(t.id, 'In Progress');
    repo.moveTask(t.id, 'Done');

    const s = boardStats(repo);
    const full = renderStats(s, { full: true });
    const tiny = renderStats(s, { maxTokens: 5 });
    expect(tiny.length).toBeLessThan(full.length);
    expect(tiny).toContain('hidden for token budget');

    expect(renderTaskStats(taskTiming(repo, t.id))).toContain(t.id);
  });

  it('serves /api/stats and /api/tasks/:id/stats; 404 on unknown id', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const created = await c('POST', '/api/tasks', { title: 'a' });
      const id = created.body.id;
      await c('POST', `/api/tasks/${id}/move`, { status: 'Done' });

      const board = await c('GET', '/api/stats?json');
      expect(board.status).toBe(200);
      expect(board.body).toHaveProperty('compaction_floor');
      expect(board.body).toHaveProperty('burndown');
      expect(board.body).toHaveProperty('wip');
      expect(board.body).toHaveProperty('est_tokens');

      const per = await c('GET', `/api/tasks/${id}/stats?json`);
      expect(per.status).toBe(200);
      expect(per.body).toHaveProperty('time_per_status');
      expect(per.body.done_at).not.toBeNull();

      const text = await c('GET', '/api/stats');
      expect(typeof text.body.text).toBe('string');

      const missing = await c('GET', '/api/tasks/T-999/stats');
      expect(missing.status).toBe(404);
    } finally {
      await stopTestServer(h);
    }
  });
});
