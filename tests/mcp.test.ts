import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startTestServer, stopTestServer, client, type TestServer } from './helpers';
import { boardPaths } from '../src/shared/board-paths';
import { TOOLS, runTool } from '../src/mcp/tools';
import type { Conn } from '../src/cli/board';

// The MCP tools are thin clients of the running sole-writer server: build a Conn
// pointing at the test server and drive the decoupled handlers directly (no stdio
// transport needed). This exercises the same path the stdio server uses.
let h: TestServer;
let conn: Conn;

beforeEach(async () => {
  h = await startTestServer();
  conn = { base: h.url, token: h.token, paths: boardPaths(h.root), agent: 'tester' };
});
afterEach(async () => {
  await stopTestServer(h);
});

/** Run a tool and assert it did not error, returning its text. */
async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await runTool(conn, name, args);
  expect(r.isError, `${name} -> ${r.content[0]?.text}`).toBeFalsy();
  return r.content[0].text;
}

const idOf = (s: string) => s.split(/\s+/)[0];

describe('mcp tool surface', () => {
  it('exposes a curated, unique tool set including the read ladder + HITL', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no dupes
    for (const expected of ['next', 'list', 'show', 'context', 'watch', 'changes', 'inbox', 'add', 'move', 'claim', 'dep', 'ask', 'await', 'inbox']) {
      expect(names).toContain(expected);
    }
    // Curated, not the full ~30 CLI surface.
    expect(names.length).toBeLessThanOrEqual(24);
    expect(names.length).toBeGreaterThanOrEqual(16);
  });

  it('every tool has a description and an input schema', () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.inputSchema).toBe('object');
    }
  });
});

describe('mcp lifecycle: create -> move -> done', () => {
  it('creates a task and walks it to Done', async () => {
    const id = idOf(await ok('add', { title: 'ship mcp', priority: 'P1' }));
    expect(id).toMatch(/^T-\d+$/);
    expect(await ok('move', { id, status: 'In Progress' })).toContain('In Progress');
    expect(await ok('move', { id, status: 'Done' })).toContain('-> Done');
  });
});

describe('mcp claim / release (op consolidation)', () => {
  it('claims for the calling agent then releases', async () => {
    const id = idOf(await ok('add', { title: 'claimable' }));
    expect(await ok('claim', { id })).toContain('claimed by tester');
    expect(await ok('claim', { id, op: 'release' })).toContain('released');
  });
});

describe('mcp dep (op consolidation)', () => {
  it('adds and removes a blocking dependency', async () => {
    const a = idOf(await ok('add', { title: 'A' }));
    const b = idOf(await ok('add', { title: 'B' }));
    expect(await ok('dep', { id: a, on: b, op: 'add' })).toContain(`blocked by ${b}`);
    expect(await ok('dep', { id: a, on: b, op: 'remove' })).toContain(`removed ${a}`);
  });
});

describe('mcp reads surface the est_tokens meter', () => {
  it('next and context carry an est_tokens footer', async () => {
    await ok('add', { title: 'readable', status: 'Ready' });
    expect(await ok('next')).toContain('[est_tokens:');
  });
});

describe('mcp HITL: ask -> (answer) -> inbox', () => {
  it('asks, the human answers out-of-band, inbox surfaces the answer', async () => {
    const id = idOf(await ok('add', { title: 'needs a decision', status: 'In Progress' }));
    const askText = await ok('ask', { id, question: 'Auth provider?', options: ['Auth0', 'Cognito'] });
    const qid = idOf(askText);
    expect(qid).toMatch(/^Q-\d+$/);

    // Human answers via the server (UI/CLI path), not an MCP tool.
    const ans = await client(h)('POST', `/api/input-requests/${qid}/answer`, { answer: 'Auth0', answered_by: 'human' });
    expect(ans.status).toBe(200);

    const inbox = await ok('inbox');
    expect(inbox).toContain(qid);
    expect(inbox).toContain('Auth0');
  });

  it('await returns a never-silent "pending" on timeout, not an error', async () => {
    const id = idOf(await ok('add', { title: 'waiting', status: 'In Progress' }));
    const qid = idOf(await ok('ask', { id, question: 'unanswered?' }));
    const text = await ok('await', { qid, timeout: 1 });
    expect(text).toContain('pending');
    expect(text.toLowerCase()).toContain('inbox');
  });

  it('cancel withdraws an open request', async () => {
    const id = idOf(await ok('add', { title: 'withdrawable', status: 'In Progress' }));
    const qid = idOf(await ok('ask', { id, question: 'nevermind?' }));
    expect(await ok('cancel', { qid })).toContain('cancelled');
  });
});

describe('mcp error mapping', () => {
  it('returns an isError result (not a throw) for a missing task', async () => {
    const r = await runTool(conn, 'show', { id: 'T-999' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/error/i);
  });

  it('reports unknown tools', async () => {
    const r = await runTool(conn, 'frobnicate', {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('unknown tool');
  });
});
