import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRepo, startTestServer, stopTestServer, client, tempDir, type TestServer } from './helpers';
import { openDb } from '../src/server/db';
import { looseTerms, Repo } from '../src/server/repo';
import { renderSearch } from '../src/server/render';
import { boardPaths } from '../src/shared/board-paths';
import { runTool } from '../src/mcp/tools';
import type { Conn } from '../src/cli/board';

/** Force the LIKE fallback path on an existing repo. */
function disableFts(repo: Repo): void {
  repo.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('fts_enabled', '0')").run();
}

describe('repo.search (FTS5)', () => {
  it('finds tasks by title, description, and summary', () => {
    const repo = makeRepo();
    expect(repo.ftsEnabled()).toBe(true);
    repo.createTask({ title: 'wire up oauth callback' });
    repo.createTask({ title: 'unrelated', description: 'the oauth token exchange' });
    repo.createTask({ title: 'also unrelated', summary: 'oauth provider quirks' });
    repo.createTask({ title: 'nothing here' });
    const hits = repo.search('oauth');
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.type === 'task')).toBe(true);
  });

  it('finds docs (title/summary/body) and comments, with type filter', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'host task' });
    repo.createDoc({ kind: 'research', title: 'sqlite notes', body: 'bm25 ranking explained' });
    repo.addComment(t.id, 'decided to use bm25 after all', 'agent', 'claude');
    const all = repo.search('bm25');
    expect(all.map((h) => h.type).sort()).toEqual(['comment', 'doc']);
    const docsOnly = repo.search('bm25', { type: 'doc' });
    expect(docsOnly).toHaveLength(1);
    expect(docsOnly[0].kind).toBe('research');
    const commentHit = all.find((h) => h.type === 'comment')!;
    expect(commentHit.task_id).toBe(t.id); // links back to the owning task
  });

  it('index tracks updates: edited and archived content', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'original zebra title' });
    expect(repo.search('zebra')).toHaveLength(1);
    repo.updateTask(t.id, { title: 'renamed giraffe title' });
    expect(repo.search('zebra')).toHaveLength(0);
    expect(repo.search('giraffe')).toHaveLength(1);
    repo.archiveTask(t.id);
    expect(repo.search('giraffe')).toHaveLength(0); // archived drops out via trigger

    const d = repo.createDoc({ kind: 'note', title: 'a walrus fact' });
    expect(repo.search('walrus')).toHaveLength(1);
    repo.archiveDoc(d.id);
    expect(repo.search('walrus')).toHaveLength(0);
  });

  it('drops comment hits whose task is archived (query-time liveness)', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    repo.addComment(t.id, 'a very quokka comment', 'agent', 'claude');
    expect(repo.search('quokka')).toHaveLength(1);
    repo.archiveTask(t.id);
    expect(repo.search('quokka')).toHaveLength(0);
  });

  it('survives FTS5 syntax in user input via the quoted-phrase retry', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'weird "quoted" AND (input)' });
    // Raw would be a syntax error / operator soup — retry path must not throw.
    expect(() => repo.search('"quoted" AND (')).not.toThrow();
    expect(repo.search('weird "quoted"').length).toBeGreaterThan(0);
  });

  it('empty/blank query returns nothing; limit caps hits', () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i++) repo.createTask({ title: `pangolin ${i}` });
    expect(repo.search('  ')).toEqual([]);
    expect(repo.search('pangolin', { limit: 2 })).toHaveLength(2);
  });
});

describe('repo.search (LIKE fallback)', () => {
  it('matches substrings across tasks/docs/comments when FTS is off', () => {
    const repo = makeRepo();
    disableFts(repo);
    expect(repo.ftsEnabled()).toBe(false);
    const t = repo.createTask({ title: 'capybara habitat', description: 'riverbank' });
    repo.createDoc({ kind: 'note', title: 'notes', body: 'capybaras are calm' });
    repo.addComment(t.id, 'saw a capybara today', 'agent', 'claude');
    const hits = repo.search('capybara');
    expect(hits.map((h) => h.type).sort()).toEqual(['comment', 'doc', 'task']);
    // Archived still excluded on the fallback path.
    repo.archiveTask(t.id);
    expect(repo.search('capybara').map((h) => h.type).sort()).toEqual(['doc']);
    // LIKE wildcards in the query are escaped, not interpreted.
    expect(repo.search('%').length).toBe(0);
    // Type filter still applies.
    expect(repo.search('capybara', { type: 'comment' })).toHaveLength(0); // task archived
  });
});

describe('loose (OR) fallback', () => {
  let h: TestServer;
  afterEach(async () => {
    if (h) await stopTestServer(h);
  });

  // FTS5 AND-s bare terms, which is right for precision — but a three-word guess
  // then returns nothing, and search is the first thing an agent runs on a cold
  // board. The retry is OR-ranked and says so; it never silently loosens.
  it('retries OR-ranked when nothing matches every term, and marks it loose', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'clipping the polaroid edge' });
    repo.createTask({ title: 'a cut scene' });
    // search() folds the retry in; spell the AND explicitly to see the strict
    // result — an operator query is never rewritten, so this is the unloosened one.
    expect(repo.search('clipping AND cut AND polaroid')).toEqual([]);

    const r = repo.searchBoard('clipping cut polaroid');
    expect(r.loose).toBe(true);
    expect(r.hits.map((h) => h.id).sort()).toEqual(['T-1', 'T-2']);
    // Two terms beat one — bm25 ranks the fuller match first.
    expect(r.hits[0].id).toBe('T-1');
  });

  it('a query that matches every term is never loose', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'clipping the polaroid edge' });
    const r = repo.searchBoard('clipping polaroid');
    expect(r.loose).toBe(false);
    expect(r.hits).toHaveLength(1);
  });

  it('a genuinely empty result stays empty rather than inventing loose hits', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'nothing relevant' });
    const r = repo.searchBoard('kangaroo wombat');
    expect(r.hits).toEqual([]);
    expect(r.loose).toBe(false);
  });

  it('a single term is never rewritten (an OR of one is the same query)', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'lonely' });
    expect(looseTerms('lonely')).toBeNull();
    expect(repo.searchBoard('kangaroo').loose).toBe(false);
  });

  it('a query carrying quotes or FTS operators is never rewritten', () => {
    // The caller wrote a query, not a bag of words — loosening it would answer a
    // different question than the one asked.
    for (const q of ['"clipping cut"', 'clipping OR cut', 'clipping NOT cut', 'title:clipping cut', 'clip* cut', '^clipping cut', '(clipping cut)']) {
      expect(looseTerms(q), q).toBeNull();
    }
    // …but a hyphenated word is one term, not an operator.
    expect(looseTerms('write-through cache')).toEqual(['write-through', 'cache']);
  });

  it('loosens on the LIKE fallback too, ranked by how many terms hit', () => {
    const repo = makeRepo();
    disableFts(repo);
    repo.createTask({ title: 'clipping the polaroid edge' });
    repo.createTask({ title: 'a cut scene' });
    // LIKE matches the literal phrase, so no row contains all three words. Spell
    // the AND out: an operator query is never rewritten, so this is the strict one.
    expect(repo.search('clipping AND cut AND polaroid')).toEqual([]);
    const r = repo.searchBoard('clipping cut polaroid');
    expect(r.loose).toBe(true);
    expect(r.hits[0].id).toBe('T-1'); // matched two terms; T-2 matched one
    expect(r.hits.map((h) => h.id).sort()).toEqual(['T-1', 'T-2']);
  });

  it('renders a loose header above the hits, and nothing when strict', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'clipping the polaroid edge' });
    repo.createTask({ title: 'a cut scene' });
    const q = 'clipping cut polaroid';
    const r = repo.searchBoard(q);
    const text = renderSearch(r.hits, q, { loose: r.loose });
    expect(text.split('\n')[0]).toContain('[loose:');
    expect(text.split('\n')[0]).toContain(q);
    expect(renderSearch(repo.search('polaroid'), 'polaroid')).not.toContain('[loose:');
  });

  it('REST reports loose in the text and under --json', async () => {
    h = await startTestServer();
    const c = client(h);
    await c('POST', '/api/tasks', { title: 'clipping the polaroid edge' });
    await c('POST', '/api/tasks', { title: 'a cut scene' });

    const strict = await c('GET', '/api/search?q=polaroid&json=1');
    expect(strict.body.loose).toBe(false);

    const loose = await c('GET', '/api/search?q=clipping%20cut%20polaroid&json=1');
    expect(loose.body.loose).toBe(true);
    expect(loose.body.results.length).toBe(2);
    expect(loose.body.text).toContain('[loose:');
  });
});

describe('migration: populated v4 board gains a backfilled index', () => {
  it('backfills existing live content once, skipping archived rows', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    // Build a populated board, then strip the search artifacts to simulate v4.
    let repo = new Repo(openDb(dbPath));
    repo.createTask({ title: 'axolotl one' });
    const t2 = repo.createTask({ title: 'axolotl two' });
    repo.createDoc({ kind: 'note', title: 'axolotl care' });
    repo.archiveTask(t2.id);
    repo.db.exec(`
      DROP TRIGGER trg_fts_task_ai; DROP TRIGGER trg_fts_task_au; DROP TRIGGER trg_fts_task_ad;
      DROP TRIGGER trg_fts_doc_ai; DROP TRIGGER trg_fts_doc_au; DROP TRIGGER trg_fts_doc_ad;
      DROP TRIGGER trg_fts_comment_ai; DROP TRIGGER trg_fts_comment_ad;
      DROP TABLE search_index;
      DELETE FROM meta WHERE key = 'fts_enabled';
      INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '4');
    `);
    repo.db.close();

    repo = new Repo(openDb(dbPath)); // migrate() recreates + backfills
    expect(repo.ftsEnabled()).toBe(true);
    const hits = repo.search('axolotl');
    expect(hits.map((h) => h.title).sort()).toEqual(['axolotl care', 'axolotl one']); // archived skipped
    repo.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('render + REST + MCP', () => {
  let h: TestServer;
  afterEach(async () => {
    if (h) await stopTestServer(h);
  });

  it('renderSearch: badges per type, budget footer, empty message', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'ocelot spotting guide' });
    repo.createDoc({ kind: 'adr', title: 'ocelot naming', summary: 's' });
    repo.addComment(t.id, 'ocelot seen again', 'agent', 'claude');
    const out = renderSearch(repo.search('ocelot'), 'ocelot');
    expect(out).toContain('[task/Backlog]');
    expect(out).toContain('[doc/adr]');
    expect(out).toContain(`[comment on ${t.id}]`);
    expect(renderSearch([], 'nope')).toContain('no matches');
    const many = repo.search('ocelot');
    const tight = renderSearch(many, 'ocelot', { maxTokens: 15 });
    expect(tight).toContain('hidden for token budget');
  });

  it('GET /api/search: text + json envelopes, 400 without q', async () => {
    h = await startTestServer();
    const c = client(h);
    await c('POST', '/api/tasks', { title: 'a lemur task' });
    expect((await c('GET', '/api/search')).status).toBe(400);
    const text = await c('GET', '/api/search?q=lemur');
    expect(text.body.text).toContain('lemur');
    const json = await c('GET', '/api/search?q=lemur&json=1');
    expect(json.body.results).toHaveLength(1);
    expect(json.body.fts).toBe(true);
    expect(json.body.est_tokens).toBeGreaterThan(0);
  });

  it('MCP search tool returns budgeted text with the est_tokens meter', async () => {
    h = await startTestServer();
    const conn: Conn = { base: h.url, token: h.token, paths: boardPaths(h.root), agent: 'tester' };
    const c = client(h);
    await c('POST', '/api/tasks', { title: 'a fennec task' });
    const r = await runTool(conn, 'search', { query: 'fennec' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('fennec');
    expect(r.content[0].text).toContain('est_tokens');
  });
});
