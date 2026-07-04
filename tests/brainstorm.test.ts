import { describe, it, expect, afterEach } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client, type TestServer } from './helpers';
import { renderBrainstorm, renderBrainstormList, renderContext } from '../src/server/render';
import { boardPaths } from '../src/shared/board-paths';
import { runTool } from '../src/mcp/tools';
import type { Conn } from '../src/cli/board';

describe('repo: brainstorm lifecycle', () => {
  it('starts a session (optionally anchored), adds ideas, closes', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'anchor' });
    const s = repo.startBrainstorm('auth approaches', { task: t.id });
    expect(s.id).toBe('B-1');
    expect(s.status).toBe('open');
    expect(s.task_id).toBe(t.id);
    const i = repo.addIdea(s.id, 'use oauth', { cluster: 'managed' });
    expect(i.id).toBe('I-1');
    expect(i.cluster).toBe('managed');
    const closed = repo.closeBrainstorm(s.id);
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).toBeTruthy();
    // Closing again is idempotent (no event, no error).
    const seq = repo.maxSeq();
    repo.closeBrainstorm(s.id);
    expect(repo.maxSeq()).toBe(seq);
  });

  it('rejects ideas on a closed session, empty/oversized text, bad anchor', () => {
    const repo = makeRepo();
    expect(() => repo.startBrainstorm('x', { task: 'T-99' })).toThrow(/not found/);
    const s = repo.startBrainstorm('x');
    expect(() => repo.addIdea(s.id, '   ')).toThrow(/needs text/);
    expect(() => repo.addIdea(s.id, 'y'.repeat(2001))).toThrow(/exceeds 2000/);
    repo.closeBrainstorm(s.id);
    expect(() => repo.addIdea(s.id, 'too late')).toThrow(/closed/);
  });

  it('updates ideas: score bounds, cluster, text, one-way discard', () => {
    const repo = makeRepo();
    const s = repo.startBrainstorm('x');
    const i = repo.addIdea(s.id, 'first');
    expect(() => repo.updateIdea(i.id, { score: 11 })).toThrow(/0–10/);
    expect(() => repo.updateIdea(i.id, { score: 2.5 })).toThrow(/0–10/);
    expect(repo.updateIdea(i.id, { score: 7 }).score).toBe(7);
    expect(repo.updateIdea(i.id, { score: null }).score).toBeNull();
    expect(repo.updateIdea(i.id, { cluster: 'a' }).cluster).toBe('a');
    expect(repo.updateIdea(i.id, { text: 'renamed' }).text).toBe('renamed');
    const dropped = repo.updateIdea(i.id, { discard: true });
    expect(dropped.status).toBe('discarded');
    expect(() => repo.updateIdea(i.id, { score: 5 })).toThrow(/discarded/);
  });

  it('promotes atomically: task exists iff the idea is promoted, with provenance', () => {
    const repo = makeRepo();
    const s = repo.startBrainstorm('naming');
    const i = repo.addIdea(s.id, 'call it zumba');
    const { idea, task } = repo.promoteIdea(i.id, { priority: 'P1' });
    expect(idea.status).toBe('promoted');
    expect(idea.promoted_task_id).toBe(task.id);
    expect(task.title).toBe('call it zumba');
    expect(task.priority).toBe('P1');
    expect(task.description).toContain(`promoted from idea ${i.id}`);
    expect(task.description).toContain(s.id);
    // Frozen after promotion — no re-promote, no edits.
    expect(() => repo.promoteIdea(i.id)).toThrow(/already promoted/);
    expect(() => repo.updateIdea(i.id, { score: 9 })).toThrow(/promoted/);
    // Title override wins.
    const i2 = repo.addIdea(s.id, 'raw idea text');
    const r2 = repo.promoteIdea(i2.id, { title: 'polished title' });
    expect(r2.task.title).toBe('polished title');
    // Events: promoted event carries the new task id for watch routing.
    const ev = repo.changes(0).find((e) => e.type === 'idea.promoted')!;
    expect(ev.task_id).toBe(task.id);
    expect(ev.payload.idea_id).toBe(i.id);
  });

  it('orders ideas best-first and records the event trail', () => {
    const repo = makeRepo();
    const s = repo.startBrainstorm('ranking');
    const a = repo.addIdea(s.id, 'low');
    const b = repo.addIdea(s.id, 'high');
    const c = repo.addIdea(s.id, 'unscored');
    repo.updateIdea(a.id, { score: 2 });
    repo.updateIdea(b.id, { score: 9 });
    expect(repo.getIdeas(s.id).map((i) => i.id)).toEqual([b.id, a.id, c.id]);
    const types = repo.changes(0).map((e) => e.type);
    expect(types).toContain('brainstorm.started');
    expect(types).toContain('idea.added');
    expect(types).toContain('idea.updated');
  });

  it('ideas surface in board search (any status)', () => {
    const repo = makeRepo();
    const s = repo.startBrainstorm('search me');
    const i = repo.addIdea(s.id, 'a wombat-powered cache');
    let hits = repo.search('wombat');
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe('idea');
    expect(hits[0].title).toBe('search me'); // session topic as context
    repo.updateIdea(i.id, { discard: true });
    expect(repo.search('wombat')).toHaveLength(1); // discarded = still prior art
    // Edited text re-indexes.
    const i2 = repo.addIdea(s.id, 'plain idea');
    repo.updateIdea(i2.id, { text: 'now with axolotl' });
    expect(repo.search('axolotl')).toHaveLength(1);
  });
});

describe('render: brainstorm tiers', () => {
  it('groups by cluster (best cluster first), flags promoted/discarded, budgets', () => {
    const repo = makeRepo();
    const s = repo.startBrainstorm('big session');
    const good = repo.addIdea(s.id, 'winner idea', { cluster: 'gold' });
    repo.updateIdea(good.id, { score: 9 });
    const meh = repo.addIdea(s.id, 'weak idea', { cluster: 'bronze' });
    repo.updateIdea(meh.id, { score: 1 });
    const { task } = repo.promoteIdea(good.id);
    const dropped = repo.addIdea(s.id, 'bad idea', { cluster: 'bronze' });
    repo.updateIdea(dropped.id, { discard: true });

    const out = renderBrainstorm(repo, s.id);
    expect(out.indexOf('gold:')).toBeLessThan(out.indexOf('bronze:'));
    expect(out).toContain(`→ ${task.id}`);
    expect(out).toContain('✕ discarded');
    expect(out).toContain('promoted 1');

    const tight = renderBrainstorm(repo, s.id, { maxTokens: 10 });
    expect(tight).toContain('cluster(s) hidden for token budget');
  });

  it('renders the list tier and the context anchor line', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'host' });
    const s = repo.startBrainstorm('anchored session', { task: t.id });
    repo.addIdea(s.id, 'one');
    expect(renderBrainstormList(repo, repo.listBrainstorms({}))).toContain('1 ideas · 0 promoted');
    const ctx = renderContext(repo, t.id);
    expect(ctx).toContain(`brainstorm: ${s.id} "anchored session" (1 ideas · 0 promoted)`);
    // Closed sessions drop off the context anchor.
    repo.closeBrainstorm(s.id);
    expect(renderContext(repo, t.id)).not.toContain('brainstorm:');
    expect(renderBrainstormList(repo, [])).toBe('(no brainstorms)');
  });
});

describe('REST + MCP: brainstorm end to end', () => {
  let h: TestServer;
  afterEach(async () => {
    if (h) await stopTestServer(h);
  });

  it('drives the full session lifecycle over REST', async () => {
    h = await startTestServer();
    const c = client(h);
    const s = (await c('POST', '/api/brainstorms', { topic: 'transport choice' })).body;
    expect(s.id).toMatch(/^B-\d+$/);

    const i = (await c('POST', `/api/brainstorms/${s.id}/ideas`, { text: 'grpc', cluster: 'binary' })).body;
    expect((await c('PATCH', `/api/ideas/${i.id}`, { score: 8 })).body.score).toBe(8);
    expect((await c('PATCH', `/api/ideas/${i.id}`, { score: 99 })).status).toBe(400);

    const show = await c('GET', `/api/brainstorms/${s.id}`);
    expect(show.body.text).toContain('binary:');
    const json = await c('GET', `/api/brainstorms/${s.id}?json=1`);
    expect(json.body.ideas).toHaveLength(1);

    const promoted = await c('POST', `/api/ideas/${i.id}/promote`, { task: { priority: 'P2' } });
    expect(promoted.body.task.id).toMatch(/^T-\d+$/);
    expect(promoted.body.idea.status).toBe('promoted');

    expect((await c('POST', `/api/brainstorms/${s.id}/close`)).body.status).toBe('closed');
    expect((await c('POST', `/api/brainstorms/${s.id}/ideas`, { text: 'late' })).status).toBe(400);
    expect((await c('GET', '/api/brainstorms?json=1')).body.sessions).toHaveLength(1);
    expect((await c('GET', '/api/brainstorms/B-99')).status).toBe(404);
  });

  it('dispatches every op of the grouped MCP brainstorm tool', async () => {
    h = await startTestServer();
    const conn: Conn = { base: h.url, token: h.token, paths: boardPaths(h.root), agent: 'tester' };

    const ok = async (args: Record<string, unknown>) => {
      const r = await runTool(conn, 'brainstorm', args);
      expect(r.isError, `brainstorm ${JSON.stringify(args)} -> ${r.content[0]?.text}`).toBeFalsy();
      return r.content[0].text;
    };

    const sid = (await ok({ op: 'start', topic: 'cache strategy' })).split(/\s+/)[0];
    expect(sid).toMatch(/^B-\d+$/);
    const iid = (await ok({ op: 'idea_add', id: sid, text: 'write-through' })).split(/\s+/)[0];
    expect(iid).toMatch(/^I-\d+$/);
    expect(await ok({ op: 'idea_score', id: iid, score: 6 })).toContain('scored 6');
    expect(await ok({ op: 'idea_cluster', id: iid, cluster: 'safe' })).toContain('"safe"');
    expect(await ok({ op: 'show', id: sid })).toContain('write-through');
    expect(await ok({ op: 'list' })).toContain(sid);
    const promoted = await ok({ op: 'idea_promote', id: iid, title: 'implement write-through cache' });
    expect(promoted).toMatch(/→ T-\d+/);
    const iid2 = (await ok({ op: 'idea_add', id: sid, text: 'ttl only' })).split(/\s+/)[0];
    expect(await ok({ op: 'idea_discard', id: iid2 })).toContain('discarded');
    expect(await ok({ op: 'close', id: sid })).toContain('closed');

    // Missing-arg guards surface as MCP errors.
    expect((await runTool(conn, 'brainstorm', { op: 'start' })).isError).toBe(true);
    expect((await runTool(conn, 'brainstorm', { op: 'idea_add', id: sid })).isError).toBe(true);
    expect((await runTool(conn, 'brainstorm', { op: 'idea_score', id: iid })).isError).toBe(true);
  });
});
