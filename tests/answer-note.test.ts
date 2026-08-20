import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRepo, startTestServer, stopTestServer, client, tempDir, type TestServer } from './helpers';
import { openDb } from '../src/server/db';
import { Repo } from '../src/server/repo';
import { renderContext, renderShow } from '../src/server/render';
import { renderInbox } from '../src/cli/format';

// `answer` was a single TEXT field, so a decision came back as `lift-it` and the
// reason was lost. It did not matter that time — but answers get quoted in code
// comments, where the reasoning is the part a reader in six months needs.

describe('repo.answer --note', () => {
  it('stores the reason beside the choice', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const q = repo.ask(t.id, 'Redis or Postgres?', { options: ['Redis', 'Postgres'] });
    const r = repo.answer(q.id, 'Postgres', 'user', 'already deployed; Redis is infra for one table');
    expect(r.answer).toBe('Postgres');
    expect(r.answer_note).toBe('already deployed; Redis is infra for one table');
  });

  it('is optional, and blank is stored as no note rather than an empty one', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    expect(repo.answer(repo.ask(t.id, 'a?').id, 'yes', 'user').answer_note).toBeNull();
    expect(repo.answer(repo.ask(t.id, 'b?').id, 'yes', 'user', '   ').answer_note).toBeNull();
  });

  it('rides the input.answered event only when there is one', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const bare = repo.ask(t.id, 'a?');
    repo.answer(bare.id, 'yes', 'user');
    const noted = repo.ask(t.id, 'b?');
    repo.answer(noted.id, 'lift-it', 'user', 'the press decides, not the page');

    const evs = repo.changes(0).filter((e) => e.type === 'input.answered');
    expect((evs[0].payload as any).note).toBeUndefined();
    expect((evs[1].payload as any).note).toBe('the press decides, not the page');
  });

  it('a defaulted answer has no note — nobody was there to give a reason', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const q = repo.ask(t.id, 'a?', { options: ['a', 'b'], expiresAt: new Date(Date.now() - 1000).toISOString(), defaultAnswer: 'a' });
    repo.expireDue();
    const r = repo.getRequest(q.id)!;
    expect(r.answer).toBe('a');
    expect(r.answer_note).toBeNull();
  });
});

describe('the note renders where the answer does', () => {
  it('inbox prints it under the answer', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const q = repo.ask(t.id, 'lift or drop?');
    repo.answer(q.id, 'lift-it', 'user', 'the press decides, not the page');
    const text = renderInbox(repo.inbox(0) as never);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.includes('answered'));
    expect(lines[at]).toContain('lift-it');
    expect(lines[at + 1]).toBe('    why: the press decides, not the page');
  });

  it('show and context carry a decisions block with the reason', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    const q = repo.ask(t.id, 'lift or drop?');
    repo.answer(q.id, 'lift-it', 'user', 'the press decides, not the page');

    for (const text of [renderShow(repo, t.id, { full: true }), renderContext(repo, t.id, { full: true })]) {
      expect(text).toContain('decisions (1):');
      expect(text).toContain(`${q.id} "lift or drop?" → lift-it`);
      expect(text).toContain('why: the press decides, not the page');
    }
  });

  it('a task with no answered questions is unchanged — no empty decisions block', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    repo.ask(t.id, 'still open?');
    expect(renderContext(repo, t.id, { full: true })).not.toContain('decisions');
    expect(renderShow(repo, t.id, { full: true })).not.toContain('decisions');
  });

  it('an answer without a note renders the choice and no dangling why line', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    repo.answer(repo.ask(t.id, 'a?').id, 'yes', 'user');
    const text = renderContext(repo, t.id, { full: true });
    expect(text).toContain('→ yes');
    expect(text).not.toContain('why:');
  });

  it('the decisions block sheds under a tight budget, never silently', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    repo.answer(repo.ask(t.id, 'a very long question '.repeat(20)).id, 'yes', 'user', 'a long reason '.repeat(20));
    const tight = renderShow(repo, t.id, { maxTokens: 40 });
    expect(tight).not.toContain('a long reason');
    expect(tight).toContain('hidden'); // the open-input rung's never-silent footer
  });
});

describe('answer notes over REST', () => {
  let h: TestServer;
  afterEach(async () => {
    if (h) await stopTestServer(h);
  });

  it('POST answer takes a note and inbox returns it', async () => {
    h = await startTestServer();
    const c = client(h);
    const t = (await c('POST', '/api/tasks', { title: 't' })).body;
    const q = (await c('POST', `/api/tasks/${t.id}/input-requests`, { question: 'lift or drop?' })).body;
    const r = (await c('POST', `/api/input-requests/${q.id}/answer`, {
      answer: 'lift-it',
      answered_by: 'user',
      note: 'the press decides',
    })).body;
    expect(r.answer_note).toBe('the press decides');
    expect((await c('GET', '/api/inbox')).body.answered[0].answer_note).toBe('the press decides');
  });
});

describe('migration: a v12 board gains answer notes with no data loss', () => {
  it('existing answers keep their choice and simply have no note', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    let repo = new Repo(openDb(dbPath));
    const t = repo.createTask({ title: 'host' });
    const q = repo.ask(t.id, 'which?', { options: ['a', 'b'] });
    repo.answer(q.id, 'b', 'user', 'because b');
    const open = repo.ask(t.id, 'still open?');

    repo.db.exec(`
      ALTER TABLE input_request DROP COLUMN answer_note;
      INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '12');
    `);
    repo.db.close();

    repo = new Repo(openDb(dbPath));
    const migrated = repo.getRequest(q.id)!;
    expect(migrated.answer).toBe('b');
    expect(migrated.answered_by).toBe('user');
    expect(migrated.options).toEqual(['a', 'b']);
    expect(migrated.answer_note).toBeNull(); // the note itself is gone with the column
    expect(repo.getRequest(open.id)!.status).toBe('open');
    // …and notes work on the migrated board.
    expect(repo.answer(open.id, 'yes', 'user', 'now with a reason').answer_note).toBe('now with a reason');

    const v = repo.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(v.value)).toBeGreaterThanOrEqual(13);
    repo.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
