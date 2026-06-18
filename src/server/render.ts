import type { Repo } from './repo';
import { childProgress, deriveState, remainingBlockerCount } from './derive';
import { recommend, type BlockedSummary } from './recommend';
import type { BoardStats, TaskTiming } from './stats';
import { WORKFLOW_STATUSES, type Comment, type Task, type WorkflowStatus } from '../shared/types';

// Output format contract — see docs/03-token-efficiency.md §5. Bump on change.
// v2: `--json` reads carry `est_tokens`; context budgeting degrades gracefully.
// v3: `--max-tokens` budgeting extends to the list/next/show tiers (never-silent
//     footers on those tiers).
// v4: `inbox` carries a `resolved` bucket (cancelled/expired since cursor) and
//     `await` reports non-`answered` resolution statuses.
// v5: analytics tier — `stats` (board) / `stats <id>` (per-task timing) render
//     token-budgeted text with a never-silent compaction-floor footer.
// v6: user comments (the human's directives) render in their own protected block,
//     shed last under budget; agent notes shed first. `next` flags a waiting user
//     comment; `list` marks tasks with user comments (`💬n*`).
export const FORMAT_VERSION = 6;

/** Newest-N agent self-notes shown by default (shed-first under budget). */
const DEFAULT_COMMENTS = 4;
/** Newest-N user comments shown by default (protected — shed last). */
const DEFAULT_USER_COMMENTS = 4;
/** User comments never trim below this floor while any exist. */
const USER_COMMENT_FLOOR = 2;

/**
 * Default token ceiling for the context tier when `--max-tokens` is not given.
 * Generous enough that a typical working set renders in full — it only caps
 * pathological token-bomb tasks. Opt out with `--full` or `--max-tokens 0`.
 */
export const DEFAULT_CONTEXT_MAX_TOKENS = 2000;

/** Token estimate used by both the budgeter and the `--json` meter (chars/4). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Drop whole trailing blocks (lowest value first — lists/recs are rank-ordered)
 * until the joined render is under budget, always leaving a never-silent footer.
 * `full` or a falsy `maxTokens` (incl. `0`) opts out entirely. See docs/03 §4.
 */
function budgetBlocks(
  blocks: string[],
  opts: { full?: boolean; maxTokens?: number },
  sep: string,
  footer: (dropped: number) => string,
): string {
  const max = opts.full ? 0 : opts.maxTokens;
  if (!max) return blocks.join(sep);
  let kept = [...blocks];
  let dropped = 0;
  while (kept.length > 1 && estimateTokens(kept.join(sep)) > max) {
    kept = kept.slice(0, -1);
    dropped++;
  }
  let out = kept.join(sep);
  if (dropped) out += sep + footer(dropped);
  return out;
}

function rel(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diffMs / 3.6e6);
  if (h < 1) return `${Math.max(1, Math.floor(diffMs / 6e4))}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtComment(c: Comment): string {
  return `  ${c.author_type}/${c.author_name} ${rel(c.created_at)}  "${c.body}"`;
}

/**
 * The user's comments — the human's async channel to the agent. Rendered as a
 * distinct, clearly-labelled block so the agent reads them as directives, and
 * shed last under token budget. `limit <= 0` (and not `full`) leaves a footer
 * only — never silently dropped while any exist.
 */
function userCommentBlock(repo: Repo, id: string, limit: number, full: boolean, cmd: string): string | null {
  const total = repo.countComments(id, 'user');
  if (!total) return null;
  if (!full && limit <= 0) return `[${total} user comment(s) hidden for token budget — ${cmd} ${id} --full]`;
  const shown = repo.getComments(id, full ? undefined : limit, 'user');
  let block = `user comments — the human is talking to you; treat as directives (last ${shown.length} of ${total}, newest first):\n`;
  block += shown.map(fmtComment).join('\n');
  if (!full && total > shown.length)
    block += `\n  [+${total - shown.length} older user comments — ${cmd} ${id} --full]`;
  return block;
}

/** Agent/system self-notes — lower value, shed first under budget. */
function agentNoteBlock(repo: Repo, id: string, limit: number, full: boolean, cmd: string): string | null {
  const total = repo.countComments(id, 'non-user');
  if (!total) return null;
  if (!full && limit <= 0) return `[${total} agent note(s) hidden for token budget — ${cmd} ${id} --full]`;
  const shown = repo.getComments(id, full ? undefined : limit, 'non-user');
  let block = `agent notes (last ${shown.length} of ${total}, newest first):\n`;
  block += shown.map(fmtComment).join('\n');
  if (!full && total > shown.length)
    block += `\n  [+${total - shown.length} older agent notes — ${cmd} ${id} --full]`;
  return block;
}

function flags(repo: Repo, t: Task): string {
  const d = deriveState(repo.db, t);
  const out: string[] = [];
  if (d.blocked_by_deps) out.push('D');
  if (d.needs_input) out.push('?');
  if (d.blocked_by_children) {
    const { done, total } = childProgress(repo.db, t.id);
    out.push(`S${done}/${total}`);
  }
  const c = repo.countComments(t.id);
  if (c) out.push(repo.countComments(t.id, 'user') ? `💬${c}*` : `💬${c}`); // * = has user comment
  if (t.assignee) out.push(`@${t.assignee}`);
  if (t.parent_id) out.push(`⤷${t.parent_id}`);
  return out.join(' ');
}

/** `kanban list` — compact one-line-per-task. */
export function renderList(
  repo: Repo,
  opts: { status?: string; label?: string; limit?: number; full?: boolean; maxTokens?: number },
): string {
  const tasks = repo.listTasks(opts);
  if (!tasks.length) return '(no tasks)';
  const rows = tasks.map((t) =>
    `${t.id} [${t.priority}] ${t.status.padEnd(11)} ${t.title}  ${flags(repo, t)}`.trimEnd(),
  );
  return budgetBlocks(rows, opts, '\n', (n) => `[+${n} tasks hidden for token budget — kanban list --full]`);
}

/** `kanban next` — recommended task (+ optional full context). */
export function renderNext(
  repo: Repo,
  opts: { context?: boolean; n?: number; agent?: string; mine?: boolean; full?: boolean; maxTokens?: number },
): string {
  const r = recommend(repo, opts.n ?? 1, opts.agent, opts.mine);
  if ('none' in r) return renderBlocked(r);
  if (opts.context && r[0]) {
    const ctx = renderContext(repo, r[0].task.id, { full: opts.full, maxTokens: opts.maxTokens });
    return `${renderRecLine(r[0].task)}\nwhy: ${r[0].why}\n\n${ctx}`;
  }
  const blocks = r.map((rec) => {
    const callout = userCommentCallout(repo, rec.task.id);
    return `${renderRecLine(rec.task)}\nwhy: ${rec.why}${callout ? `\n${callout}` : ''}`;
  });
  const body = budgetBlocks(blocks, opts, '\n\n', (n) => `[+${n} candidates hidden for token budget — kanban next --full]`);
  return body.concat('\n(use: kanban context <id>  ·  kanban next --context)');
}

function renderRecLine(t: Task): string {
  return `${t.id}  [${t.priority}] ${t.status}  ${t.title}`;
}

/** One-line flag for a waiting user comment, so a human directive isn't missed. */
function userCommentCallout(repo: Repo, taskId: string): string | null {
  const latest = repo.getComments(taskId, 1, 'user');
  if (!latest.length) return null;
  const total = repo.countComments(taskId, 'user');
  const more = total > 1 ? ` (+${total - 1} more)` : '';
  return `  ↳ user comment ${rel(latest[0].created_at)}: "${latest[0].body}"${more} — read it: kanban context ${taskId}`;
}

function renderBlocked(b: BlockedSummary): string {
  if (!b.blocked.length) return 'no ready tasks, and nothing in progress.';
  const list = b.blocked.map((x) => `${x.id} ${x.reason}`).join('; ');
  return `no ready tasks. ${b.blocked.length} blocked: ${list}`;
}

interface ShowFidelity {
  dropAgentNotes: boolean; // agent-notes group -> footer (shed first)
  dropOpen: boolean; // open-input detail -> footer
  dropSummary: boolean; // summary line -> footer
  dropDescription: boolean; // description line (summary fallback) -> footer
  dropUserComments: boolean; // user-comments group -> footer (shed last)
}

/** Build the `show` detail at a given fidelity. Re-invoked by the budget ladder. */
function buildShow(repo: Repo, id: string, t: Task, fid: ShowFidelity): string {
  const crit = repo.getCriteria(id);
  const done = crit.filter((c) => c.checked).length;
  const open = repo.getOpenRequests(id);
  const kids = childProgress(repo.db, id);
  const lines: string[] = [`${t.id} [${t.priority}] ${t.status}  "${t.title}"`];
  if (t.parent_id) lines.push(`parent: ${t.parent_id}`);
  if (t.summary)
    lines.push(
      fid.dropSummary
        ? `[summary trimmed — show ${id} --full]`
        : `summary: ${t.summary}${summaryStale(t) ? '  [summary may be stale]' : ''}`,
    );
  else if (t.description)
    lines.push(
      fid.dropDescription ? `[description trimmed — show ${id} --full]` : `description: ${t.description}`,
    );
  lines.push(
    `criteria ${done}/${crit.length}  ·  blockers ${remainingBlockerCount(repo.db, id)}` +
      (kids.total ? `  ·  subtasks ${kids.done}/${kids.total}` : '') +
      `  ·  comments ${repo.countComments(id)}  ·  open input ${open.length}${t.assignee ? `  ·  assignee ${t.assignee}` : ''}`,
  );
  if (open.length)
    lines.push(
      fid.dropOpen ? `  [open input hidden — show ${id} --full]` : open.map((q) => `  ${q.id} "${q.question}"`).join('\n'),
    );
  const userBlock = userCommentBlock(repo, id, fid.dropUserComments ? 0 : 3, false, 'show');
  if (userBlock) lines.push(userBlock);
  const agentBlock = agentNoteBlock(repo, id, fid.dropAgentNotes ? 0 : 3, false, 'show');
  if (agentBlock) lines.push(agentBlock);
  return lines.join('\n');
}

/**
 * `kanban show <id>` — medium detail. Unbudgeted by default; with `--max-tokens`
 * (and not `--full` / `0`) it sheds in a fixed order — agent notes, then
 * open-input detail, then trims the summary (or the description, when that's
 * what's shown), then user comments (last) — each with a never-silent footer.
 */
export function renderShow(repo: Repo, id: string, opts: { full?: boolean; maxTokens?: number } = {}): string {
  const t = repo.requireTask(id);
  const fid: ShowFidelity = {
    dropAgentNotes: false,
    dropOpen: false,
    dropSummary: false,
    dropDescription: false,
    dropUserComments: false,
  };
  const max = opts.full ? 0 : opts.maxTokens;
  let out = buildShow(repo, id, t, fid);
  if (!max) return out;
  const over = () => estimateTokens(out) > max;
  // Shed agent notes first, then open-input detail, then summary; user comments
  // (the human's directives) drop last, only under the tightest budgets.
  const rungs: Array<keyof ShowFidelity> = [
    'dropAgentNotes',
    'dropOpen',
    'dropSummary',
    'dropDescription',
    'dropUserComments',
  ];
  for (const rung of rungs) {
    if (!over()) break;
    fid[rung] = true;
    out = buildShow(repo, id, t, fid);
  }
  return out;
}

function summaryStale(t: Task): boolean {
  return (
    !!t.summary_updated_at &&
    !!t.description_updated_at &&
    t.description_updated_at > t.summary_updated_at
  );
}

interface Fidelity {
  full: boolean;
  userCommentLimit: number; // newest-N user comments (protected — shed last)
  agentCommentLimit: number; // newest-N agent notes (shed first)
  collapseCriteria: boolean; // checklist -> count line + footer
  collapseSubtasks: boolean; // children list -> count line + footer
  dropSummary: boolean; // summary line -> trimmed footer
  dropDescription: boolean; // description line (summary fallback) -> trimmed footer
}

/**
 * Build the fixed-order working-set sections at a given fidelity. Re-invoked by
 * the budgeter to degrade specific sections in place. See docs/03 §3-4.
 */
function buildContextSections(repo: Repo, id: string, t: Task, fid: Fidelity): string[] {
  const sections: string[] = [];

  // 1. task line + summary
  sections.push(`${t.id} [${t.priority}] ${t.status}  "${t.title}"`);
  if (t.parent_id) sections.push(`parent: ${t.parent_id}`);
  if (t.assignee) sections.push(`assignee: ${t.assignee}`);
  if (t.summary) {
    sections.push(
      fid.dropSummary
        ? `[summary trimmed — context ${id} --full]`
        : `summary: ${t.summary}${summaryStale(t) ? '  [summary may be stale]' : ''}`,
    );
  } else if (t.description) {
    sections.push(
      fid.dropDescription ? `[description trimmed — context ${id} --full]` : `description: ${t.description}`,
    );
  }

  // 2. acceptance criteria (checklist, or collapsed to a count under budget)
  const crit = repo.getCriteria(id);
  if (crit.length) {
    const done = crit.filter((c) => c.checked).length;
    sections.push(
      fid.collapseCriteria
        ? `criteria ${done}/${crit.length}\n  [criteria collapsed — context ${id} --full]`
        : `criteria ${done}/${crit.length}:\n` +
            crit.map((c) => `  [${c.checked ? 'x' : ' '}] ${c.id} ${c.text}`).join('\n'),
    );
  }

  // 2.5 subtasks (direct children, or collapsed to a count under budget)
  const children = repo.getChildren(id);
  if (children.length) {
    const cdone = children.filter((c) => c.status === 'Done').length;
    sections.push(
      fid.collapseSubtasks
        ? `subtasks ${cdone}/${children.length}\n  [subtasks collapsed — context ${id} --full]`
        : `subtasks ${cdone}/${children.length}:\n` +
            children.map((c) => `  ${c.id} ${c.title} [${c.status}]`).join('\n'),
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

  // 5. comments — the user's directives (protected) first, then agent notes
  //    (shed first). Each block carries its own never-silent truncation footer.
  const userBlock = userCommentBlock(repo, id, fid.userCommentLimit, fid.full, 'context');
  if (userBlock) sections.push(userBlock);
  const agentBlock = agentNoteBlock(repo, id, fid.agentCommentLimit, fid.full, 'context');
  if (agentBlock) sections.push(agentBlock);

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

  return sections;
}

/**
 * `kanban context <id>` — the flagship curated working set in fixed section
 * order with deterministic, never-silent truncation. See docs/03 §3-4.
 *
 * Budgeting applies by default (`DEFAULT_CONTEXT_MAX_TOKENS`); pass an explicit
 * `--max-tokens N`, or opt out entirely with `--full` / `--max-tokens 0`.
 * Over budget, degrade gracefully in a fixed precedence — shed agent notes,
 * collapse criteria to a count, collapse the subtasks list to a count, trim the
 * summary (or the description, when that's the fallback shown), then (last
 * resort) trim user comments to a floor — before falling
 * back to dropping whole trailing sections. User comments (the human's
 * directives) are protected; every step leaves a footer.
 */
export function renderContext(
  repo: Repo,
  id: string,
  opts: { full?: boolean; maxTokens?: number } = {},
): string {
  const t = repo.requireTask(id);
  const userTotal = repo.countComments(id, 'user');
  const agentTotal = repo.countComments(id, 'non-user');
  const fid: Fidelity = {
    full: !!opts.full,
    userCommentLimit: opts.full ? userTotal : DEFAULT_USER_COMMENTS,
    agentCommentLimit: opts.full ? agentTotal : DEFAULT_COMMENTS,
    collapseCriteria: false,
    collapseSubtasks: false,
    dropSummary: false,
    dropDescription: false,
  };

  // Resolve the effective budget: explicit value wins; `0` and `--full` opt out;
  // otherwise the default ceiling applies.
  const max = opts.full ? 0 : opts.maxTokens === undefined ? DEFAULT_CONTEXT_MAX_TOKENS : opts.maxTokens;
  const render = () => buildContextSections(repo, id, t, fid);
  const over = (sections: string[]) => estimateTokens(sections.join('\n\n')) > max;

  let sections = render();
  if (!max) return sections.join('\n\n');

  // Ladder: each rung re-renders, re-estimates, and stops once under budget.
  // User comments (the human's directives) are protected — they shed last, and
  // never below USER_COMMENT_FLOOR while any exist.
  while (over(sections) && fid.agentCommentLimit > 0) {
    fid.agentCommentLimit--; // 1. shed agent notes first (floor: footer only)
    sections = render();
  }
  if (over(sections) && !fid.collapseCriteria) {
    fid.collapseCriteria = true; // 2. collapse criteria to a count
    sections = render();
  }
  if (over(sections) && !fid.collapseSubtasks) {
    fid.collapseSubtasks = true; // 3. collapse the subtasks list to a count
    sections = render();
  }
  if (over(sections) && !fid.dropSummary) {
    fid.dropSummary = true; // 4. trim the summary
    sections = render();
  }
  if (over(sections) && !fid.dropDescription) {
    fid.dropDescription = true; // 4.5 trim the description (summary fallback)
    sections = render();
  }
  while (over(sections) && fid.userCommentLimit > USER_COMMENT_FLOOR) {
    fid.userCommentLimit--; // 5. trim user comments last (floor: newest 2)
    sections = render();
  }
  return budget(sections, max, id); // 6. drop whole trailing sections
}

/**
 * Final fallback: drop whole trailing sections (lowest priority first) until
 * under budget, always leaving an explicit footer. Never silent.
 */
function budget(sections: string[], maxTokens: number, id: string): string {
  return budgetBlocks(
    sections,
    { maxTokens },
    '\n\n',
    (n) => `[${n} section(s) hidden for token budget — context ${id} --full]`,
  );
}

// ---- analytics tier (FORMAT_VERSION 5) -----------------------------------

/** Human-friendly duration: `0m` / `45m` / `3h 10m` / `2d 4h`. */
export function fmtDur(msv: number | null): string {
  if (msv === null) return '—';
  if (msv < 60000) return '0m';
  const m = Math.floor(msv / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60 ? ` ${m % 60}m` : '');
  const d = Math.floor(h / 24);
  return d + 'd' + (h % 24 ? ` ${h % 24}h` : '');
}

const SPARK = '▁▂▃▄▅▆▇█';
/** Unicode sparkline over a numeric series (flat bar when all-equal/empty). */
function sparkline(values: number[]): string {
  if (!values.length) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return SPARK[0].repeat(values.length);
  return values.map((v) => SPARK[Math.round(((v - min) / (max - min)) * (SPARK.length - 1))]).join('');
}

function perStatusLine(label: string, m: Record<WorkflowStatus, number>, fmt: (n: number) => string): string {
  return `${label}: ` + WORKFLOW_STATUSES.map((s) => `${s} ${fmt(m[s])}`).join('  ·  ');
}

/** `kanban stats` — board analytics. Token-budgeted, never-silent on compaction. */
export function renderStats(stats: BoardStats, opts: { full?: boolean; maxTokens?: number } = {}): string {
  const w = stats.window;
  const tp = stats.throughput;
  const lead = stats.timing_summary.lead_ms;
  const cycle = stats.timing_summary.cycle_ms;

  const blocks: string[] = [
    `board stats · window ${w.days}d (${w.from} … ${w.to})`,
    `throughput: ${tp.total} done / ${w.days}d  ·  ${tp.rolling_avg_per_day}/day  ·  ${tp.per_week}/week`,
    perStatusLine('WIP', wipCounts(stats), (n) => String(n)),
    `lead p50 ${fmtDur(lead.p50)} · p90 ${fmtDur(lead.p90)} (n=${lead.n})   cycle p50 ${fmtDur(cycle.p50)} · p90 ${fmtDur(cycle.p90)} (n=${cycle.n})`,
    `burndown (remaining): ${sparkline(stats.burndown.map((p) => p.remaining))}  ${burndownEnds(stats)}`,
    `velocity: ${sparkline(tp.series.map((p) => p.completed))}`,
    agingLine(stats),
  ].filter(Boolean);

  if (stats.partial_history)
    blocks.push(
      `[history bounded: metrics cover events since seq ${stats.compaction_floor}; ${stats.excluded_partial.length} task(s) excluded from timing — older history compacted]`,
    );

  return budgetBlocks(blocks, opts, '\n', (n) => `[+${n} line(s) hidden for token budget — stats --full]`);
}

function wipCounts(stats: BoardStats): Record<WorkflowStatus, number> {
  const m = {} as Record<WorkflowStatus, number>;
  for (const c of stats.wip) m[c.status] = c.count;
  return m;
}

function burndownEnds(stats: BoardStats): string {
  const b = stats.burndown;
  if (!b.length) return '';
  return `(${b[0].remaining} → ${b[b.length - 1].remaining})`;
}

function agingLine(stats: BoardStats): string {
  const aged = stats.wip
    .filter((c) => c.oldest && c.status !== 'Done' && c.status !== 'Backlog')
    .map((c) => `${c.status} ${c.oldest!.id} ${fmtDur(c.oldest!.age_ms)}`);
  return aged.length ? `oldest: ${aged.join('  ·  ')}` : '';
}

/** `kanban stats <id>` — per-task timing. */
export function renderTaskStats(t: TaskTiming, opts: { full?: boolean; maxTokens?: number } = {}): string {
  const flagBits: string[] = [];
  if (t.reopened) flagBits.push(`reopened ×${t.reopen_count}`);
  if (t.never_in_progress) flagBits.push('never In Progress');
  if (t.archived) flagBits.push('archived');
  if (t.partial_history) flagBits.push('partial history');

  const blocks: string[] = [
    `${t.id} [${t.status}]  lead ${fmtDur(t.lead_ms)} · cycle ${fmtDur(t.cycle_ms)} · in-status ${fmtDur(t.time_in_current_status_ms)}`,
    perStatusLine('time', t.time_per_status, fmtDur),
  ];
  if (t.active_in_progress_ms && t.reopened) blocks.push(`active In Progress (all stints): ${fmtDur(t.active_in_progress_ms)}`);
  if (flagBits.length) blocks.push(`flags: ${flagBits.join(' · ')}`);
  if (t.partial_history)
    blocks.push('[history bounded: this task predates the compaction floor — timing is best-effort]');

  return budgetBlocks(blocks, opts, '\n', (n) => `[+${n} line(s) hidden for token budget — stats ${t.id} --full]`);
}
