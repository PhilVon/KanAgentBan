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
    const order = ['criteria', 'blockers (', 'blocks (', 'open input (', 'agent notes (', 'artifacts (', 'labels:'];
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
    expect(out).toContain('older agent notes'); // footer present (6 notes, default 4)
    expect(out).toContain(`context ${id} --full`);
    const full = renderContext(repo, id, { full: true });
    expect(full).not.toContain('older agent notes');
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
    expect(out).toContain('older agent notes'); // agent notes shed further than default
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

  it('renders the description when there is no summary (no longer stripped)', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', description: 'the actual body of work' });
    expect(renderShow(repo, t.id)).toContain('description: the actual body of work');
    expect(renderContext(repo, t.id)).toContain('description: the actual body of work');
  });

  it('prefers the summary over the description when both exist', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', summary: 'the gist', description: 'the long body' });
    const out = renderContext(repo, t.id);
    expect(out).toContain('summary: the gist');
    expect(out).not.toContain('description:');
  });

  it('trims the description to a never-silent footer under a tight budget', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'big', description: 'D'.repeat(9000) }); // > default ceiling
    const ctx = renderContext(repo, t.id);
    expect(ctx).toContain('description trimmed');
    expect(ctx).not.toContain('D'.repeat(50)); // body actually dropped, not silent
    const show = renderShow(repo, t.id, { maxTokens: 30 });
    expect(show).toContain('description trimmed');
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

describe('render: cross-tier --max-tokens budgeting (docs/03 §4)', () => {
  it('list sheds trailing rows with a never-silent footer; unbudgeted by default', () => {
    const repo = makeRepo();
    for (let i = 0; i < 10; i++)
      repo.createTask({ title: `Task ${'X'.repeat(40)}`, status: 'Ready', priority: 'P2' });
    const full = renderList(repo, {});
    expect(full).not.toContain('hidden for token budget'); // default: no budget

    const out = renderList(repo, { maxTokens: 30 });
    expect(out).toContain('tasks hidden for token budget');
    expect(out).toContain('kanban list --full');
    expect(out.split('\n').length).toBeLessThan(full.split('\n').length);

    // --full opts back out
    expect(renderList(repo, { maxTokens: 30, full: true })).not.toContain('hidden for token budget');
  });

  it('next sheds trailing candidates but keeps the hint line', () => {
    const repo = makeRepo();
    for (let i = 0; i < 4; i++)
      repo.createTask({ title: `cand ${'Y'.repeat(30)}`, status: 'Ready', priority: 'P0' });
    const full = renderNext(repo, { n: 5 });
    expect(full).not.toContain('candidates hidden');

    const out = renderNext(repo, { n: 5, maxTokens: 30 });
    expect(out).toContain('candidates hidden for token budget');
    expect(out).toContain('kanban next --full');
    expect(out).toContain('(use: kanban context'); // hint stays outside the budget
  });

  it('next --context plumbs the budget into the context ladder', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'ctx', status: 'Ready', priority: 'P0', summary: 'S'.repeat(400) });
    repo.addCriterion(t.id, 'c one');
    repo.addCriterion(t.id, 'c two');
    for (let i = 0; i < 5; i++) repo.addComment(t.id, `note ${i}`, 'agent', 'claude');
    // default ceiling (2000) leaves the summary intact...
    expect(renderNext(repo, { context: true })).not.toContain('summary trimmed');
    // ...a tight --max-tokens, plumbed through, makes the ladder trim it.
    expect(renderNext(repo, { context: true, maxTokens: 80 })).toContain('summary trimmed');
  });

  it('show sheds recent comments before the summary, with footers', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'show me', status: 'In Progress', priority: 'P1', summary: 'short' });
    for (let i = 0; i < 3; i++) repo.addComment(t.id, 'B'.repeat(200), 'agent', 'claude');
    const base = renderShow(repo, t.id);
    expect(base).not.toContain('hidden'); // default: no budget
    expect(base).not.toContain('trimmed');

    const out = renderShow(repo, t.id, { maxTokens: estimateTokens(base) - 30 });
    expect(out).toContain('agent note(s) hidden');
    expect(out).toContain(`show ${t.id} --full`);
    expect(out).not.toContain('summary trimmed'); // shedding agent notes was enough
    expect(out).toContain('show me'); // header always survives
  });

  it('show degrades all the way (comments -> open input -> summary) under a tiny budget', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'x', status: 'Ready', priority: 'P2', summary: 'S'.repeat(200) });
    repo.ask(t.id, 'Q'.repeat(80));
    repo.addComment(t.id, 'c', 'agent', 'claude');
    const out = renderShow(repo, t.id, { maxTokens: 1 });
    expect(out).toContain('agent note(s) hidden');
    expect(out).toContain('open input hidden');
    expect(out).toContain('summary trimmed');
    expect(out).toContain('criteria 0/0'); // counts line is never dropped
  });
});

describe('render: user comments are protected directives', () => {
  // A task mixing a user directive with several agent self-notes.
  function mixedTask() {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'main', status: 'In Progress', priority: 'P1', summary: 'do it' });
    for (let i = 0; i < 6; i++) repo.addComment(t.id, `agent note ${'A'.repeat(60)}`, 'agent', 'claude');
    repo.addComment(t.id, 'PLEASE use Postgres not MySQL', 'user', 'phil');
    return { repo, id: t.id };
  }

  it('labels user comments distinctly so the agent reads them as directives', () => {
    const { repo, id } = mixedTask();
    const out = renderContext(repo, id, { full: true });
    expect(out).toContain('user comments — the human is talking to you');
    expect(out).toContain('PLEASE use Postgres not MySQL');
    expect(out).toContain('agent notes (');
    // user block precedes agent notes
    expect(out.indexOf('user comments —')).toBeLessThan(out.indexOf('agent notes ('));
  });

  it('keeps the user comment while shedding agent notes under a tight budget', () => {
    const { repo, id } = mixedTask();
    const baseline = estimateTokens(renderContext(repo, id));
    const out = renderContext(repo, id, { maxTokens: Math.floor(baseline / 2) });
    expect(out).toContain('PLEASE use Postgres not MySQL'); // directive survives
    expect(out).toContain('agent note(s) hidden'); // notes shed first
  });

  it('show keeps the user comment and sheds agent notes first', () => {
    const { repo, id } = mixedTask();
    const base = renderShow(repo, id);
    const out = renderShow(repo, id, { maxTokens: estimateTokens(base) - 20 });
    expect(out).toContain('PLEASE use Postgres not MySQL');
    expect(out).toContain('agent note(s) hidden');
  });

  it('next flags a waiting user comment on the recommended task', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'do me', status: 'Ready', priority: 'P0' });
    expect(renderNext(repo, {})).not.toContain('↳ user comment'); // none yet
    repo.addComment(t.id, 'switch to OAuth', 'user', 'phil');
    const out = renderNext(repo, {});
    expect(out).toContain('↳ user comment');
    expect(out).toContain('switch to OAuth');
    expect(out).toContain(`kanban context ${t.id}`);
  });

  it('list marks tasks carrying a user comment', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a', status: 'Ready' });
    const b = repo.createTask({ title: 'b', status: 'Ready' });
    repo.addComment(a.id, 'agent only', 'agent', 'claude');
    repo.addComment(b.id, 'human here', 'user', 'phil');
    const out = renderList(repo, {});
    const lineA = out.split('\n').find((l) => l.startsWith(a.id))!;
    const lineB = out.split('\n').find((l) => l.startsWith(b.id))!;
    expect(lineA).toContain('💬1');
    expect(lineA).not.toContain('💬1*');
    expect(lineB).toContain('💬1*');
  });
});
