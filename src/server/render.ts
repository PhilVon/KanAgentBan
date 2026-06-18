import type { Repo } from './repo';
import { deriveState, remainingBlockerCount } from './derive';
import { recommend, type BlockedSummary } from './recommend';
import type { Task } from '../shared/types';

// Output format contract — see docs/03-token-efficiency.md §5. Bump on change.
export const FORMAT_VERSION = 1;

const DEFAULT_COMMENTS = 4;

function rel(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diffMs / 3.6e6);
  if (h < 1) return `${Math.max(1, Math.floor(diffMs / 6e4))}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function flags(repo: Repo, t: Task): string {
  const d = deriveState(repo.db, t);
  const out: string[] = [];
  if (d.blocked_by_deps) out.push('D');
  if (d.needs_input) out.push('?');
  const c = repo.countComments(t.id);
  if (c) out.push(`💬${c}`);
  if (t.assignee) out.push(`@${t.assignee}`);
  return out.join(' ');
}

/** `kanban list` — compact one-line-per-task. */
export function renderList(repo: Repo, opts: { status?: string; label?: string; limit?: number }): string {
  const tasks = repo.listTasks(opts);
  if (!tasks.length) return '(no tasks)';
  return tasks
    .map((t) => `${t.id} [${t.priority}] ${t.status.padEnd(11)} ${t.title}  ${flags(repo, t)}`.trimEnd())
    .join('\n');
}

/** `kanban next` — recommended task (+ optional full context). */
export function renderNext(
  repo: Repo,
  opts: { context?: boolean; n?: number; agent?: string; mine?: boolean },
): string {
  const r = recommend(repo, opts.n ?? 1, opts.agent, opts.mine);
  if ('none' in r) return renderBlocked(r);
  if (opts.context && r[0]) {
    return `${renderRecLine(r[0].task)}\nwhy: ${r[0].why}\n\n${renderContext(repo, r[0].task.id)}`;
  }
  return r
    .map((rec) => `${renderRecLine(rec.task)}\nwhy: ${rec.why}`)
    .join('\n\n')
    .concat('\n(use: kanban context <id>  ·  kanban next --context)');
}

function renderRecLine(t: Task): string {
  return `${t.id}  [${t.priority}] ${t.status}  ${t.title}`;
}

function renderBlocked(b: BlockedSummary): string {
  if (!b.blocked.length) return 'no ready tasks, and nothing in progress.';
  const list = b.blocked.map((x) => `${x.id} ${x.reason}`).join('; ');
  return `no ready tasks. ${b.blocked.length} blocked: ${list}`;
}

/** `kanban show <id>` — medium detail. */
export function renderShow(repo: Repo, id: string): string {
  const t = repo.requireTask(id);
  const crit = repo.getCriteria(id);
  const done = crit.filter((c) => c.checked).length;
  const open = repo.getOpenRequests(id);
  const comments = repo.getComments(id, 3);
  const lines = [
    `${t.id} [${t.priority}] ${t.status}  "${t.title}"`,
    t.summary ? `summary: ${t.summary}${summaryStale(t) ? '  [summary may be stale]' : ''}` : '',
    `criteria ${done}/${crit.length}  ·  blockers ${remainingBlockerCount(repo.db, id)}  ·  comments ${repo.countComments(id)}  ·  open input ${open.length}${t.assignee ? `  ·  assignee ${t.assignee}` : ''}`,
  ];
  if (open.length) lines.push(...open.map((q) => `  ${q.id} "${q.question}"`));
  if (comments.length)
    lines.push(
      'recent comments:',
      ...comments.map((c) => `  ${c.author_type}/${c.author_name} ${rel(c.created_at)}  "${c.body}"`),
    );
  return lines.filter(Boolean).join('\n');
}

function summaryStale(t: Task): boolean {
  return (
    !!t.summary_updated_at &&
    !!t.description_updated_at &&
    t.description_updated_at > t.summary_updated_at
  );
}

/**
 * `kanban context <id>` — the flagship curated working set in fixed section
 * order with deterministic, never-silent truncation. See docs/03 §3-4.
 */
export function renderContext(
  repo: Repo,
  id: string,
  opts: { full?: boolean; maxTokens?: number } = {},
): string {
  const t = repo.requireTask(id);
  const sections: string[] = [];

  // 1. task line
  sections.push(`${t.id} [${t.priority}] ${t.status}  "${t.title}"`);
  if (t.assignee) sections.push(`assignee: ${t.assignee}`);
  if (t.summary) sections.push(`summary: ${t.summary}${summaryStale(t) ? '  [summary may be stale]' : ''}`);

  // 2. acceptance criteria
  const crit = repo.getCriteria(id);
  if (crit.length) {
    const done = crit.filter((c) => c.checked).length;
    sections.push(
      `criteria ${done}/${crit.length}:\n` +
        crit.map((c) => `  [${c.checked ? 'x' : ' '}] ${c.id} ${c.text}`).join('\n'),
    );
  }

  // 3. direct deps only (transitive shown as a count)
  const blockers = repo.getBlockers(id);
  const blockedBy = repo.getBlockedBy(id);
  if (blockers.length)
    sections.push(
      `blockers (${blockers.length}): ` +
        blockers.map((b) => `${b.id} ${b.title} [${b.status}]`).join(', '),
    );
  if (blockedBy.length)
    sections.push(`blocks (${blockedBy.length}): ` + blockedBy.map((b) => b.id).join(', '));

  // 4. open input requests
  const open = repo.getOpenRequests(id);
  if (open.length)
    sections.push(
      `open input (${open.length}):\n` +
        open
          .map((q) => `  ${q.id} "${q.question}"${q.options ? `  options: ${q.options.join(' | ')}` : ''}`)
          .join('\n'),
    );

  // 5. comments (last N, newest first) with a truncation footer
  const total = repo.countComments(id);
  const limit = opts.full ? total : DEFAULT_COMMENTS;
  const comments = repo.getComments(id, opts.full ? undefined : limit);
  if (comments.length) {
    let block = `comments (last ${comments.length} of ${total}, newest first):\n`;
    block += comments
      .map((c) => `  ${c.author_type}/${c.author_name} ${rel(c.created_at)}  "${c.body}"`)
      .join('\n');
    if (!opts.full && total > comments.length)
      block += `\n  [+${total - comments.length} older comments — context ${id} --full]`;
    sections.push(block);
  }

  // 6. artifacts (refs only)
  const arts = repo.getArtifacts(id);
  if (arts.length)
    sections.push(
      `artifacts (${arts.length}):\n` +
        arts.map((a) => `  ${a.kind.padEnd(6)} "${a.title}"  ${a.uri}`).join('\n'),
    );

  // 7. labels
  const labels = repo.getLabels(id);
  if (labels.length) sections.push(`labels: ${labels.join(', ')}`);

  return budget(sections, opts.maxTokens, id);
}

/**
 * Deterministic token budgeting: drop whole trailing sections (lowest priority
 * first) until under budget, always leaving an explicit footer. Never silent.
 */
function budget(sections: string[], maxTokens: number | undefined, id: string): string {
  if (!maxTokens) return sections.join('\n\n');
  const estimate = (s: string) => Math.ceil(s.length / 4);
  let kept = [...sections];
  const dropped: number[] = [];
  while (kept.length > 1 && estimate(kept.join('\n\n')) > maxTokens) {
    dropped.push(kept.length);
    kept = kept.slice(0, -1);
  }
  let out = kept.join('\n\n');
  if (dropped.length) out += `\n\n[${dropped.length} section(s) hidden for token budget — context ${id} --full]`;
  return out;
}
