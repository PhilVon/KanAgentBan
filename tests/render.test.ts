import { describe, it, expect } from 'vitest';
import { makeRepo, sleep } from './helpers';
import {
  renderContext,
  renderList,
  renderNext,
  renderShow,
  estimateTokens,
} from '../src/server/render';

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

  // A task whose degradable sections (summary, criteria, comments) are large and
  // distinct so the budgeting ladder's precedence is observable.
  function ladderTask() {
    const repo = makeRepo();
    const t = repo.createTask({
      title: 'main',
      status: 'In Progress',
      priority: 'P1',
      summary: 'S'.repeat(200),
    });
    repo.addCriterion(t.id, 'C'.repeat(80));
    repo.addCriterion(t.id, 'C'.repeat(80));
    for (let i = 0; i < 8; i++) repo.addComment(t.id, 'B'.repeat(80), 'agent', 'claude');
    repo.addArtifact(t.id, 'pr', 'art', 'https://example.com/x');
    repo.addLabel(t.id, 'backend');
    return { repo, id: t.id };
  }

  it('sheds oldest comments first, keeping criteria/artifacts/labels intact', () => {
    const { repo, id } = ladderTask();
    const baseline = estimateTokens(renderContext(repo, id)); // default fidelity (4 comments)
    const out = renderContext(repo, id, { maxTokens: baseline - 30 });
    expect(out).toContain('older comments'); // comments shed further than default
    expect(out).toContain('criteria 0/2:'); // checklist intact (colon == full form)
    expect(out).toContain('artifacts ('); // trailing sections survive
    expect(out).toContain('labels:');
    expect(out).not.toContain('criteria collapsed');
    expect(out).not.toContain('summary trimmed');
    expect(out).not.toContain('hidden for token budget');
    // fewer comment lines than the default render
    const count = (s: string) => (s.match(/agent\/claude/g) ?? []).length;
    expect(count(out)).toBeLessThan(count(renderContext(repo, id)));
  });

  // Large criteria + summary, tiny comments: shedding comments barely helps, so
  // the budget can only be met by collapsing criteria — isolating those rungs.
  function criteriaHeavyTask() {
    const repo = makeRepo();
    const t = repo.createTask({
      title: 'main',
      status: 'In Progress',
      priority: 'P1',
      summary: 'S'.repeat(400),
    });
    repo.addCriterion(t.id, 'C'.repeat(400));
    repo.addCriterion(t.id, 'C'.repeat(400));
    for (let i = 0; i < 8; i++) repo.addComment(t.id, 'B'.repeat(8), 'agent', 'claude');
    repo.addArtifact(t.id, 'pr', 'art', 'https://example.com/x');
    repo.addLabel(t.id, 'backend');
    return { repo, id: t.id };
  }

  it('collapses criteria to a count before trimming the summary', () => {
    const { repo, id } = criteriaHeavyTask();
    const out = renderContext(repo, id, { maxTokens: 250 });
    expect(out).toContain('criteria collapsed');
    expect(out).toContain('summary:'); // summary still present at this budget
    expect(out).not.toContain('summary trimmed');
  });

  it('trims the summary once comments and criteria are exhausted', () => {
    const { repo, id } = criteriaHeavyTask();
    const out = renderContext(repo, id, { maxTokens: 120 });
    expect(out).toContain('summary trimmed');
    expect(out).toContain('criteria collapsed');
  });

  it('--full ignores the token budget (no degradation footers)', () => {
    const { repo, id } = ladderTask();
    const out = renderContext(repo, id, { maxTokens: 20, full: true });
    expect(out).not.toContain('older comments');
    expect(out).not.toContain('hidden for token budget');
    expect(out).toContain('criteria 0/2:');
  });

  it('applies a default token ceiling when --max-tokens is omitted', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'big', summary: 'S'.repeat(9000) }); // > default ceiling
    const out = renderContext(repo, t.id); // no maxTokens -> default cap kicks in
    expect(out).toContain('summary trimmed');
    expect(estimateTokens(out)).toBeLessThanOrEqual(2000 + 50);
    // a small task stays fully rendered under the default ceiling
    const small = repo.createTask({ title: 's', summary: 'short summary' });
    expect(renderContext(repo, small.id)).toContain('summary: short summary');
  });

  it('--full and --max-tokens 0 opt out of the default ceiling', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'big', summary: 'S'.repeat(9000) });
    expect(renderContext(repo, t.id, { full: true })).not.toContain('summary trimmed');
    expect(renderContext(repo, t.id, { maxTokens: 0 })).not.toContain('summary trimmed');
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
