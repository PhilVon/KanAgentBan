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

// Backdate a task's creation so age-based and window-based metrics have room.
function backdate(repo: ReturnType<typeof makeRepo>, id: string, daysAgo: number) {
  const iso = new Date(Date.now() - daysAgo * 86400000).toISOString();
  repo.db.prepare('UPDATE task SET created_at = ? WHERE id = ?').run(iso, id);
}

describe('stats: flow efficiency (T-2)', () => {
  it('per-task flow_efficiency in [0,1], active/lead; null without a lead', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' });
    repo.moveTask(t.id, 'In Progress');
    await sleep(8);
    repo.moveTask(t.id, 'Done');
    const tt = taskTiming(repo, t.id);
    expect(tt.flow_efficiency).not.toBeNull();
    expect(tt.flow_efficiency!).toBeGreaterThanOrEqual(0);
    expect(tt.flow_efficiency!).toBeLessThanOrEqual(1);

    const open = repo.createTask({ title: 'y' });
    expect(taskTiming(repo, open.id).flow_efficiency).toBeNull(); // no lead yet
  });

  it('board timing_summary.flow_efficiency summarizes completed non-partial tasks', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' });
    repo.moveTask(t.id, 'In Progress');
    await sleep(5);
    repo.moveTask(t.id, 'Done');
    const fe = boardStats(repo).timing_summary.flow_efficiency;
    expect(fe.n).toBe(1);
    expect(fe.p50).toBeGreaterThanOrEqual(0);
    expect(fe.p50).toBeLessThanOrEqual(1);
  });
});

describe('stats: input-wait latency (T-3)', () => {
  it('counts open/answered/expired/cancelled and summarizes resolved waits', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x' });
    const answered = repo.ask(t.id, 'q1');
    await sleep(5);
    repo.answer(answered.id, 'yes', 'phil');
    repo.ask(t.id, 'q2'); // stays open
    const toCancel = repo.ask(t.id, 'q3');
    repo.cancel(toCancel.id);
    const toExpire = repo.ask(t.id, 'q4', { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(toExpire).toBeDefined();
    repo.expireDue();

    const iw = boardStats(repo).input_wait;
    expect(iw.answered).toBe(1);
    expect(iw.cancelled).toBe(1);
    expect(iw.expired).toBe(1);
    expect(iw.open).toBe(1);
    expect(iw.oldest_open_ms).not.toBeNull();
    expect(iw.resolved.n).toBe(1); // only the answered one
    expect(iw.resolved.p50).toBeGreaterThan(0);
  });
});

describe('stats: net flow rate (T-4)', () => {
  it('arrival vs departure with a growing/shrinking trend', () => {
    const repo = makeRepo();
    // Two created in-window, none done -> arrival > departure -> growing.
    const a = repo.createTask({ title: 'a' });
    repo.createTask({ title: 'b' });
    backdate(repo, a.id, 2); // open a 3-day window
    const s = boardStats(repo, { windowDays: 14 });
    expect(s.flow.arrival_per_day).toBeGreaterThan(0);
    expect(s.flow.departure_per_day).toBe(s.throughput.rolling_avg_per_day);
    expect(s.flow.net_per_day).toBeCloseTo(s.flow.arrival_per_day - s.flow.departure_per_day, 5);
    expect(s.flow.trend).toBe('growing');
  });
});

describe('stats: aging-WIP buckets + flags (T-5)', () => {
  it('aging buckets partition each column and sum to count', () => {
    const repo = makeRepo();
    const fresh = repo.createTask({ title: 'fresh', status: 'In Progress' });
    const aging = repo.createTask({ title: 'aging', status: 'In Progress' });
    const stale = repo.createTask({ title: 'stale', status: 'In Progress' });
    backdate(repo, aging.id, 3);
    backdate(repo, stale.id, 10);
    expect(fresh).toBeDefined();

    const s = boardStats(repo);
    const ip = s.wip.find((c) => c.status === 'In Progress')!;
    expect(ip.aging.fresh + ip.aging.aging + ip.aging.stale).toBe(ip.count);
    expect(ip.aging.fresh).toBe(1);
    expect(ip.aging.aging).toBe(1);
    expect(ip.aging.stale).toBe(1);

    // aging_flags lists the >7d non-Done task.
    expect(s.aging_flags.map((f) => f.id)).toContain(stale.id);
    expect(s.aging_flags.map((f) => f.id)).not.toContain(fresh.id);
  });

  it('Done tasks never appear in aging_flags', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'old-done' });
    backdate(repo, t.id, 30);
    repo.moveTask(t.id, 'Done');
    expect(boardStats(repo).aging_flags.map((f) => f.id)).not.toContain(t.id);
  });
});

describe('stats: rework / kickback (T-6)', () => {
  it('counts reopens and Review->In Progress kickbacks with rates', () => {
    const repo = makeRepo();
    // Kickback: Review -> In Progress.
    const k = repo.createTask({ title: 'k' });
    repo.moveTask(k.id, 'In Progress');
    repo.moveTask(k.id, 'Review');
    repo.moveTask(k.id, 'In Progress'); // kickback
    repo.moveTask(k.id, 'Review');
    repo.moveTask(k.id, 'Done');
    // Reopen: Done -> In Progress.
    const r = repo.createTask({ title: 'r' });
    repo.moveTask(r.id, 'In Progress');
    repo.moveTask(r.id, 'Done');
    repo.moveTask(r.id, 'In Progress'); // reopen

    const q = boardStats(repo).quality;
    expect(q.kickbacks).toBe(1);
    expect(q.reopened).toBe(1);
    expect(q.kickback_rate).toBeGreaterThan(0);
    expect(q.kickback_rate).toBeLessThanOrEqual(1);
    expect(q.reopen_rate).toBeGreaterThan(0);
  });
});

describe('stats: per-priority cycle/lead (T-7)', () => {
  it('groups completed tasks by priority with WIP counts', () => {
    const repo = makeRepo();
    const p0 = repo.createTask({ title: 'p0', priority: 'P0' });
    repo.moveTask(p0.id, 'In Progress');
    repo.moveTask(p0.id, 'Done');
    repo.createTask({ title: 'p0-open', priority: 'P0', status: 'In Progress' });

    const by = boardStats(repo).by_priority;
    expect(by.map((r) => r.priority)).toEqual(['P0', 'P1', 'P2', 'P3']);
    const row = by.find((r) => r.priority === 'P0')!;
    expect(row.n).toBe(1);
    expect(row.wip).toBe(1);
    expect(row.lead.n).toBe(1);
  });
});

describe('stats: completion forecast (T-8)', () => {
  it('days_to_drain null at zero velocity; diverging when net>=0', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'open1' });
    repo.createTask({ title: 'open2' });
    const s = boardStats(repo);
    expect(s.forecast.remaining).toBe(2);
    expect(s.forecast.days_to_drain).toBeNull(); // nothing completed -> velocity 0
    expect(s.forecast.diverging).toBe(true);
  });

  it('forecasts a drain date when there is velocity', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    backdate(repo, a.id, 6);
    for (let i = 0; i < 6; i++) {
      const t = repo.createTask({ title: `d${i}` });
      repo.moveTask(t.id, 'Done');
    }
    repo.createTask({ title: 'remaining' });
    const fc = boardStats(repo, { windowDays: 7 }).forecast;
    expect(fc.velocity_per_day).toBeGreaterThan(0);
    expect(fc.days_to_drain).not.toBeNull();
    expect(fc.eta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('stats: per-label throughput (T-9)', () => {
  it('groups completed tasks by current label, sorted by volume', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', labels: ['api'] });
    repo.moveTask(a.id, 'In Progress');
    repo.moveTask(a.id, 'Done');
    const b = repo.createTask({ title: 'b', labels: ['api'], status: 'In Progress' });
    expect(b).toBeDefined();
    const c = repo.createTask({ title: 'c', labels: ['ui'] });
    repo.moveTask(c.id, 'Done');

    const by = boardStats(repo).by_label;
    const api = by.find((l) => l.name === 'api')!;
    expect(api.n).toBe(1);
    expect(api.wip).toBe(1);
    expect(by[0].n).toBeGreaterThanOrEqual(by[by.length - 1].n); // desc by n
  });
});

describe('stats: per-agent throughput (T-10)', () => {
  it('credits the last claimer before Done; empty without claims', () => {
    const repo = makeRepo();
    const noClaims = boardStats(repo);
    expect(noClaims.by_agent).toEqual([]);

    const t = repo.createTask({ title: 'x' });
    repo.claimTask(t.id, 'alice');
    repo.moveTask(t.id, 'In Progress');
    repo.moveTask(t.id, 'Done');
    const open = repo.createTask({ title: 'y', status: 'In Progress' });
    repo.claimTask(open.id, 'alice');

    const by = boardStats(repo).by_agent;
    const alice = by.find((a) => a.agent_id === 'alice')!;
    expect(alice.completed).toBe(1);
    expect(alice.active_wip).toBe(1);
  });
});

describe('stats: CFD (T-11)', () => {
  it('each day column sums to created-not-archived as of EOD', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    backdate(repo, a.id, 3);
    repo.moveTask(a.id, 'In Progress');
    const b = repo.createTask({ title: 'b' });
    repo.archiveTask(b.id);

    const s = boardStats(repo, { windowDays: 7 });
    expect(s.cfd.length).toBe(s.window.days);
    for (const day of s.cfd) {
      const sum = (['Backlog', 'Ready', 'In Progress', 'Review', 'Done'] as const).reduce(
        (acc, st) => acc + day.counts[st],
        0,
      );
      const end = Date.parse(`${day.date}T23:59:59.999Z`);
      const expected = repo.allTasks().filter((t) => {
        const created = Date.parse(t.created_at);
        const archived = t.archived_at ? Date.parse(t.archived_at) : null;
        return created <= end && !(archived !== null && archived <= end);
      }).length;
      expect(sum).toBe(expected);
    }
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

    // Expansion lines render in the full output (FORMAT_VERSION 7).
    expect(full).toContain('flow efficiency:');
    expect(full).toContain('net flow:');
    expect(full).toContain('forecast:');
    // ...and they sit after the core block, so the tight budget sheds them first.
    expect(tiny).not.toContain('forecast:');

    const perTask = renderTaskStats(taskTiming(repo, t.id), { full: true });
    expect(perTask).toContain(t.id);
    expect(perTask).toContain('flow efficiency:'); // AC-33
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
      // Expansion fields present (FORMAT_VERSION 7).
      expect(board.body).toHaveProperty('input_wait');
      expect(board.body).toHaveProperty('flow');
      expect(board.body).toHaveProperty('quality');
      expect(board.body).toHaveProperty('by_priority');
      expect(board.body).toHaveProperty('forecast');
      expect(board.body).toHaveProperty('by_label');
      expect(board.body).toHaveProperty('by_agent');
      // CFD is gated: empty by default, populated with ?cfd=1.
      expect(board.body.cfd).toEqual([]);
      const withCfd = await c('GET', '/api/stats?json&cfd=1');
      expect(withCfd.body.cfd.length).toBeGreaterThan(0);

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
