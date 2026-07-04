import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { makeRepo, tempDir, startTestServer, stopTestServer, client } from './helpers';
import { openDb, SCHEMA_VERSION } from '../src/server/db';
import { Repo, ValidationError, MAX_CHECKPOINT_CHARS } from '../src/server/repo';
import { renderContext, renderNext, renderShow } from '../src/server/render';

describe('repo: checkpoint (one-slot resume pointer)', () => {
  it('sets checkpoint text, timestamp, author and bumps the version', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    const got = repo.setCheckpoint(t.id, 'did X, next Y, watch Z', { by: 'alice' });
    expect(got.checkpoint).toBe('did X, next Y, watch Z');
    expect(got.checkpoint_at).toBeTruthy();
    expect(got.checkpoint_by).toBe('alice');
    expect(got.version).toBe(t.version + 1);
    const ev = repo.changes(0).filter((e) => e.type === 'task.checkpointed');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual({ text: 'did X, next Y, watch Z' });
  });

  it('latest wins — a second checkpoint replaces the first', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    repo.setCheckpoint(t.id, 'first');
    const got = repo.setCheckpoint(t.id, 'second');
    expect(got.checkpoint).toBe('second');
    expect(repo.changes(0).filter((e) => e.type === 'task.checkpointed')).toHaveLength(2);
  });

  it('clears with null; clearing when already clear is a no-op (no event)', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    repo.setCheckpoint(t.id, 'x');
    const cleared = repo.setCheckpoint(t.id, null);
    expect(cleared.checkpoint).toBeNull();
    expect(cleared.checkpoint_at).toBeNull();
    expect(cleared.checkpoint_by).toBeNull();
    const evs = repo.changes(0).filter((e) => e.type === 'task.checkpointed');
    expect(evs).toHaveLength(2);
    expect(evs[1].payload).toEqual({ cleared: true });
    const again = repo.setCheckpoint(t.id, null);
    expect(again.version).toBe(cleared.version); // idempotent — no version bump
    expect(repo.changes(0).filter((e) => e.type === 'task.checkpointed')).toHaveLength(2);
  });

  it('rejects empty and oversized text', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    expect(() => repo.setCheckpoint(t.id, '   ')).toThrow(ValidationError);
    expect(() => repo.setCheckpoint(t.id, 'x'.repeat(MAX_CHECKPOINT_CHARS + 1))).toThrow(
      ValidationError,
    );
    expect(repo.setCheckpoint(t.id, 'x'.repeat(MAX_CHECKPOINT_CHARS)).checkpoint).toHaveLength(
      MAX_CHECKPOINT_CHARS,
    );
  });
});

describe('render: checkpoint reads first and never sheds', () => {
  it('show/context place the checkpoint directly under the task head, above comments', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', description: 'desc', status: 'In Progress' });
    repo.addComment(t.id, 'agent note', 'agent', 'claude');
    repo.setCheckpoint(t.id, 'resume here');
    for (const text of [renderShow(repo, t.id), renderContext(repo, t.id)]) {
      const lines = text.split('\n').filter(Boolean);
      expect(lines[1]).toMatch(/^checkpoint \(.* ago\): resume here$/);
      expect(text.indexOf('checkpoint (')).toBeLessThan(text.indexOf('agent note'));
    }
  });

  it('names a non-default author', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    repo.setCheckpoint(t.id, 'x', { by: 'agent-2' });
    expect(renderShow(repo, t.id)).toContain('ago by agent-2): x');
  });

  it('survives a tight context budget that sheds other sections', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', description: 'long '.repeat(80), status: 'Ready' });
    for (let i = 0; i < 6; i++) repo.addComment(t.id, `note ${i} ${'pad '.repeat(30)}`, 'agent', 'claude');
    repo.setCheckpoint(t.id, 'the pointer');
    const tight = renderContext(repo, t.id, { maxTokens: 60 });
    expect(tight).toContain('checkpoint (');
    expect(tight).toContain('the pointer');
  });

  it('next flags a waiting checkpoint on the recommendation line', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'In Progress' });
    repo.setCheckpoint(t.id, 'pick up at step 3');
    expect(renderNext(repo, {})).toContain('↳ checkpoint (');
    expect(renderNext(repo, {})).toContain('pick up at step 3');
  });
});

describe('server: checkpoint endpoint', () => {
  it('sets, clears, and rejects a bodyless set', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const t = (await c('POST', '/api/tasks', { title: 'a' })).body;
      const set = await c('POST', `/api/tasks/${t.id}/checkpoint`, { text: 'resume' }, { 'x-agent': 'bob' });
      expect(set.status).toBe(200);
      expect(set.body.checkpoint).toBe('resume');
      expect(set.body.checkpoint_by).toBe('bob');
      const bad = await c('POST', `/api/tasks/${t.id}/checkpoint`, {});
      expect(bad.status).toBe(400); // malformed set must never silently clear
      const clr = await c('POST', `/api/tasks/${t.id}/checkpoint`, { clear: true });
      expect(clr.status).toBe(200);
      expect(clr.body.checkpoint).toBeNull();
      const missing = await c('POST', '/api/tasks/T-99/checkpoint', { text: 'x' });
      expect(missing.status).toBe(404);
    } finally {
      await stopTestServer(h);
    }
  });
});

describe('migration: v6 board gains checkpoint columns', () => {
  it('adds the columns to an existing board without losing rows', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    // A fresh current-shape DB, then strip it back to a v6 stamp with no
    // checkpoint columns by rebuilding the task table the old way.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, summary TEXT,
        summary_source TEXT, summary_updated_at TEXT, description_updated_at TEXT,
        status TEXT NOT NULL DEFAULT 'Backlog', priority TEXT NOT NULL DEFAULT 'P2',
        position REAL, assignee TEXT, parent_id TEXT REFERENCES task(id),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
    `);
    raw.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schema_version', '6');
    raw.prepare(
      'INSERT INTO task(id,title,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    ).run('T-1', 'legacy', 'Backlog', 1, '2020-01-01', '2020-01-01');
    raw.close();

    const db = openDb(dbPath); // migrate() runs
    const cols = (db.prepare('PRAGMA table_info(task)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['checkpoint', 'checkpoint_at', 'checkpoint_by']));
    expect(db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')).toEqual({
      value: String(SCHEMA_VERSION),
    });
    const repo = new Repo(db);
    expect(repo.getTask('T-1')!.checkpoint).toBeNull();
    expect(repo.setCheckpoint('T-1', 'works post-migration').checkpoint).toBe('works post-migration');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
