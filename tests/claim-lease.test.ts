import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { makeRepo, tempDir, startTestServer, stopTestServer, client } from './helpers';
import { openDb, SCHEMA_VERSION } from '../src/server/db';
import { Repo, ConflictError, ValidationError } from '../src/server/repo';
import { renderContext } from '../src/server/render';

const past = () => new Date(Date.now() - 1000).toISOString();

describe('repo: claim leases (ttl)', () => {
  it('claim with ttl sets a future expiry; without ttl stays indefinite', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    const leased = repo.claimTask(t.id, 'alice', { ttlSeconds: 300 });
    expect(leased.claim_expires_at).toBeTruthy();
    expect(new Date(leased.claim_expires_at!).getTime()).toBeGreaterThan(Date.now());
    const b = repo.createTask({ title: 'b' });
    expect(repo.claimTask(b.id, 'alice').claim_expires_at).toBeNull();
  });

  it('re-claim by the holder renews (or clears) the lease without an event', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    repo.claimTask(t.id, 'alice', { ttlSeconds: 1 });
    const before = repo.changes(0).filter((e) => e.type === 'task.claimed').length;
    const renewed = repo.claimTask(t.id, 'alice', { ttlSeconds: 600 });
    expect(new Date(renewed.claim_expires_at!).getTime()).toBeGreaterThan(Date.now() + 500_000);
    const cleared = repo.claimTask(t.id, 'alice'); // no ttl -> indefinite again
    expect(cleared.claim_expires_at).toBeNull();
    expect(repo.changes(0).filter((e) => e.type === 'task.claimed')).toHaveLength(before);
  });

  it('rejects a non-positive ttl', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    expect(() => repo.claimTask(t.id, 'a', { ttlSeconds: 0 })).toThrow(ValidationError);
    expect(() => repo.claimTask(t.id, 'a', { ttlSeconds: -5 })).toThrow(ValidationError);
  });

  it('a live lease still conflicts for other agents; an expired one is taken over freely', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    repo.claimTask(t.id, 'alice', { ttlSeconds: 600 });
    expect(() => repo.claimTask(t.id, 'bob')).toThrow(ConflictError);
    // Force the lease into the past (simulates a dead agent).
    repo.db.prepare('UPDATE task SET claim_expires_at = ? WHERE id = ?').run(past(), t.id);
    const taken = repo.claimTask(t.id, 'bob'); // no force needed
    expect(taken.assignee).toBe('bob');
    const evs = repo.changes(0);
    const released = evs.filter((e) => e.type === 'task.released');
    expect(released).toHaveLength(1);
    expect(released[0].payload).toEqual({ released_from: 'alice', expired: true });
    expect(released[0].actor_type).toBe('system');
    // Takeover of a dead lease is not a steal.
    const claims = evs.filter((e) => e.type === 'task.claimed');
    expect(claims[claims.length - 1].payload).toEqual({ assignee: 'bob' });
  });

  it('releaseExpiredClaims sweeps only past-due leases and emits expired releases', () => {
    const repo = makeRepo();
    const dead = repo.createTask({ title: 'dead' });
    const live = repo.createTask({ title: 'live' });
    const forever = repo.createTask({ title: 'forever' });
    repo.claimTask(dead.id, 'alice', { ttlSeconds: 600 });
    repo.claimTask(live.id, 'bob', { ttlSeconds: 600 });
    repo.claimTask(forever.id, 'carol');
    repo.db.prepare('UPDATE task SET claim_expires_at = ? WHERE id = ?').run(past(), dead.id);
    expect(repo.releaseExpiredClaims().released).toBe(1);
    expect(repo.getTask(dead.id)!.assignee).toBeNull();
    expect(repo.getTask(dead.id)!.claim_expires_at).toBeNull();
    expect(repo.getTask(live.id)!.assignee).toBe('bob');
    expect(repo.getTask(forever.id)!.assignee).toBe('carol');
    const ev = repo.changes(0).filter((e) => e.type === 'task.released');
    expect(ev).toHaveLength(1);
    expect(ev[0].task_id).toBe(dead.id);
    expect(ev[0].payload).toEqual({ released_from: 'alice', expired: true });
    expect(repo.releaseExpiredClaims().released).toBe(0); // idempotent
  });

  it('release clears the lease alongside the assignee', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    repo.claimTask(t.id, 'alice', { ttlSeconds: 600 });
    const rel = repo.releaseTask(t.id, 'alice');
    expect(rel.assignee).toBeNull();
    expect(rel.claim_expires_at).toBeNull();
  });

  it('context shows the lease state on the assignee line', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'In Progress' });
    repo.claimTask(t.id, 'alice', { ttlSeconds: 3600 });
    expect(renderContext(repo, t.id)).toMatch(/assignee: alice {2}\(lease expires in \d+[mh]\)/);
    repo.db.prepare('UPDATE task SET claim_expires_at = ? WHERE id = ?').run(past(), t.id);
    expect(renderContext(repo, t.id)).toContain('assignee: alice  (lease expired)');
  });
});

describe('server: claim ttl + sweep wiring', () => {
  it('POST claim accepts {ttl} and returns the lease', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const t = (await c('POST', '/api/tasks', { title: 'a' })).body;
      const r = await c('POST', `/api/tasks/${t.id}/claim`, { ttl: 120 }, { 'x-agent': 'alice' });
      expect(r.status).toBe(200);
      expect(r.body.assignee).toBe('alice');
      expect(new Date(r.body.claim_expires_at).getTime()).toBeGreaterThan(Date.now());
      const bad = await c('POST', `/api/tasks/${t.id}/claim`, { ttl: -1 }, { 'x-agent': 'alice' });
      expect(bad.status).toBe(400);
    } finally {
      await stopTestServer(h);
    }
  });
});

describe('migration: v7 board gains claim_expires_at', () => {
  it('adds the column to an existing board', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, summary TEXT,
        summary_source TEXT, summary_updated_at TEXT, description_updated_at TEXT,
        status TEXT NOT NULL DEFAULT 'Backlog', priority TEXT NOT NULL DEFAULT 'P2',
        position REAL, assignee TEXT, parent_id TEXT REFERENCES task(id),
        checkpoint TEXT, checkpoint_at TEXT, checkpoint_by TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
    `);
    raw.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schema_version', '7');
    raw.prepare(
      'INSERT INTO task(id,title,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    ).run('T-1', 'legacy', 'Backlog', 1, '2020-01-01', '2020-01-01');
    raw.close();

    const db = openDb(dbPath);
    const cols = (db.prepare('PRAGMA table_info(task)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('claim_expires_at');
    expect(db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')).toEqual({
      value: String(SCHEMA_VERSION),
    });
    const repo = new Repo(db);
    expect(repo.claimTask('T-1', 'alice', { ttlSeconds: 60 }).claim_expires_at).toBeTruthy();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
