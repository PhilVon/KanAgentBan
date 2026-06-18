import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  makeRepo,
  tempDir,
  startTestServer,
  stopTestServer,
  client,
  openWs,
  collectMessages,
} from './helpers';
import { Repo } from '../src/server/repo';
import { openDb } from '../src/server/db';

/** Append n trivial events by creating n tasks; returns the repo. */
function withEvents(n: number): Repo {
  const repo = makeRepo();
  for (let i = 0; i < n; i++) repo.createTask({ title: `t${i}` });
  return repo;
}

describe('compaction: repo.compact', () => {
  it('retains the most recent `keep` events and advances the floor', () => {
    const repo = withEvents(10);
    expect(repo.eventCount()).toBe(10);
    const maxBefore = repo.maxSeq();

    const { floor, removed } = repo.compact(3);

    expect(repo.eventCount()).toBe(3);
    expect(removed).toBe(7);
    expect(repo.floor()).toBe(floor);
    expect(floor).toBeGreaterThan(0);
    // Newest event survives -> maxSeq (MAX over event) is unchanged.
    expect(repo.maxSeq()).toBe(maxBefore);
    // Everything at or below the floor is gone; everything above remains.
    expect(repo.changes(floor)).toHaveLength(3);
  });

  it('is a no-op when there are fewer than `keep` events', () => {
    const repo = withEvents(2);
    const r = repo.compact(5);
    expect(r.removed).toBe(0);
    expect(repo.floor()).toBe(0);
    expect(repo.eventCount()).toBe(2);
  });

  it('keeps seq monotonic: writes after compaction continue from the counter', () => {
    const repo = withEvents(5);
    const maxBefore = repo.maxSeq();
    repo.compact(1);
    const t = repo.createTask({ title: 'after' });
    const created = repo.changes(repo.floor()).find((e) => e.task_id === t.id);
    expect(created!.seq).toBe(maxBefore + 1); // no seq reuse
    expect(repo.maxSeq()).toBe(maxBefore + 1);
  });

  it('clamps keep to >= 1 so at least one event always survives', () => {
    const repo = withEvents(4);
    repo.compact(0);
    expect(repo.eventCount()).toBe(1);
  });

  it('the floor only advances, never regresses', () => {
    const repo = withEvents(20);
    const first = repo.compact(5).floor;
    const second = repo.compact(10).floor; // keep=10 but only 5 remain -> no-op
    expect(second).toBe(first);
    expect(repo.floor()).toBe(first);
  });
});

describe('compaction: isStale / floor', () => {
  it('flags cursors below the floor as stale; since=0 and the floor itself are not', () => {
    const repo = withEvents(10);
    const { floor } = repo.compact(3);
    expect(repo.isStale(0)).toBe(false); // full replay request
    expect(repo.isStale(floor - 1)).toBe(true);
    expect(repo.isStale(floor)).toBe(false); // boundary: floor is the retained cutoff
    expect(repo.isStale(repo.maxSeq())).toBe(false);
  });
});

describe('compaction: REST reset semantics', () => {
  it('returns reset on stale /api/changes, normal delta otherwise', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      for (let i = 0; i < 8; i++) await c('POST', '/api/tasks', { title: `t${i}` });
      const floor = h.repo.compact(2).floor;

      const stale = await c('GET', `/api/changes?since=1`);
      expect(stale.body.reset).toBe(true);
      expect(stale.body.floor).toBe(floor);
      expect(stale.body.cursor).toBe(h.repo.maxSeq());

      const fresh = await c('GET', `/api/changes?since=${floor}`);
      expect(fresh.body.reset).toBeUndefined();
      expect(fresh.body.events).toHaveLength(2);
      expect(fresh.body.floor).toBe(floor);
    } finally {
      await stopTestServer(h);
    }
  });

  it('returns reset on stale /api/inbox', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      for (let i = 0; i < 9; i++) await c('POST', '/api/tasks', { title: `t${i}` });
      const floor = h.repo.compact(2).floor;
      const r = await c('GET', `/api/inbox?since=1`);
      expect(r.body.reset).toBe(true);
      expect(r.body.floor).toBe(floor);
    } finally {
      await stopTestServer(h);
    }
  });

  it('POST /api/compact removes events and reports the floor', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      for (let i = 0; i < 6; i++) await c('POST', '/api/tasks', { title: `t${i}` });
      const r = await c('POST', '/api/compact', { keep: 2 });
      expect(r.body.removed).toBe(4);
      expect(r.body.floor).toBeGreaterThan(0);
      expect(h.repo.eventCount()).toBe(2);
    } finally {
      await stopTestServer(h);
    }
  });
});

describe('compaction: WebSocket reseed', () => {
  it('sends a reset frame before replay when the cursor predates the floor', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      for (let i = 0; i < 8; i++) await c('POST', '/api/tasks', { title: `t${i}` });
      const floor = h.repo.compact(2).floor;

      const ws = await openWs(h, 1); // since=1, below the floor
      const msgs = await collectMessages(ws, 1);
      expect(msgs[0].type).toBe('reset');
      expect(msgs[0].floor).toBe(floor);
      expect(msgs[0].cursor).toBe(h.repo.maxSeq());
      ws.close();
    } finally {
      await stopTestServer(h);
    }
  });

  it('does not send a reset frame for an up-to-date cursor', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      for (let i = 0; i < 8; i++) await c('POST', '/api/tasks', { title: `t${i}` });
      const floor = h.repo.compact(2).floor;
      const ws = await openWs(h, floor); // exactly at the floor -> not stale
      const msgs = await collectMessages(ws, 2); // the 2 retained events, no reset
      expect(msgs.every((m) => m.type !== 'reset')).toBe(true);
      ws.close();
    } finally {
      await stopTestServer(h);
    }
  });
});

describe('compaction: export + migration', () => {
  it('export carries compaction_floor and the retained event tail', () => {
    const repo = withEvents(6);
    const floor = repo.compact(2).floor;
    const snap = repo.snapshot();
    expect(snap.compaction_floor).toBe(floor);
    expect((snap.events as unknown[]).length).toBe(2);
    expect((snap.tasks as unknown[]).length).toBe(6); // full state is always complete
  });

  it('a v2 board migrates to v3 with a seeded floor and no data loss', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    // A v2-shaped fixture on disk: schema_version=2, no compaction_floor, events present.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE event (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL,
        task_id TEXT, actor_type TEXT NOT NULL, payload TEXT NOT NULL);
      INSERT INTO meta(key,value) VALUES('schema_version','2');
      INSERT INTO event(seq,ts,type,task_id,actor_type,payload)
        VALUES(1,'t','task.created','T-1','agent','{}'),(2,'t','task.updated','T-1','agent','{}');
    `);
    raw.close();

    const db = openDb(dbPath); // runs migrate()
    try {
      const floor = db.prepare("SELECT value FROM meta WHERE key='compaction_floor'").get() as
        | { value: string }
        | undefined;
      const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {
        value: string;
      };
      const events = db.prepare('SELECT COUNT(*) n FROM event').get() as { n: number };
      expect(floor?.value).toBe('0');
      expect(ver.value).toBe('3');
      expect(events.n).toBe(2); // existing events preserved across migration
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
