import { describe, it, expect } from 'vitest';
import { makeRepo } from './helpers';
import { boardStats, boardPace } from '../src/server/stats';
import { runDoctor } from '../src/server/doctor';
import { standup } from '../src/server/standup';

const HOUR = 3_600_000;

/**
 * The pace-aware aging threshold must be the SAME across stats, doctor, and
 * standup — they all route through boardPace(). This guards against the three
 * surfaces drifting apart (the whole reason boardPace is a single source).
 */
describe('pace: cross-surface aging consistency', () => {
  it('flags one stuck task at the same threshold in stats, doctor, and standup', () => {
    const repo = makeRepo();

    // A fast board: ≥5 quick completions establish a tempo (p90 cycle ~ minutes),
    // so the pace threshold drops well below the legacy 7d.
    for (let i = 0; i < 6; i++) {
      const t = repo.createTask({ title: `fast-${i}` });
      repo.moveTask(t.id, 'In Progress');
      repo.moveTask(t.id, 'Done');
    }

    // One genuinely stuck task: In Progress, untouched for 3 hours.
    const stuck = repo.createTask({ title: 'stuck', status: 'In Progress' });
    const threeHoursAgo = new Date(Date.now() - 3 * HOUR).toISOString();
    repo.db.prepare('UPDATE task SET updated_at = ?, created_at = ? WHERE id = ?').run(threeHoursAgo, threeHoursAgo, stuck.id);

    const pace = boardPace(repo);
    // Tempo-derived, and well under the legacy 7d ceiling.
    expect(pace.basis).toBe('cycle-time');
    expect(pace.stale_ms).toBeLessThan(7 * 24 * HOUR);

    // stats: the stuck task appears in aging_flags; pace basis is surfaced.
    const s = boardStats(repo);
    expect(s.pace.stale_ms).toBe(pace.stale_ms);
    expect(s.aging_flags.some((f) => f.id === stuck.id)).toBe(true);

    // doctor: same task flagged aging-wip; the finding names the pace threshold.
    const doc = runDoctor(repo);
    const finding = doc.findings.find((f) => f.check === 'aging-wip' && f.id === stuck.id);
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain('pace-based');

    // standup: same task in the aging list; report carries the same pace.
    const r = standup(repo, { days: 1 });
    expect(r.pace.stale_ms).toBe(pace.stale_ms);
    expect(r.aging.some((a) => a.id === stuck.id)).toBe(true);
  });

  it('falls back to a shared 7d threshold when the board has too few completions', () => {
    const repo = makeRepo();
    // Only 2 completions — below MIN_COMPLETIONS, so all three fall back to 7d.
    for (let i = 0; i < 2; i++) {
      const t = repo.createTask({ title: `few-${i}` });
      repo.moveTask(t.id, 'Done');
    }
    const stuck = repo.createTask({ title: 'stuck', status: 'In Progress' });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * HOUR).toISOString();
    repo.db.prepare('UPDATE task SET updated_at = ?, created_at = ? WHERE id = ?').run(eightDaysAgo, eightDaysAgo, stuck.id);

    const pace = boardPace(repo);
    expect(pace.basis).toBe('default');
    expect(pace.stale_ms).toBe(7 * 24 * HOUR);

    // 8 days > 7d, so it still flags — but a 3-hour task would NOT on this board.
    expect(boardStats(repo).aging_flags.some((f) => f.id === stuck.id)).toBe(true);
    expect(runDoctor(repo).findings.some((f) => f.check === 'aging-wip' && f.id === stuck.id)).toBe(true);
    expect(standup(repo, { days: 1 }).aging.some((a) => a.id === stuck.id)).toBe(true);
  });
});
