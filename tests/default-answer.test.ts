import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { makeRepo, tempDir, startTestServer, stopTestServer, client } from './helpers';
import { openDb, SCHEMA_VERSION } from '../src/server/db';
import { Repo, ValidationError } from '../src/server/repo';
import { renderContext } from '../src/server/render';
import { renderInbox } from '../src/cli/format';

const past = () => new Date(Date.now() - 1000).toISOString();
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe('repo: ask --default (default-on-expiry answers)', () => {
  it('stores the default and requires expires-at', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    const q = repo.ask(t.id, 'which?', { options: ['a', 'b'], defaultAnswer: 'a', expiresAt: future() });
    expect(q.default_answer).toBe('a');
    expect(() => repo.ask(t.id, 'no expiry?', { defaultAnswer: 'x' })).toThrow(ValidationError);
  });

  it('rejects a default outside the options set', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    expect(() =>
      repo.ask(t.id, 'which?', { options: ['a', 'b'], defaultAnswer: 'c', expiresAt: future() }),
    ).toThrow(ValidationError);
  });

  it('expiry resolves a defaulted request as answered (never dead-ends)', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    const q = repo.ask(t.id, 'which?', { options: ['a', 'b'], defaultAnswer: 'b', expiresAt: past() });
    const plain = repo.ask(t.id, 'plain?', { expiresAt: past() });
    const r = repo.expireDue();
    expect(r.defaulted).toBe(1);
    expect(r.expired).toBe(1);
    const got = repo.getRequest(q.id)!;
    expect(got.status).toBe('answered');
    expect(got.answer).toBe('b');
    expect(got.answered_by).toBe('system:default');
    expect(repo.getRequest(plain.id)!.status).toBe('expired');
    // Never-silent: the event is input.answered with a defaulted flag, actor system.
    const ev = repo.changes(0).filter((e) => e.type === 'input.answered');
    expect(ev).toHaveLength(1);
    expect(ev[0].actor_type).toBe('system');
    // `kind` rides every input event so delta readers can count watches apart.
    expect(ev[0].payload).toEqual({ request_id: q.id, answer: 'b', defaulted: true, kind: 'question' });
    // The task's needs_input clears — the agent is unblocked.
    expect(repo.getOpenRequests(t.id)).toHaveLength(0);
  });

  it('a human answer before expiry wins; the default never overwrites it', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    const q = repo.ask(t.id, 'which?', { options: ['a', 'b'], defaultAnswer: 'b', expiresAt: past() });
    repo.answer(q.id, 'a', 'phil');
    expect(repo.expireDue().defaulted).toBe(0);
    const got = repo.getRequest(q.id)!;
    expect(got.answer).toBe('a');
    expect(got.answered_by).toBe('phil');
  });
});

describe('render: defaults are visible, answers are flagged', () => {
  it('context open-input line shows the default-on-expiry', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a', status: 'In Progress' });
    repo.ask(t.id, 'which?', { options: ['a', 'b'], defaultAnswer: 'a', expiresAt: future() });
    expect(renderContext(repo, t.id)).toContain('[default on expiry: a]');
  });

  it('inbox marks a defaulted answer', () => {
    const text = renderInbox({
      answered: [
        { id: 'Q-1', task_id: 'T-1', answer: 'b', answered_by: 'system:default' } as any,
        { id: 'Q-2', task_id: 'T-1', answer: 'a', answered_by: 'phil' } as any,
      ],
      cursor: 9,
    });
    expect(text).toContain('Q-1  answered (defaulted): b');
    expect(text).toContain('Q-2  answered: a');
  });
});

describe('server: ask default roundtrip', () => {
  it('accepts default via POST and rejects one without expires_at', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const t = (await c('POST', '/api/tasks', { title: 'a' })).body;
      const ok = await c('POST', `/api/tasks/${t.id}/input-requests`, {
        question: 'which?',
        options: ['a', 'b'],
        default: 'a',
        expires_at: future(),
      });
      expect(ok.status).toBe(200);
      expect(ok.body.default_answer).toBe('a');
      const bad = await c('POST', `/api/tasks/${t.id}/input-requests`, {
        question: 'which?',
        default: 'a',
      });
      expect(bad.status).toBe(400);
    } finally {
      await stopTestServer(h);
    }
  });
});

describe('migration: v8 board gains default_answer', () => {
  it('adds the column to an existing input_request table', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE input_request (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, question TEXT NOT NULL, options TEXT,
        answer_freeform INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
        answer TEXT, answered_by TEXT, created_at TEXT NOT NULL, answered_at TEXT, expires_at TEXT
      );
    `);
    raw.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schema_version', '8');
    raw.close();

    const db = openDb(dbPath);
    const cols = (db.prepare('PRAGMA table_info(input_request)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('default_answer');
    expect(db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')).toEqual({
      value: String(SCHEMA_VERSION),
    });
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
