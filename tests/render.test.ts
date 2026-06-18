import { describe, it, expect } from 'vitest';
import { makeRepo, sleep } from './helpers';
import { renderContext, renderList, renderNext, renderShow } from '../src/server/render';

describe('render: list', () => {
  it('emits the one-line-per-task contract', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'Wire up OAuth', status: 'In Progress', priority: 'P1' });
    const out = renderList(repo, {});
    expect(out).toMatch(/^T-1 \[P1\] In Progress\s+Wire up OAuth/);
  });

  it('shows the needs-input flag', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress' });
    repo.ask(t.id, 'q?');
    expect(renderList(repo, {})).toContain('?');
  });
});

describe('render: context working set', () => {
  function richTask() {
    const repo = makeRepo();
    const blocker = repo.createTask({ title: 'blocker', status: 'Ready' });
    const t = repo.createTask({ title: 'main', status: 'In Progress', priority: 'P1', summary: 'do the thing' });
    const downstream = repo.createTask({ title: 'downstream' });
    repo.addDep(t.id, blocker.id); // t blocked by blocker
    repo.addDep(downstream.id, t.id); // downstream blocked by t
    repo.addCriterion(t.id, 'crit one');
    const ac2 = repo.addCriterion(t.id, 'crit two');
    repo.checkCriterion(ac2, true);
    repo.ask(t.id, 'which provider?', { options: ['A', 'B'] });
    for (let i = 0; i < 6; i++) repo.addComment(t.id, `comment ${i}`, 'agent', 'claude');
    repo.addArtifact(t.id, 'pr', 'the PR', 'https://example.com/pr/1');
    repo.addLabel(t.id, 'backend');
    return { repo, id: t.id };
  }

  it('renders all sections in fixed order', () => {
    const { repo, id } = richTask();
    const out = renderContext(repo, id);
    const order = ['criteria', 'blockers (', 'blocks (', 'open input (', 'comments (', 'artifacts (', 'labels:'];
    const positions = order.map((h) => out.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
  });

  it('shows criteria progress and direct deps only', () => {
    const { repo, id } = richTask();
    const out = renderContext(repo, id);
    expect(out).toContain('criteria 1/2');
    expect(out).toContain('blockers (1)');
    expect(out).toContain('blocks (1)');
    expect(out).toContain('options: A | B');
    expect(out).toContain('the PR');
    expect(out).toContain('https://example.com/pr/1');
  });

  it('truncates comments with an explicit, never-silent footer', () => {
    const { repo, id } = richTask();
    const out = renderContext(repo, id);
    expect(out).toContain('older comments'); // footer present (6 comments, default 4)
    expect(out).toContain(`context ${id} --full`);
    const full = renderContext(repo, id, { full: true });
    expect(full).not.toContain('older comments');
  });

  it('drops sections under a token budget, with a footer', () => {
    const { repo, id } = richTask();
    const out = renderContext(repo, id, { maxTokens: 20 });
    expect(out).toContain('hidden for token budget');
  });

  it('flags a stale summary when description is newer', async () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', summary: 's' });
    await sleep(5);
    repo.updateTask(t.id, { description: 'newer body' });
    expect(renderContext(repo, t.id)).toContain('[summary may be stale]');
    expect(renderShow(repo, t.id)).toContain('[summary may be stale]');
  });
});

describe('render: next', () => {
  it('recommends a ready task with a why line', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'do me', status: 'Ready', priority: 'P0' });
    const out = renderNext(repo, {});
    expect(out).toContain('do me');
    expect(out).toContain('why:');
  });

  it('explains when nothing is ready instead of printing nothing', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'In Progress' });
    repo.ask(a.id, 'blocked?');
    const out = renderNext(repo, {});
    expect(out).toContain('no ready tasks');
    expect(out).toContain('needs input');
  });
});
