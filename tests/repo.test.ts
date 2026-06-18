import { describe, it, expect } from 'vitest';
import { makeRepo, sleep } from './helpers';
import { ConflictError, NotFoundError, ValidationError } from '../src/server/repo';
import { deriveState } from '../src/server/derive';

describe('repo: tasks & ids', () => {
  it('allocates sequential short ids', () => {
    const repo = makeRepo();
    expect(repo.createTask({ title: 'a' }).id).toBe('T-1');
    expect(repo.createTask({ title: 'b' }).id).toBe('T-2');
  });

  it('stores and reads fields', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'hi', priority: 'P1', status: 'Ready', description: 'd' });
    const got = repo.getTask(t.id)!;
    expect(got.title).toBe('hi');
    expect(got.priority).toBe('P1');
    expect(got.status).toBe('Ready');
    expect(got.version).toBe(1);
  });

  it('filters list by status, label and limit; hides archived', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'Ready', labels: ['x'] });
    repo.createTask({ title: 'b', status: 'Backlog' });
    expect(repo.listTasks({ status: 'Ready' }).map((t) => t.id)).toEqual([a.id]);
    expect(repo.listTasks({ label: 'x' }).map((t) => t.id)).toEqual([a.id]);
    expect(repo.listTasks({ limit: 1 })).toHaveLength(1);
    repo.archiveTask(a.id);
    expect(repo.listTasks({}).map((t) => t.id)).not.toContain(a.id);
  });

  it('requireTask throws NotFoundError', () => {
    const repo = makeRepo();
    expect(() => repo.requireTask('T-99')).toThrow(NotFoundError);
  });
});

describe('repo: dependencies & DAG', () => {
  it('adds an edge', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    const b = repo.createTask({ title: 'b' });
    repo.addDep(a.id, b.id);
    expect(repo.getBlockers(a.id).map((t) => t.id)).toEqual([b.id]);
    expect(repo.getBlockedBy(b.id).map((t) => t.id)).toEqual([a.id]);
  });

  it('rejects self-dependency, duplicates, and cycles', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    const b = repo.createTask({ title: 'b' });
    const c = repo.createTask({ title: 'c' });
    expect(() => repo.addDep(a.id, a.id)).toThrow(ValidationError);
    repo.addDep(a.id, b.id);
    expect(() => repo.addDep(a.id, b.id)).toThrow(ValidationError); // duplicate
    expect(() => repo.addDep(b.id, a.id)).toThrow(ValidationError); // 2-cycle
    repo.addDep(b.id, c.id);
    expect(() => repo.addDep(c.id, a.id)).toThrow(ValidationError); // 3-cycle a->b->c->a
  });
});

describe('repo: derived state (two-flag model)', () => {
  it('ready only when actionable, unblocked, and no open input', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'Ready' });
    expect(deriveState(repo.db, repo.getTask(t.id)!).ready).toBe(true);

    const backlog = repo.createTask({ title: 'bl', status: 'Backlog' });
    expect(deriveState(repo.db, repo.getTask(backlog.id)!).ready).toBe(false);
  });

  it('blocked_by_deps clears when the blocker is Done', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'Ready' });
    const b = repo.createTask({ title: 'b', status: 'Ready' });
    repo.addDep(a.id, b.id);
    expect(deriveState(repo.db, repo.getTask(a.id)!).blocked_by_deps).toBe(true);
    expect(deriveState(repo.db, repo.getTask(a.id)!).ready).toBe(false);
    repo.moveTask(b.id, 'Done');
    expect(deriveState(repo.db, repo.getTask(a.id)!).blocked_by_deps).toBe(false);
    expect(deriveState(repo.db, repo.getTask(a.id)!).ready).toBe(true);
  });

  it('needs_input blocks readiness until answered', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress' });
    const q = repo.ask(t.id, 'q?');
    expect(deriveState(repo.db, repo.getTask(t.id)!).needs_input).toBe(true);
    expect(deriveState(repo.db, repo.getTask(t.id)!).ready).toBe(false);
    repo.answer(q.id, 'yes', 'user');
    expect(deriveState(repo.db, repo.getTask(t.id)!).needs_input).toBe(false);
    expect(deriveState(repo.db, repo.getTask(t.id)!).ready).toBe(true);
  });
});

describe('repo: event log & seq', () => {
  it('appends one gap-free event per mutation', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' }); // seq 1
    repo.moveTask(a.id, 'Ready'); // seq 2
    repo.addComment(a.id, 'hi', 'agent', 'claude'); // seq 3
    const events = repo.changes(0);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.type)).toEqual(['task.created', 'task.moved', 'comment.added']);
    expect(repo.maxSeq()).toBe(3);
    expect(repo.changes(2).map((e) => e.seq)).toEqual([3]);
  });

  it('watch is scoped to the task and its direct deps', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    const b = repo.createTask({ title: 'b' });
    const c = repo.createTask({ title: 'c' });
    repo.addDep(a.id, b.id); // a depends on b (b is a direct dep of a)
    const before = repo.maxSeq();
    repo.addComment(b.id, 'blocker note', 'agent', 'claude'); // related to a
    repo.addComment(c.id, 'unrelated', 'agent', 'claude'); // not related to a
    const ids = repo.watch(a.id, before).map((e) => e.task_id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(c.id);
  });
});

describe('repo: human-in-the-loop', () => {
  it('validates constrained answers and allows freeform', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const q = repo.ask(t.id, 'pick', { options: ['a', 'b'] });
    expect(() => repo.answer(q.id, 'c', 'user')).toThrow(ValidationError);
    const answered = repo.answer(q.id, 'a', 'user');
    expect(answered.status).toBe('answered');
    expect(answered.answer).toBe('a');
    expect(() => repo.answer(q.id, 'b', 'user')).toThrow(ValidationError); // already answered

    const q2 = repo.ask(t.id, 'free', { freeform: true });
    expect(repo.answer(q2.id, 'anything', 'user').answer).toBe('anything');
  });

  it('inbox reports open and recently-answered requests', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const q = repo.ask(t.id, 'q?');
    const cursorBeforeAnswer = repo.maxSeq();
    repo.answer(q.id, 'done', 'user');

    const inbox = repo.inbox(0);
    expect(inbox.answered.map((r) => r.id)).toContain(q.id);

    const open2 = repo.ask(t.id, 'still open?');
    const fresh = repo.inbox(repo.maxSeq());
    expect(fresh.answered).toHaveLength(0); // nothing answered after cursor
    expect(repo.inbox(0).open.map((r) => r.id)).toContain(open2.id);
    expect(cursorBeforeAnswer).toBeGreaterThan(0);
  });
});

describe('repo: comments / criteria / artifacts / labels', () => {
  it('handles each first-class entity', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });

    repo.addComment(t.id, 'one', 'agent', 'claude');
    repo.addComment(t.id, 'two', 'user', 'phil');
    expect(repo.countComments(t.id)).toBe(2);
    expect(repo.getComments(t.id, 1)).toHaveLength(1);

    const ac = repo.addCriterion(t.id, 'must work');
    repo.checkCriterion(ac, true);
    expect(repo.getCriteria(t.id)[0].checked).toBe(true);
    repo.checkCriterion(ac, false);
    expect(repo.getCriteria(t.id)[0].checked).toBe(false);

    repo.addArtifact(t.id, 'pr', 'the PR', 'https://example.com/pr/1');
    expect(repo.getArtifacts(t.id)[0].uri).toBe('https://example.com/pr/1');

    repo.addLabel(t.id, 'backend');
    expect(repo.getLabels(t.id)).toContain('backend');
    repo.removeLabel(t.id, 'backend');
    expect(repo.getLabels(t.id)).not.toContain('backend');
  });
});

describe('repo: optimistic concurrency & summary drift', () => {
  it('rejects stale writes and bumps version', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const updated = repo.updateTask(t.id, { title: 'renamed' }, { expectVersion: 1 });
    expect(updated.version).toBe(2);
    expect(() => repo.updateTask(t.id, { title: 'x' }, { expectVersion: 1 })).toThrow(ConflictError);
  });

  it('marks a summary stale when the description is newer', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', summary: 's' });
    await sleep(5);
    const after = repo.updateTask(t.id, { description: 'new body' });
    expect(after.description_updated_at! > after.summary_updated_at!).toBe(true);
  });
});
