import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client, sleep, type TestServer } from './helpers';
import { deriveState } from '../src/server/derive';

// Past / future ISO timestamps for deterministic expiry (no sleeping).
const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

describe('input lifecycle: repo.cancel', () => {
  it('withdraws an open request, fires input.cancelled, and clears needs_input', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress' });
    const q = repo.ask(t.id, 'q?');
    expect(deriveState(repo.db, repo.getTask(t.id)!).needs_input).toBe(true);

    const since = repo.maxSeq();
    const r = repo.cancel(q.id);
    expect(r.status).toBe('cancelled');
    expect(repo.getRequest(q.id)!.status).toBe('cancelled');
    // task is actionable again
    expect(deriveState(repo.db, repo.getTask(t.id)!).needs_input).toBe(false);
    expect(deriveState(repo.db, repo.getTask(t.id)!).ready).toBe(true);
    // the previously-dead event now fires
    expect(repo.changes(since).map((e) => e.type)).toContain('input.cancelled');
  });

  it('rejects cancelling a non-open request, and answering after cancel', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const q = repo.ask(t.id, 'q?');
    repo.cancel(q.id);
    expect(() => repo.cancel(q.id)).toThrow(/cancelled/);
    expect(() => repo.answer(q.id, 'x', 'user')).toThrow(/cancelled/);
  });

  it('throws NotFoundError for an unknown request', () => {
    const repo = makeRepo();
    expect(() => repo.cancel('Q-404')).toThrow(/not found/);
  });
});

describe('input lifecycle: repo.expireDue', () => {
  it('expires only past-due open requests and fires input.expired', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress' });
    const due = repo.ask(t.id, 'past?', { expiresAt: PAST });
    const fut = repo.ask(t.id, 'future?', { expiresAt: FUTURE });
    const none = repo.ask(t.id, 'no-ttl?');

    const since = repo.maxSeq();
    const { expired } = repo.expireDue();

    expect(expired).toBe(1);
    expect(repo.getRequest(due.id)!.status).toBe('expired');
    expect(repo.getRequest(fut.id)!.status).toBe('open');
    expect(repo.getRequest(none.id)!.status).toBe('open');
    const fired = repo.changes(since).filter((e) => e.type === 'input.expired');
    expect(fired).toHaveLength(1);
    expect((fired[0].payload as any).request_id).toBe(due.id);
  });

  it('is a no-op before the deadline, expires once, and rejects answering after', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const q = repo.ask(t.id, 'q?', { expiresAt: '2500-01-01T00:00:00.000Z' });
    // a `now` before the deadline -> nothing due
    expect(repo.expireDue('2001-01-01T00:00:00.000Z').expired).toBe(0);
    expect(repo.getRequest(q.id)!.status).toBe('open');
    // a `now` past the deadline -> expires exactly once
    expect(repo.expireDue('2600-01-01T00:00:00.000Z').expired).toBe(1);
    expect(repo.expireDue('2600-01-01T00:00:00.000Z').expired).toBe(0); // already expired
    expect(() => repo.answer(q.id, 'x', 'user')).toThrow(/expired/);
  });
});

describe('input lifecycle: inbox surfaces resolutions (never-silent)', () => {
  it('reports cancelled/expired requests after the cursor in `resolved`', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const a = repo.ask(t.id, 'a?');
    const b = repo.ask(t.id, 'b?', { expiresAt: PAST });
    const since = repo.maxSeq();

    repo.cancel(a.id);
    repo.expireDue();

    const inbox = repo.inbox(since);
    const ids = inbox.resolved.map((r) => r.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(inbox.open).toHaveLength(0);
  });
});

describe('server: cancel + await resolution', () => {
  let h: TestServer;
  let api: ReturnType<typeof client>;
  beforeEach(async () => {
    h = await startTestServer();
    api = client(h);
  });
  afterEach(async () => {
    await stopTestServer(h);
  });

  it('POST .../cancel withdraws the request', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q = await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });
    const r = await api('POST', `/api/input-requests/${q.body.id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
  });

  it('wakes a parked await when the question is cancelled (no hang)', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q = await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });

    const parked = api('GET', `/api/input-requests/${q.body.id}/await?timeout=5`);
    await sleep(80); // ensure parked first
    await api('POST', `/api/input-requests/${q.body.id}/cancel`);

    const resolved = await parked;
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('cancelled');
  });

  it('returns the terminal status immediately for an already-cancelled request', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q = await api('POST', '/api/tasks/T-1/input-requests', { question: 'q?' });
    await api('POST', `/api/input-requests/${q.body.id}/cancel`);
    const awaited = await api('GET', `/api/input-requests/${q.body.id}/await?timeout=1`);
    expect(awaited.body.status).toBe('cancelled');
  });

  it('export includes cancelled and expired requests', async () => {
    await api('POST', '/api/tasks', { title: 't' });
    const q1 = await api('POST', '/api/tasks/T-1/input-requests', { question: 'a?' });
    await api('POST', `/api/input-requests/${q1.body.id}/cancel`);
    const exp = await api('GET', '/api/export');
    const statuses = exp.body.input_requests.map((r: any) => r.status);
    expect(statuses).toContain('cancelled');
  });
});
