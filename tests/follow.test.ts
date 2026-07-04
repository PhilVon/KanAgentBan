import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startTestServer, stopTestServer, client, sleep, type TestServer } from './helpers';
import { boardPaths } from '../src/shared/board-paths';
import { followChanges, followTask } from '../src/cli/follow';
import type { Conn } from '../src/cli/board';

// The --follow helpers are driven directly against a test server (no CLI child
// process — the Windows `kanban` shim is a .cmd and spawning it from tests is
// its own footgun). This is the same layering the MCP tests use.
let h: TestServer;
let conn: Conn;

beforeEach(async () => {
  h = await startTestServer();
  conn = { base: h.url, token: h.token, paths: boardPaths(h.root), agent: 'tester' };
});
afterEach(async () => {
  await stopTestServer(h);
});

async function until<T>(fn: () => T, ms = 4000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error('until: timed out');
    await sleep(20);
  }
}

describe('followChanges', () => {
  it('streams live events and replays from the cursor', async () => {
    const api = client(h);
    const before = (await api('POST', '/api/tasks', { title: 'pre-existing' })).body;

    const events: any[] = [];
    const handle = followChanges(conn, 0, (ev) => events.push(ev));
    try {
      // since=0 replays the pre-existing event...
      await until(() => events.some((e) => e.type === 'task.created' && e.task_id === before.id));
      // ...and live mutations keep flowing on the same socket.
      const live = (await api('POST', '/api/tasks', { title: 'live one' })).body;
      await until(() => events.some((e) => e.type === 'task.created' && e.task_id === live.id));
      // Events are strictly seq-ascending (no duplicates from the replay).
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      handle.close();
    }
  });

  it('passes reset frames through when the cursor predates the floor', async () => {
    const api = client(h);
    for (let i = 0; i < 8; i++) await api('POST', '/api/tasks', { title: `t${i}` });
    h.repo.compact(2);
    expect(h.repo.floor()).toBeGreaterThan(1);

    const events: any[] = [];
    const handle = followChanges(conn, 1, (ev) => events.push(ev));
    try {
      const reset = await until(() => events.find((e) => e.type === 'reset'));
      expect(reset.floor).toBe(h.repo.floor());
      // The stream continues past the floor: a new mutation still arrives.
      const t = (await api('POST', '/api/tasks', { title: 'after reset' })).body;
      await until(() => events.some((e) => e.type === 'task.created' && e.task_id === t.id));
    } finally {
      handle.close();
    }
  });
});

describe('followTask', () => {
  it('filters to the task and its direct deps, and refreshes the set on dep changes', async () => {
    const api = client(h);
    const a = (await api('POST', '/api/tasks', { title: 'A' })).body;
    const b = (await api('POST', '/api/tasks', { title: 'B' })).body;
    const c = (await api('POST', '/api/tasks', { title: 'C' })).body;
    await api('POST', `/api/tasks/${a.id}/deps`, { on: b.id }); // A waits on B
    const startSeq = h.repo.maxSeq();

    const events: any[] = [];
    const handle = followTask(conn, a.id, startSeq, (ev) => events.push(ev));
    try {
      await sleep(100); // let the related-set seed (A + blocker B)

      // Unrelated task: silent.
      await api('POST', `/api/tasks/${c.id}/move`, { status: 'Ready' });
      // Direct blocker: visible.
      await api('POST', `/api/tasks/${b.id}/move`, { status: 'In Progress' });
      await until(() => events.some((e) => e.type === 'task.moved' && e.task_id === b.id));
      expect(events.some((e) => e.task_id === c.id)).toBe(false);

      // A new dep edge on A refreshes the set: C's later events become visible.
      await api('POST', `/api/tasks/${a.id}/deps`, { on: c.id });
      await until(() => events.some((e) => e.type === 'dep.added' && e.task_id === a.id));
      await sleep(100); // refreshRelated round-trip
      await api('POST', `/api/tasks/${c.id}/move`, { status: 'In Progress' });
      await until(() => events.some((e) => e.type === 'task.moved' && e.task_id === c.id));
    } finally {
      handle.close();
    }
  });
});
