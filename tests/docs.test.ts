import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRepo, startTestServer, stopTestServer, client, tempDir, type TestServer } from './helpers';
import { openDb, SCHEMA_VERSION } from '../src/server/db';
import { MAX_DOC_BODY_BYTES } from '../src/server/repo';
import { renderContext, renderDoc, renderDocList } from '../src/server/render';
import { boardPaths } from '../src/shared/board-paths';
import { runTool } from '../src/mcp/tools';
import type { Conn } from '../src/cli/board';

describe('repo: docs', () => {
  it('creates docs with kind-dependent default status', () => {
    const repo = makeRepo();
    const adr = repo.createDoc({ kind: 'adr', title: 'use FTS5' });
    const note = repo.createDoc({ kind: 'research', title: 'sqlite fts notes' });
    expect(adr.id).toBe('D-1');
    expect(adr.status).toBe('draft');
    expect(note.status).toBe('active');
    expect(repo.createDoc({ kind: 'note', title: 'n' }).status).toBe('active');
    expect(repo.createDoc({ kind: 'design', title: 'd' }).status).toBe('draft');
  });

  it('rejects an unknown kind and an unknown status', () => {
    const repo = makeRepo();
    expect(() => repo.createDoc({ kind: 'memo', title: 'x' })).toThrow(/invalid doc kind/);
    expect(() => repo.createDoc({ kind: 'note', title: 'x', status: 'shipped' })).toThrow(/invalid doc status/);
    const d = repo.createDoc({ kind: 'note', title: 'x' });
    expect(() => repo.updateDoc(d.id, { status: 'shipped' as any })).toThrow(/invalid doc status/);
  });

  it('caps the body at MAX_DOC_BODY_BYTES on create and update', () => {
    const repo = makeRepo();
    const big = 'x'.repeat(MAX_DOC_BODY_BYTES + 1);
    expect(() => repo.createDoc({ kind: 'note', title: 'big', body: big })).toThrow(/exceeds/);
    const d = repo.createDoc({ kind: 'note', title: 'ok', body: 'small' });
    expect(() => repo.updateDoc(d.id, { body: big })).toThrow(/exceeds/);
  });

  it('links docs to tasks at creation, idempotently, and unlinks', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a task' });
    const d = repo.createDoc({ kind: 'design', title: 'design', links: [t.id] });
    expect(repo.getTaskDocs(t.id).map((x) => x.id)).toEqual([d.id]);
    expect(repo.getDocTasks(d.id)).toEqual([t.id]);

    const before = repo.maxSeq();
    repo.linkDoc(d.id, t.id); // idempotent — no duplicate event
    expect(repo.maxSeq()).toBe(before);

    repo.unlinkDoc(d.id, t.id);
    expect(repo.getTaskDocs(t.id)).toEqual([]);
    // Unlinking again is a no-op with no event.
    const after = repo.maxSeq();
    repo.unlinkDoc(d.id, t.id);
    expect(repo.maxSeq()).toBe(after);
  });

  it('rejects linking a missing doc or task', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const d = repo.createDoc({ kind: 'note', title: 'n' });
    expect(() => repo.linkDoc('D-99', t.id)).toThrow(/not found/);
    expect(() => repo.linkDoc(d.id, 'T-99')).toThrow(/not found/);
  });

  it('updates fields; superseded_by must exist, differ, and implies status', () => {
    const repo = makeRepo();
    const v1 = repo.createDoc({ kind: 'adr', title: 'v1' });
    const v2 = repo.createDoc({ kind: 'adr', title: 'v2' });
    expect(() => repo.updateDoc(v1.id, { superseded_by: v1.id })).toThrow(/supersede itself/);
    expect(() => repo.updateDoc(v1.id, { superseded_by: 'D-99' })).toThrow(/not found/);
    const upd = repo.updateDoc(v1.id, { superseded_by: v2.id });
    expect(upd.status).toBe('superseded');
    expect(upd.superseded_by).toBe(v2.id);
  });

  it('records doc events: created/updated carry doc_id, linked/unlinked carry task_id', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const d = repo.createDoc({ kind: 'spike', title: 's', links: [t.id] });
    repo.updateDoc(d.id, { summary: 'short' });
    repo.unlinkDoc(d.id, t.id);
    const types = repo.changes(0).map((e) => e.type);
    expect(types).toContain('doc.created');
    expect(types).toContain('doc.linked');
    expect(types).toContain('doc.updated');
    expect(types).toContain('doc.unlinked');
    const linked = repo.changes(0).find((e) => e.type === 'doc.linked')!;
    expect(linked.task_id).toBe(t.id); // watch/drawer routing keys off task_id
    expect(linked.payload.doc_id).toBe(d.id);
    const created = repo.changes(0).find((e) => e.type === 'doc.created')!;
    expect(created.task_id).toBeNull();
  });

  it('filters listDocs by kind/status/task and hides archived docs', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    repo.createDoc({ kind: 'adr', title: 'a1', status: 'accepted' });
    const d2 = repo.createDoc({ kind: 'research', title: 'r1', links: [t.id] });
    expect(repo.listDocs({ kind: 'adr' }).map((d) => d.title)).toEqual(['a1']);
    expect(repo.listDocs({ status: 'accepted' }).map((d) => d.title)).toEqual(['a1']);
    expect(repo.listDocs({ task: t.id }).map((d) => d.title)).toEqual(['r1']);
    repo.archiveDoc(d2.id);
    expect(repo.listDocs({}).map((d) => d.title)).toEqual(['a1']);
    expect(repo.getTaskDocs(t.id)).toEqual([]);
  });

  it('includes docs (with task links) in the export snapshot', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    repo.createDoc({ kind: 'note', title: 'n', links: [t.id] });
    const snap = repo.snapshot() as any;
    expect(snap.docs).toHaveLength(1);
    expect(snap.docs[0].tasks).toEqual([t.id]);
  });
});

describe('migration: v3 board gains doc tables', () => {
  it('upgrades an existing board to SCHEMA_VERSION with doc/doc_link created', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    // Build a "v3" board: current schema minus the doc tables, stamped v3.
    const db = openDb(dbPath);
    db.exec('DROP TABLE doc; DROP TABLE doc_link;');
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '3')").run();
    db.close();

    const upgraded = openDb(dbPath); // migrate() runs
    const tables = (
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain('doc');
    expect(tables).toContain('doc_link');
    const v = upgraded.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    upgraded.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('render: doc tiers', () => {
  it('doc show sheds the body tail under budget with a never-silent footer', () => {
    const repo = makeRepo();
    const body = Array.from({ length: 400 }, (_, i) => `line ${i} of a long design doc`).join('\n');
    const d = repo.createDoc({ kind: 'design', title: 'big doc', summary: 'abstract', body });
    const out = renderDoc(repo, d.id, { maxTokens: 200 });
    expect(out).toContain('[body trimmed:');
    expect(out).toContain(`doc show ${d.id} --full`);
    expect(out.length / 4).toBeLessThan(300); // roughly within budget
    // --full opts out entirely.
    expect(renderDoc(repo, d.id, { full: true })).toContain('line 399');
    // Default budget applies without options (ADR 0007 guard rail).
    const defaulted = renderDoc(repo, d.id);
    expect(defaulted).toContain('[body trimmed:');
  });

  it('renders (no body) and the doc list one-line tier', () => {
    const repo = makeRepo();
    const d = repo.createDoc({ kind: 'adr', title: 'no body yet', summary: 'sum' });
    expect(renderDoc(repo, d.id)).toContain('(no body)');
    const list = renderDocList(repo.listDocs({}));
    expect(list).toContain(d.id);
    expect(list).toContain('[adr/draft]');
    expect(list).toContain('— sum');
    expect(renderDocList([])).toBe('(no docs)');
  });

  it('context gains a docs section with titles + summaries only', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'work' });
    repo.createDoc({
      kind: 'adr',
      title: 'the decision',
      summary: 'what we decided',
      body: 'SECRET-BODY-CONTENT should not render in context',
      links: [t.id],
    });
    const ctx = renderContext(repo, t.id);
    expect(ctx).toContain('docs (1):');
    expect(ctx).toContain('the decision');
    expect(ctx).toContain('what we decided');
    expect(ctx).not.toContain('SECRET-BODY-CONTENT');
  });
});

describe('REST + MCP: docs end to end', () => {
  let h: TestServer;
  afterEach(async () => {
    if (h) await stopTestServer(h);
  });

  it('drives the full doc lifecycle over REST', async () => {
    h = await startTestServer();
    const c = client(h);
    const task = (await c('POST', '/api/tasks', { title: 't' })).body;

    const create = await c('POST', '/api/docs', {
      kind: 'adr',
      title: 'store content',
      summary: 'docs store content',
      body: '# ADR\ncontent here',
      links: [task.id],
    });
    expect(create.status).toBe(200);
    const d = create.body;
    expect(d.id).toMatch(/^D-\d+$/);
    expect(d.status).toBe('draft');

    // List: text + json (json rows never carry bodies).
    const listText = await c('GET', '/api/docs');
    expect(listText.body.text).toContain(d.id);
    const listJson = await c('GET', '/api/docs?json=1');
    expect(listJson.body.docs[0].body).toBeUndefined();
    expect(listJson.body.est_tokens).toBeGreaterThan(0);

    // Show: text carries the body; json carries body + linked tasks.
    const show = await c('GET', `/api/docs/${d.id}`);
    expect(show.body.text).toContain('content here');
    const showJson = await c('GET', `/api/docs/${d.id}?json=1`);
    expect(showJson.body.body).toContain('content here');
    expect(showJson.body.tasks).toEqual([task.id]);

    // Update status; then supersede.
    const accepted = await c('PATCH', `/api/docs/${d.id}`, { status: 'accepted' });
    expect(accepted.body.status).toBe('accepted');

    // Task detail (drawer/context json) lists the doc without its body.
    const detail = await c('GET', `/api/ui/tasks/${task.id}`);
    expect(detail.body.docs).toHaveLength(1);
    expect(detail.body.docs[0].id).toBe(d.id);
    expect(detail.body.docs[0].body).toBeUndefined();

    // UI panel list carries linked task ids.
    const ui = await c('GET', '/api/ui/docs');
    expect(ui.body.docs[0].tasks).toEqual([task.id]);

    // Unlink + archive.
    expect((await c('DELETE', `/api/docs/${d.id}/links?task=${task.id}`)).status).toBe(200);
    expect((await c('POST', `/api/docs/${d.id}/archive`)).status).toBe(200);
    expect((await c('GET', '/api/docs?json=1')).body.docs).toHaveLength(0);
  });

  it('validates over REST: bad kind 400, missing doc 404, oversized body 400', async () => {
    h = await startTestServer();
    const c = client(h);
    expect((await c('POST', '/api/docs', { kind: 'memo', title: 'x' })).status).toBe(400);
    expect((await c('GET', '/api/docs/D-99')).status).toBe(404);
    const big = 'x'.repeat(MAX_DOC_BODY_BYTES + 1);
    expect((await c('POST', '/api/docs', { kind: 'note', title: 'big', body: big })).status).toBe(400);
  });

  it('dispatches every op of the grouped MCP doc tool', async () => {
    h = await startTestServer();
    const conn: Conn = { base: h.url, token: h.token, paths: boardPaths(h.root), agent: 'tester' };
    const c = client(h);
    const task = (await c('POST', '/api/tasks', { title: 't' })).body;

    const ok = async (args: Record<string, unknown>) => {
      const r = await runTool(conn, 'doc', args);
      expect(r.isError, `doc ${JSON.stringify(args)} -> ${r.content[0]?.text}`).toBeFalsy();
      return r.content[0].text;
    };

    const added = await ok({ op: 'add', kind: 'research', title: 'findings', body: 'useful', summary: 's' });
    const id = added.split(/\s+/)[0];
    expect(id).toMatch(/^D-\d+$/);
    expect(added).toContain('[research/active]');

    expect(await ok({ op: 'link', id, task: task.id })).toContain(task.id);
    expect(await ok({ op: 'show', id })).toContain('useful');
    expect(await ok({ op: 'list', kind: 'research' })).toContain(id);
    expect(await ok({ op: 'update', id, status: 'active', summary: 's2' })).toContain('updated');
    expect(await ok({ op: 'unlink', id, task: task.id })).toContain(task.id);

    // Missing-arg guards surface as MCP errors, not throws.
    expect((await runTool(conn, 'doc', { op: 'add', title: 'no kind' })).isError).toBe(true);
    expect((await runTool(conn, 'doc', { op: 'show' })).isError).toBe(true);
    expect((await runTool(conn, 'doc', { op: 'link', id })).isError).toBe(true);
  });
});
