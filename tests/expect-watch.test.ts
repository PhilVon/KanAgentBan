import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRepo, startTestServer, stopTestServer, client, tempDir, type TestServer } from './helpers';
import { openDb } from '../src/server/db';
import { Repo } from '../src/server/repo';
import { runDoctor } from '../src/server/doctor';
import { deriveState } from '../src/server/derive';
import { standup } from '../src/server/standup';
import { renderContext, renderStandup } from '../src/server/render';
import { renderInbox } from '../src/cli/format';
import { runTool } from '../src/mcp/tools';
import { boardPaths } from '../src/shared/board-paths';
import type { Conn } from '../src/cli/board';

// `ask` had one shape and two jobs. A question is a decision with an answer to
// choose and rightly parks the task needs_input; a watch ("tell me when X
// happens") has no answer to choose, and written as a question it set
// needs_input, the UI derived Blocked from that, and it sat for days looking like
// something the human had failed to do — with every remedy doctor offered wrong
// for it. These tests pin the distinction rather than the wording.

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('repo.expect: a watch is not a question', () => {
  it('creates an open request of kind watch', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'audio drop', status: 'In Progress', criteria: ['x'] });
    const w = repo.expect(t.id, "the producer's seventeen files land in public/audio/");
    expect(w.kind).toBe('watch');
    expect(w.status).toBe('open');
    expect(w.options).toBeNull();
    expect(repo.getOpenRequests(t.id).map((r) => r.id)).toEqual([w.id]);
  });

  it('does not set needs_input, so the task does not render Blocked', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'audio drop', status: 'In Progress', criteria: ['x'] });
    repo.expect(t.id, 'the files land');
    const d = deriveState(repo.db, repo.requireTask(t.id));
    expect(d.needs_input).toBe(false);
    expect(d.ready).toBe(true); // still workable, and still recommendable
  });

  it('a question on the same task still blocks — and a watch beside it does not rescue it', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'both', status: 'In Progress', criteria: ['x'] });
    repo.expect(t.id, 'the files land');
    const q = repo.ask(t.id, 'which encoder?');
    expect(deriveState(repo.db, repo.requireTask(t.id)).needs_input).toBe(true);
    repo.answer(q.id, 'ffmpeg', 'user');
    // The watch is still open, and the task is unblocked again.
    expect(repo.getOpenRequests(t.id).map((r) => r.kind)).toEqual(['watch']);
    expect(deriveState(repo.db, repo.requireTask(t.id)).needs_input).toBe(false);
  });

  it('rejects answer-shaping flags rather than ignoring them', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    expect(() => repo.ask(t.id, 'x', { kind: 'watch', options: ['a', 'b'] })).toThrow(/nothing to choose/);
    expect(() => repo.ask(t.id, 'x', { kind: 'watch', freeform: true })).toThrow(/nothing to choose/);
    expect(() => repo.ask(t.id, 'x', { kind: 'nonsense' as never })).toThrow(/invalid request kind/);
  });

  it('answer resolves a watch and cancel withdraws it', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const happened = repo.expect(t.id, 'the files land');
    expect(repo.answer(happened.id, 'all seventeen arrived', 'user').status).toBe('answered');

    const dropped = repo.expect(t.id, 'the second batch lands');
    expect(repo.cancel(dropped.id).status).toBe('cancelled');
    expect(repo.getOpenRequests(t.id)).toEqual([]);
  });

  it('an expiry sweep drops a past-due watch like any other request', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const w = repo.expect(t.id, 'the files land', { expiresAt: iso(HOUR) });
    expect(repo.expireDue()).toEqual({ expired: 1, defaulted: 0 });
    expect(repo.getRequest(w.id)!.status).toBe('expired');
  });

  it('every input event carries the kind, so delta readers can tell them apart', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const w = repo.expect(t.id, 'the files land');
    repo.answer(w.id, 'happened', 'user');
    const kinds = repo
      .changes(0)
      .filter((e) => e.type.startsWith('input.'))
      .map((e) => (e.payload as any).kind);
    expect(kinds).toEqual(['watch', 'watch']);
  });
});

describe('watches in the reads', () => {
  it('inbox lists watches under their own heading, apart from open questions', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    repo.ask(t.id, 'which encoder?');
    repo.expect(t.id, 'the files land');
    const box = repo.inbox();
    expect(box.open.map((r) => r.kind)).toEqual(['question']);
    expect(box.watching.map((r) => r.kind)).toEqual(['watch']);

    const text = renderInbox(box as never);
    expect(text).toContain('watching (1)');
    expect(text).toContain('waiting for an event, not for you');
    // The watch must not appear on an `open:` line — that is the confusion.
    for (const line of text.split('\n').filter((l) => l.includes('open:')))
      expect(line).not.toContain('the files land');
  });

  it('context tags an open watch and says it is not blocking', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    repo.expect(t.id, 'the files land');
    const text = renderContext(repo, t.id, { full: true });
    expect(text).toContain('[watch]');
    expect(text).toContain('not blocking');
  });

  it('standup counts watches separately from question traffic', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    repo.ask(t.id, 'which encoder?');
    const w = repo.expect(t.id, 'the files land');
    repo.cancel(w.id);

    const r = standup(repo, { since: 0 });
    expect(r.asked.map((a) => a.question)).toEqual(['which encoder?']);
    expect(r.watched.map((a) => a.event)).toEqual(['the files land']);
    expect(r.resolved).toEqual([]); // the cancel was a watch, not a question
    expect(r.watch_resolved.map((x) => x.status)).toEqual(['cancelled']);

    const text = renderStandup(r, { full: true });
    expect(text).toContain('watching (1)');
    expect(text).toContain('watch resolutions (1)');
  });
});

describe('doctor and watches', () => {
  it('ancient-ask ignores a watch, however long it has been open', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const w = repo.expect(t.id, 'the files land');
    repo.db.prepare('UPDATE input_request SET created_at = ? WHERE id = ?').run(iso(5 * DAY), w.id);
    const f = runDoctor(repo).findings;
    expect(f.filter((x) => x.check === 'ancient-ask')).toEqual([]);
    // 5 days is ancient for a question and unremarkable for a watch.
    expect(f.filter((x) => x.check === 'stale-watch')).toEqual([]);
  });

  it('stale-watch fires only past a far longer threshold, and names its blind spot', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', criteria: ['x'] });
    const w = repo.expect(t.id, 'the files land');
    repo.db.prepare('UPDATE input_request SET created_at = ? WHERE id = ?').run(iso(20 * DAY), w.id);
    const f = runDoctor(repo).findings.find((x) => x.check === 'stale-watch')!;
    expect(f.id).toBe(w.id);
    expect(f.detail).toContain('threshold 14d');
    expect(f.detail).not.toMatch(/nudge|re-ask/); // none of those fit a watch
    expect(f.blind_spot).toContain('cannot see whether the event happened');
  });

  it('answered-elsewhere is about questions, not watches', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    repo.expect(t.id, 'the files land');
    repo.moveTask(t.id, 'Done');
    expect(runDoctor(repo).findings.filter((x) => x.check === 'answered-elsewhere')).toEqual([]);
  });

  it('a board whose only open request is a watch is healthy', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', criteria: ['x'] });
    repo.expect(t.id, 'the files land');
    const r = runDoctor(repo);
    expect(r.healthy).toBe(true); // the finding this board could not get clean
  });
});

describe('expect over REST and MCP', () => {
  let h: TestServer;
  afterEach(async () => {
    if (h) await stopTestServer(h);
  });

  it('POST kind=watch creates a non-blocking request the board view does not call Blocked', async () => {
    h = await startTestServer();
    const c = client(h);
    const t = (await c('POST', '/api/tasks', { title: 'audio drop', status: 'In Progress' })).body;
    const w = (await c('POST', `/api/tasks/${t.id}/input-requests`, {
      question: 'the files land',
      kind: 'watch',
    })).body;
    expect(w.kind).toBe('watch');

    const board = (await c('GET', '/api/ui/board')).body;
    const card = board.tasks.find((x: any) => x.id === t.id);
    expect(card.column).toBe('In Progress'); // NOT the derived Blocked
    expect(card.open_input).toBe(1); // still visible — parked, not hidden

    const box = (await c('GET', '/api/inbox')).body;
    expect(box.open).toEqual([]);
    expect(box.watching).toHaveLength(1);
  });

  it('the MCP expect tool creates a watch and says it does not block', async () => {
    h = await startTestServer();
    const conn: Conn = { base: h.url, token: h.token, paths: boardPaths(h.root), agent: 'tester' };
    const c = client(h);
    const t = (await c('POST', '/api/tasks', { title: 'audio drop' })).body;
    const r = await runTool(conn, 'expect', { id: t.id, event: 'the files land' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('not blocking');
  });
});

describe('migration: a v10 board gains request kind with no data loss', () => {
  it('every pre-existing request becomes a question, values intact', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    let repo = new Repo(openDb(dbPath));
    const t = repo.createTask({ title: 'host', status: 'In Progress' });
    const open = repo.ask(t.id, 'which encoder?', { options: ['a', 'b'] });
    const done = repo.ask(t.id, 'answered one', { freeform: true });
    repo.answer(done.id, 'yes', 'user');

    // Simulate a v10 board: drop the column, restate the version.
    repo.db.exec(`
      ALTER TABLE input_request DROP COLUMN kind;
      INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '10');
    `);
    repo.db.close();

    repo = new Repo(openDb(dbPath)); // migrate() adds the column with its default
    const migrated = repo.getRequest(open.id)!;
    expect(migrated.kind).toBe('question'); // which is what it was
    expect(migrated.question).toBe('which encoder?');
    expect(migrated.options).toEqual(['a', 'b']);
    expect(migrated.status).toBe('open');

    const answered = repo.getRequest(done.id)!;
    expect(answered.kind).toBe('question');
    expect(answered.answer).toBe('yes');
    expect(answered.answer_freeform).toBe(true);

    // A question still blocks after the migration, and expect still works.
    expect(deriveState(repo.db, repo.requireTask(t.id)).needs_input).toBe(true);
    expect(repo.expect(t.id, 'the files land').kind).toBe('watch');

    const v = repo.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(v.value)).toBeGreaterThanOrEqual(11);
    repo.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
