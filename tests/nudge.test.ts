import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeRepo } from './helpers';
import { attachNudge } from '../src/server/nudge';
import type { Repo } from '../src/server/repo';

// Mock child_process so the command transport doesn't actually spawn anything.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const ROOT = '/tmp/board';

/** Create a task, ask a question, and answer it — emits a real input.answered. */
function answerSomething(repo: Repo): { taskId: string; qid: string } {
  const t = repo.createTask({ title: 'x' });
  const q = repo.ask(t.id, 'pick?', { options: ['a', 'b'] });
  repo.answer(q.id, 'a', 'user');
  return { taskId: t.id, qid: q.id };
}

describe('nudge: external-resume notifier', () => {
  beforeEach(() => {
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() } as any);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is inert when nothing is configured', () => {
    const repo = makeRepo();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const detach = attachNudge(repo, {}, ROOT);
    answerSomething(repo);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    detach(); // no-op detach is safe
  });

  it('POSTs the answered event to the webhook url', () => {
    const repo = makeRepo();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    attachNudge(repo, { url: 'http://127.0.0.1:9/hook' }, ROOT);

    const { taskId, qid } = answerSomething(repo);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9/hook');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.type).toBe('input.answered');
    expect(body.task_id).toBe(taskId);
    expect(body.board_root).toBe(ROOT);
    expect(body.payload.request_id).toBe(qid);
    expect(body.payload.answer).toBe('a');
  });

  it('sends configured headers with the webhook', () => {
    const repo = makeRepo();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    attachNudge(repo, { url: 'http://127.0.0.1:9/hook', headers: { 'x-auth': 'secret' } }, ROOT);
    answerSomething(repo);
    expect(fetchMock.mock.calls[0][1].headers['x-auth']).toBe('secret');
  });

  it('ignores events other than input.answered', () => {
    const repo = makeRepo();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    attachNudge(repo, { url: 'http://127.0.0.1:9/hook' }, ROOT);
    repo.createTask({ title: 'just a task' }); // emits task.created only
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows webhook failures (never throws into the mutation)', async () => {
    const repo = makeRepo();
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    attachNudge(repo, { url: 'http://127.0.0.1:9/hook' }, ROOT);
    expect(() => answerSomething(repo)).not.toThrow();
    await Promise.resolve(); // let the rejected promise settle
    expect(console.warn).toHaveBeenCalled();
  });

  it('spawns the configured command with KANBAN_* env vars', () => {
    const repo = makeRepo();
    vi.stubGlobal('fetch', vi.fn());
    attachNudge(repo, { cmd: 'notify.sh' }, ROOT);

    const { taskId, qid } = answerSomething(repo);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('notify.sh');
    expect(opts.shell).toBe(true);
    expect(opts.detached).toBe(true);
    expect(opts.env.KANBAN_EVENT_TYPE).toBe('input.answered');
    expect(opts.env.KANBAN_TASK_ID).toBe(taskId);
    expect(opts.env.KANBAN_REQUEST_ID).toBe(qid);
    expect(opts.env.KANBAN_ANSWER).toBe('a');
    expect(opts.env.KANBAN_BOARD_ROOT).toBe(ROOT);
  });

  it('stops firing after detach', () => {
    const repo = makeRepo();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const detach = attachNudge(repo, { url: 'http://127.0.0.1:9/hook' }, ROOT);
    detach();
    answerSomething(repo);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
