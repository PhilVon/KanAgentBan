import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startTestServer,
  stopTestServer,
  client,
  openWs,
  collectMessages,
  sleep,
  type TestServer,
} from './helpers';

let h: TestServer;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  h = await startTestServer();
  api = client(h);
});
afterEach(async () => {
  await stopTestServer(h);
});

describe('server: auth & security', () => {
  it('serves /healthz without a token', async () => {
    const res = await fetch(h.url + '/healthz');
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('rejects API calls without a token (401)', async () => {
    const res = await fetch(h.url + '/api/board');
    expect(res.status).toBe(401);
  });

  it('accepts API calls with the token', async () => {
    const { status } = await api('GET', '/api/board');
    expect(status).toBe(200);
  });

  it('serves static UI assets without a token so the browser can bootstrap', async () => {
    // A browser loading the page cannot send a Bearer header for sub-resource
    // GETs (app.js / style.css), so static assets must be tokenless.
    for (const p of ['/', '/app.js', '/style.css']) {
      const res = await fetch(h.url + p);
      expect(res.status, p).toBe(200);
    }
  });

  it('rejects a non-localhost Origin (403)', async () => {
    const res = await fetch(h.url + '/api/board', {
      headers: { authorization: `Bearer ${h.token}`, origin: 'http://evil.example.com' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a non-loopback Host header — DNS-rebinding defense (403)', async () => {
    // fetch/undici drops a custom Host header, so forge it with a raw request.
    const http = await import('node:http');
    const u = new URL(h.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: '/api/board',
          method: 'GET',
          headers: { authorization: `Bearer ${h.token}`, host: 'evil.example.com' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('rejects a websocket with a foreign Origin (4403)', async () => {
    const wsUrl = h.url.replace('http', 'ws') + `/ws?since=0&token=${h.token}`;
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl, { origin: 'http://evil.example.com' });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4403);
  });
});

describe('server: --json structured reads', () => {
  it('next --json returns the structured recommendation', async () => {
    await api('POST', '/api/tasks', { title: 'do it', status: 'Ready', priority: 'P0' });
    const r = await api('GET', '/api/next?json=1');
    expect(r.status).toBe(200);
    expect(r.body.next[0].task.id).toBe('T-1');
    expect(typeof r.body.next[0].why).toBe('string');
    expect(r.body.est_tokens).toBeGreaterThan(0); // token meter (docs/03 §4)
  });

  it('next --json reports blocked summary when nothing is ready', async () => {
    await api('POST', '/api/tasks', { title: 'blocked', status: 'In Progress' });
    await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });
    const r = await api('GET', '/api/next?json=1');
    expect(r.body.blocked[0]).toEqual({ id: 'T-1', reason: 'needs input' });
  });

  it('show --json returns the task object; context --json returns the working set', async () => {
    await api('POST', '/api/tasks', { title: 'x', priority: 'P2' });
    const show = await api('GET', '/api/tasks/T-1?json=1');
    expect(show.body.task.id).toBe('T-1');
    expect(show.body.text).toBeUndefined();
    expect(show.body.est_tokens).toBeGreaterThan(0);

    const ctx = await api('GET', '/api/tasks/T-1?view=context&json=1');
    expect(ctx.body.task.id).toBe('T-1');
    expect(Array.isArray(ctx.body.criteria)).toBe(true);
    expect(Array.isArray(ctx.body.comments)).toBe(true);
    expect(ctx.body.est_tokens).toBeGreaterThan(0);
  });

  it('list --json carries a token meter', async () => {
    await api('POST', '/api/tasks', { title: 'one', priority: 'P1' });
    const list = await api('GET', '/api/tasks?json=1');
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.est_tokens).toBeGreaterThan(0);
  });
});

describe('server: --max-tokens budgeting across tiers (docs/03 §4)', () => {
  it('list / next / show honor --max-tokens and shrink est_tokens', async () => {
    for (let i = 0; i < 8; i++)
      await api('POST', '/api/tasks', { title: `task ${'Z'.repeat(40)}`, status: 'Ready', priority: 'P1' });

    const listFull = await api('GET', '/api/tasks?json=1');
    const listBudget = await api('GET', '/api/tasks?json=1&max_tokens=30');
    expect(listBudget.body.est_tokens).toBeLessThan(listFull.body.est_tokens);

    const nextFull = await api('GET', '/api/next?json=1&n=5');
    const nextBudget = await api('GET', '/api/next?json=1&n=5&max_tokens=30');
    expect(nextBudget.body.est_tokens).toBeLessThan(nextFull.body.est_tokens);
    expect(nextBudget.body.text).toContain('candidates hidden for token budget');

    await api('POST', '/api/tasks/T-1/comments', { body: 'B'.repeat(300) });
    const showFull = await api('GET', '/api/tasks/T-1?json=1');
    const showBudget = await api('GET', '/api/tasks/T-1?json=1&max_tokens=20');
    expect(showBudget.body.est_tokens).toBeLessThan(showFull.body.est_tokens);
  });

  it('/healthz reports the bumped format_version', async () => {
    const r = await api('GET', '/healthz');
    expect(r.body.format_version).toBe(3);
  });
});

describe('server: scoped await (--task / --any)', () => {
  it('returns {status:"none"} when nothing is open in scope', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const r = await api('GET', '/api/await?task=T-1&timeout=1');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('none');
  });

  it('400 when neither task nor any is given', async () => {
    const r = await api('GET', '/api/await?timeout=1');
    expect(r.status).toBe(400);
  });

  it('--task wakes on an answer to that task (with request_id)', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q = await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });
    const parked = api('GET', '/api/await?task=T-1&timeout=5');
    await sleep(80);
    await api('POST', `/api/input-requests/${q.body.id}/answer`, { answer: 'go' });
    const r = await parked;
    expect(r.status).toBe(200);
    expect(r.body.answer).toBe('go');
    expect(r.body.request_id).toBe(q.body.id);
  });

  it('--any wakes on an answer anywhere', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q = await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });
    const parked = api('GET', '/api/await?any=1&timeout=5');
    await sleep(80);
    await api('POST', `/api/input-requests/${q.body.id}/answer`, { answer: 'yep' });
    const r = await parked;
    expect(r.body.answer).toBe('yep');
  });

  it('--task does NOT wake on a different task’s answer (times out 204)', async () => {
    await api('POST', '/api/tasks', { title: 'one' });
    await api('POST', '/api/tasks', { title: 'two' });
    await api('POST', '/api/tasks/T-1/input-requests', { question: 'q1?' });
    const q2 = await api('POST', '/api/tasks/T-2/input-requests', { question: 'q2?' });
    const res = fetch(h.url + '/api/await?task=T-1&timeout=0.5', {
      headers: { authorization: `Bearer ${h.token}` },
    });
    await sleep(80);
    await api('POST', `/api/input-requests/${q2.body.id}/answer`, { answer: 'other' });
    expect((await res).status).toBe(204);
  });
});

describe('server: export', () => {
  it('snapshots tasks + events with a format_version', async () => {
    await api('POST', '/api/tasks', { title: 'keep me', priority: 'P1' });
    const r = await api('GET', '/api/export');
    expect(r.status).toBe(200);
    expect(r.body.format_version).toBe(3);
    expect(r.body.tasks).toHaveLength(1);
    expect(r.body.tasks[0].title).toBe('keep me');
    expect(r.body.events.length).toBeGreaterThan(0);
  });
});

describe('server: task lifecycle over HTTP', () => {
  it('creates, lists, and renders context', async () => {
    const created = await api('POST', '/api/tasks', { title: 'Wire up OAuth', priority: 'P1', status: 'In Progress' });
    expect(created.body.id).toBe('T-1');

    const list = await api('GET', '/api/tasks?json=1');
    expect(list.body.tasks).toHaveLength(1);

    const ctx = await api('GET', '/api/tasks/T-1?view=context');
    expect(ctx.body.text).toContain('Wire up OAuth');
  });

  it('returns 409 on a stale optimistic-concurrency write', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const stale = await api('PATCH', '/api/tasks/T-1', { title: 'x' }, { 'if-match': '99' });
    expect(stale.status).toBe(409);
  });

  it('returns 404 for an unknown task', async () => {
    const r = await api('GET', '/api/tasks/T-404?view=context');
    expect(r.status).toBe(404);
  });

  it('projects a needs-input task into the Blocked column (UI view)', async () => {
    await api('POST', '/api/tasks', { title: 't', status: 'In Progress' });
    await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });
    const ui = await api('GET', '/api/ui/board');
    const card = ui.body.tasks.find((t: any) => t.id === 'T-1');
    expect(card.column).toBe('Blocked');
    expect(card.needs_input).toBe(true);
  });
});

describe('server: human-in-the-loop long-poll', () => {
  it('returns immediately when already answered (check-then-park)', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q = await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });
    await api('POST', `/api/input-requests/${q.body.id}/answer`, { answer: 'yes' });
    const awaited = await api('GET', `/api/input-requests/${q.body.id}/await?timeout=1`);
    expect(awaited.status).toBe(200);
    expect(awaited.body.answer).toBe('yes');
  });

  it('wakes a parked await when the answer arrives (no lost wakeup)', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q = await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });

    const parked = api('GET', `/api/input-requests/${q.body.id}/await?timeout=5`);
    await sleep(80); // ensure the long-poll is parked first
    await api('POST', `/api/input-requests/${q.body.id}/answer`, { answer: 'Auth0' });

    const resolved = await parked;
    expect(resolved.status).toBe(200);
    expect(resolved.body.answer).toBe('Auth0');
  });

  it('returns 204 (pending) on timeout', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q = await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });
    const res = await fetch(h.url + `/api/input-requests/${q.body.id}/await?timeout=0.2`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(204);
  });
});

describe('server: websocket realtime', () => {
  it('replays past events on connect, then streams live ones', async () => {
    h.repo.createTask({ title: 'pre-existing' }); // seq 1 before connecting
    const ws = await openWs(h, 0);
    try {
      const got = collectMessages(ws, 2);
      h.repo.createTask({ title: 'live one' }); // seq 2 while connected
      const msgs = await got;
      expect(msgs.map((m) => m.seq)).toEqual([1, 2]);
      expect(msgs[1].type).toBe('task.created');
    } finally {
      ws.close();
    }
  });

  it('rejects a websocket with a bad token', async () => {
    const wsUrl = h.url.replace('http', 'ws') + '/ws?since=0&token=wrong';
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
