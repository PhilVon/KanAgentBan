import type { Repo } from './repo';
import type { DoctorFinding, DoctorReport } from './doctor';
import type { StandupReport } from './standup';
import { childProgress, countCriteria, deriveState, fmtCriteria, remainingBlockerCount } from './derive';
import {
  affectLine,
  consultOptionsCommand,
  cuesFor,
  cuesForLabels,
  MAX_CONSULT_OPTIONS,
  type AffectConfig,
} from './affect';
import { recommend, type BlockedSummary } from './recommend';
import { LABEL_TOP_N, type BoardStats, type MetricSummary, type TaskTiming, type VelocityTrend } from './stats';
import {
  WORKFLOW_STATUSES,
  type AcceptanceCriterion,
  type BrainstormSession,
  type Comment,
  type Doc,
  type Idea,
  type SearchResult,
  type Task,
  type WorkflowStatus,
} from '../shared/types';

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
// v7: analytics expansion — `stats` gains flow-efficiency, input-wait latency, net
//     flow, aging buckets/flags, rework, per-priority/label/agent tables, drain
//     forecast, and a CFD series. New lines render after the core block (shed first
//     under budget); `stats <id>` gains a flow-efficiency line.
// v8: `stats` gains a per-status dwell line with a bottleneck flag, and the
//     velocity line carries a trend annotation (recent vs prior half-window).
// v9: docs tier — `docs` list and `doc show` render board-native documents
//     (design/adr/spike/research/note); `context` gains a docs section
//     (titles + summaries only, body via `doc show`). See ADR 0007.
// v10: search tier — `search` renders one budgeted line per hit
//     (task/doc/comment) with a matched-text snippet.
// v11: brainstorm tier — `brainstorm show` renders clustered, score-ranked
//     ideas (sheds lowest clusters first); `brainstorm list` one line per
//     session; `context` gains a one-line open-session anchor; search hits
//     cover ideas.
// v12: git linkage — artifact kinds extended with `commit` (`git:<sha>`) and
//     `branch` (`branch:<name>`); `kanban git status` renders a CLI-side view
//     merging board artifacts with live repo/PR state (ADR 0008).
// v13: checkpoint — the one-slot resume pointer renders first in `show`/`context`
//     (right under the task head, above all comments) and is never shed under
//     budget; `next` flags a waiting checkpoint on its recommendation line.
// v14: claim leases — `context`'s assignee line carries the lease state
//     (`lease expires in 42m` / `lease expired`) when a claim has a TTL.
// v15: doctor tier — `kanban doctor` renders the hygiene report (findings
//     grouped by check, healthy = one line); CLI exit 2 signals findings.
// v16: default-on-expiry answers — `context` open-input lines carry
//     `[default on expiry: X]`; `inbox` marks defaulted answers.
// v17: standup tier — `kanban standup` renders the narrative board diff
//     (completed / kickbacks / moved / new / question traffic / aging) since a
//     cursor or over a day window, floor-clamped never-silently.
// v18: pace/age-aware analytics — stats header shows the adaptive bucket size,
//     rates render per-hour when fast (`fmtRate`), forecast ETA gains hour
//     precision when the drain is near, and aging lines show the pace-derived
//     threshold. Standup aging renders `fmtDur(age_ms)` against that threshold.
// v19: doctor blind spots — every finding line carries a trailing
//     `[cannot see: …]` clause naming what its own check is blind to, and the
//     pre-written command in the finding is phrased conditionally to match. New
//     `answered-elsewhere` check (open request on a Done/Review task), so the
//     healthy line now reads "7 checks clean".
// v20: loose search — when an all-terms query finds nothing, `search` retries
//     OR-ranked and the result set leads with a `[loose: …]` header naming what
//     it did; `--json` carries `loose`.
// v21: watches (`kanban expect`) — a request carries a `kind`, so `show`/`context`
//     tag an open watch `[watch]` and say it is not blocking, `inbox` lists
//     watches under their own heading, and `standup` counts them in `watching` /
//     `watch resolutions` rather than as question traffic.
// v22: criterion states — a criterion can be `retired` (wrong, not undone; leaves
//     both sides of the count and renders `[~]` with its reason and successor) or
//     flagged `human` (only the human settles it; renders `[human]`). The count
//     line grows `· N retired` / `· N for the human` tails ONLY when non-zero, so
//     an ordinary task still reads `criteria 5/6`.
// v23: answer notes — `answer --note "<why>"` stores the reason beside the choice;
//     `inbox` prints it under the answer, and `show`/`context` gain a `decisions`
//     block (recent answered questions, `Q-n "…" → answer` + `why:`).
// v24: affect hints (opt-in, off by default) — `next` with 2+ ready candidates,
//     `claim` and `brainstorm start` emit an `affect: eb consult …` line, and
//     `context` a `cues:` line from the task's labels. Text only: the board never
//     runs `eb` (ADR 0009). The `next` hint sheds first under budget, never
//     silently. Nothing is emitted by `ask`, and nothing appears on `doctor`.
// v25: cues are map-only — a board label with no `board affect --map` entry emits
//     NO cue, where it used to fall back to `activity:<label>`. The board minting
//     vocabulary out of its own bookkeeping labels was cue sprawl at the source,
//     and `eb` cue keys are immutable (no rename, no merge), so a bad cue costs
//     evidence permanently while silence costs one prompt. The board therefore
//     emits less rather than the agent being allowed less. `context` names the
//     labels that went unmapped and how to map them, so the silence is never
//     unexplained.
export const FORMAT_VERSION = 25;

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

/**
 * Default token ceiling for `doc show` — docs store real content (ADR 0007), so
 * the body renders budgeted by default; opt out with `--full` / `--max-tokens 0`.
 */
export const DEFAULT_DOC_MAX_TOKENS = 2000;

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
 * Resolved questions — the decisions section. The answer is the record of a
 * choice the human made, and `answer --note` carries the *why*, which is the
 * half a reader in six months actually needs (these get quoted in code
 * comments). Empty when nothing has been answered, so an ordinary task is
 * unaffected.
 */
function decisionsBlock(repo: Repo, id: string, limit: number): string | null {
  if (limit <= 0) return null;
  const answered = repo.getAnsweredRequests(id, limit);
  if (!answered.length) return null;
  const rows = answered.map((q) => {
    const defaulted = q.answered_by === 'system:default' ? ' (defaulted)' : '';
    const head = `  ${q.id} "${q.question}" → ${q.answer}${defaulted}`;
    return q.answer_note ? `${head}\n      why: ${q.answer_note}` : head;
  });
  return `decisions (${answered.length}):\n` + rows.join('\n');
}

/**
 * One criterion line. A retired one gets its own box glyph rather than a tick or
 * a blank — both of which would be lies — and carries the reason, which is the
 * whole point of the state. A `human` one says whose eyes settle it, so it stops
 * reading as work the agent is failing to finish.
 */
function criterionLine(c: AcceptanceCriterion): string {
  if (c.retired_at) {
    const successor = c.successor_task_id ? ` (→ ${c.successor_task_id})` : '';
    return `  [~] ${c.id} ${c.text}  — retired: ${c.retire_reason}${successor}`;
  }
  return `  [${c.checked ? 'x' : ' '}] ${c.id} ${c.text}${c.human ? '  [human]' : ''}`;
}

/**
 * The resume pointer — the first thing a cold session should read, so it
 * renders directly under the task head in `show`/`context` and is never shed
 * under token budget (one line, and "where was I" is the whole point).
 */
function checkpointLine(t: Task): string | null {
  if (!t.checkpoint) return null;
  const by = t.checkpoint_by && t.checkpoint_by !== 'agent' ? ` by ${t.checkpoint_by}` : '';
  return `checkpoint (${rel(t.checkpoint_at!)} ago${by}): ${t.checkpoint}`;
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

/** ` (lease expires in 42m)` / ` (lease expired)` — empty for indefinite claims. */
function leaseSuffix(t: Task): string {
  if (!t.assignee || !t.claim_expires_at) return '';
  const remaining = new Date(t.claim_expires_at).getTime() - Date.now();
  return remaining > 0 ? `  (lease expires in ${fmtDur(remaining)})` : '  (lease expired)';
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
  opts: {
    context?: boolean;
    n?: number;
    agent?: string;
    mine?: boolean;
    full?: boolean;
    maxTokens?: number;
    affect?: AffectConfig;
  },
): string {
  const r = recommend(repo, opts.n ?? 1, opts.agent, opts.mine);
  if ('none' in r) return renderBlocked(r);
  if (opts.context && r[0]) {
    const ctx = renderContext(repo, r[0].task.id, {
      full: opts.full,
      maxTokens: opts.maxTokens,
      affect: opts.affect,
    });
    return `${renderRecLine(r[0].task)}\nwhy: ${r[0].why}\n\n${ctx}`;
  }
  const blocks = r.map((rec) => {
    const callout = userCommentCallout(repo, rec.task.id);
    const cp = checkpointLine(rec.task);
    return `${renderRecLine(rec.task)}\nwhy: ${rec.why}${cp ? `\n  ↳ ${cp}` : ''}${callout ? `\n${callout}` : ''}`;
  });
  // The affect hint. A choice is only a choice with two or more candidates, so
  // ask for up to the consult cap regardless of --n. It is always its own
  // labelled line and never folded into `why:` — otherwise it reads as the
  // board's judgement rather than the agent's, and the human cannot tell them
  // apart (ADR 0009).
  let hint: string | null = null;
  if (opts.affect?.enabled) {
    const cands = recommend(repo, Math.max(opts.n ?? 1, MAX_CONSULT_OPTIONS), opts.agent, opts.mine);
    if (!('none' in cands)) hint = affectLine(consultOptionsCommand(cands.map((c) => c.task.title)));
  }
  // It sheds FIRST: a preference nudge is the cheapest thing to lose, and losing
  // it is never silent.
  const max = opts.full ? 0 : opts.maxTokens;
  const fits = !max || !hint || estimateTokens(`${blocks.join('\n\n')}\n${hint}`) <= max;
  const body = budgetBlocks(blocks, opts, '\n\n', (n) => `[+${n} candidates hidden for token budget — kanban next --full]`);
  const tail = hint
    ? `\n${fits ? hint : '[affect hint hidden for token budget — kanban next --full]'}`
    : '';
  return `${body}${tail}\n(use: kanban context <id>  ·  kanban next --context)`;
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
  const cp = checkpointLine(t);
  if (cp) lines.push(cp);
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
    `criteria ${fmtCriteria(countCriteria(crit))}  ·  blockers ${remainingBlockerCount(repo.db, id)}` +
      (kids.total ? `  ·  subtasks ${kids.done}/${kids.total}` : '') +
      `  ·  comments ${repo.countComments(id)}  ·  open input ${open.length}${t.assignee ? `  ·  assignee ${t.assignee}` : ''}`,
  );
  if (open.length)
    lines.push(
      fid.dropOpen
        ? `  [open input hidden — show ${id} --full]`
        : open.map((q) => `  ${q.id} ${q.kind === 'watch' ? '[watch] ' : ''}"${q.question}"`).join('\n'),
    );
  // Decisions ride with the open-input rung: both are the HITL channel, and a
  // tight budget sheds the resolved half before the pending half — but never
  // silently, so a dropped block still leaves its footer.
  if (repo.getAnsweredRequests(id, 1).length)
    lines.push(
      fid.dropOpen
        ? `  [decisions hidden — show ${id} --full]`
        : decisionsBlock(repo, id, 2)!,
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
  /** Affect config when hints are on — adds a `cues:` line (ADR 0009). */
  affect?: AffectConfig;
}

/**
 * Build the fixed-order working-set sections at a given fidelity. Re-invoked by
 * the budgeter to degrade specific sections in place. See docs/03 §3-4.
 */
function buildContextSections(repo: Repo, id: string, t: Task, fid: Fidelity): string[] {
  const sections: string[] = [];

  // 1. task line + checkpoint (the resume pointer reads first) + summary
  sections.push(`${t.id} [${t.priority}] ${t.status}  "${t.title}"`);
  const cp = checkpointLine(t);
  if (cp) sections.push(cp);
  if (t.parent_id) sections.push(`parent: ${t.parent_id}`);
  if (t.assignee) sections.push(`assignee: ${t.assignee}${leaseSuffix(t)}`);
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
    const count = fmtCriteria(countCriteria(crit));
    sections.push(
      fid.collapseCriteria
        ? `criteria ${count}\n  [criteria collapsed — context ${id} --full]`
        : `criteria ${count}:\n` + crit.map(criterionLine).join('\n'),
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

  // 4. open input requests. A watch is tagged: it is waiting for an event, not
  //    for the human, and reading it as an unanswered question is the mistake
  //    `expect` exists to prevent.
  const open = repo.getOpenRequests(id);
  if (open.length)
    sections.push(
      `open input (${open.length}):\n` +
        open
          .map(
            (q) =>
              `  ${q.id} ${q.kind === 'watch' ? '[watch] ' : ''}"${q.question}"${q.options ? `  options: ${q.options.join(' | ')}` : ''}${q.default_answer ? `  [default on expiry: ${q.default_answer}]` : ''}${q.kind === 'watch' ? '  (not blocking — waiting for this to happen)' : ''}`,
          )
          .join('\n'),
    );

  // 4.4 cues — the task's MAPPED labels as `eb` cue keys, so an `eb feel` written
  //     during this work inherits the vocabulary instead of reinventing it (cue
  //     sprawl is how a brain becomes useless). An unmapped label emits nothing,
  //     but never nothing *silently*: the labels that produced no cue are named
  //     with the one command that fixes them. Text only: the board never runs
  //     `eb` and never reads the brain — ADR 0009.
  if (fid.affect?.enabled) {
    const { cues, unmapped } = cuesFor(repo.getLabels(id), fid.affect.map);
    // The fix hint deliberately shows `<cue>` rather than a slug of the label:
    // suggesting `activity:docs` would have the board proposing the very
    // near-duplicate its own starter vocabulary flags. The choice is the agent's.
    const fix = `kanban board affect --map <label>=<cue>`;
    const tail = unmapped.length ? `; unmapped: ${unmapped.join(', ')} — ${fix}` : '';
    if (cues.length)
      sections.push(`cues: ${cues.join(', ')}  (use these with eb feel/consult — inherited, not invented)${tail}`);
    else if (unmapped.length) sections.push(`cues: none — unmapped: ${unmapped.join(', ')} — ${fix}`);
  }

  // 4.5 decisions — questions the human has answered, with the reason when one
  //     was given. Design intent outlives the moment it unblocked.
  const decisions = decisionsBlock(repo, id, 3);
  if (decisions) sections.push(decisions);

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

  // 6.5 linked docs (titles + summaries only — body via `doc show D-n`)
  const docs = repo.getTaskDocs(id);
  if (docs.length)
    sections.push(
      `docs (${docs.length}):\n` +
        docs.map((d) => `  ${docLine(d)}`).join('\n') +
        `\n  (body: kanban doc show <D-id>)`,
    );

  // 6.7 open brainstorm anchored to this task — one line, body via its own tier
  const sessions = repo.listBrainstorms({ task: id, status: 'open' });
  for (const s of sessions) {
    const ideas = repo.getIdeas(s.id);
    const promoted = ideas.filter((i) => i.status === 'promoted').length;
    sections.push(
      `brainstorm: ${s.id} "${s.topic}" (${ideas.length} ideas · ${promoted} promoted) — kanban brainstorm show ${s.id}`,
    );
  }

  // 7. labels
  const labels = repo.getLabels(id);
  if (labels.length) sections.push(`labels: ${labels.join(', ')}`);

  return sections;
}

/** `kanban brainstorm list` — one line per session, newest first. */
export function renderBrainstormList(repo: Repo, sessions: BrainstormSession[], opts: { full?: boolean; maxTokens?: number } = {}): string {
  if (!sessions.length) return '(no brainstorms)';
  const rows = sessions.map((s) => {
    const ideas = repo.getIdeas(s.id);
    const promoted = ideas.filter((i) => i.status === 'promoted').length;
    const anchor = s.task_id ? `  ⤷${s.task_id}` : '';
    return `${s.id} [${s.status}] "${s.topic}"  ${ideas.length} ideas · ${promoted} promoted${anchor}`;
  });
  return budgetBlocks(rows, opts, '\n', (n) => `[+${n} sessions hidden for token budget — brainstorm list --full]`);
}

/**
 * `kanban brainstorm show B-n` — ideas grouped by cluster (clusters ranked by
 * their best idea, ideas score-desc within), promoted/discarded flagged.
 * Budgeted: whole trailing (lowest-ranked) cluster blocks shed first.
 */
export function renderBrainstorm(
  repo: Repo,
  id: string,
  opts: { full?: boolean; maxTokens?: number } = {},
): string {
  const s = repo.requireBrainstorm(id);
  const ideas = repo.getIdeas(id);
  const promoted = ideas.filter((i) => i.status === 'promoted').length;
  const head =
    `${s.id} [${s.status}] "${s.topic}"` +
    (s.task_id ? `  ⤷${s.task_id}` : '') +
    `\nideas ${ideas.length} · promoted ${promoted} · discarded ${ideas.filter((i) => i.status === 'discarded').length}`;
  if (!ideas.length) return `${head}\n(no ideas yet — kanban brainstorm add ${id} "…")`;

  // Group by cluster; getIdeas is already best-first so group order = rank order.
  const groups = new Map<string, Idea[]>();
  for (const i of ideas) {
    const key = i.cluster ?? '(unclustered)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }
  const blocks = [...groups.entries()].map(([cluster, list]) => {
    const lines = list.map((i) => {
      const score = i.score !== null ? `[${String(i.score).padStart(2)}]` : '[ –]';
      const mark = i.status === 'promoted' ? `  → ${i.promoted_task_id}` : i.status === 'discarded' ? '  ✕ discarded' : '';
      return `  ${score} ${i.id} ${i.text}${mark}`;
    });
    return `${cluster}:\n${lines.join('\n')}`;
  });
  return (
    head +
    '\n\n' +
    budgetBlocks(blocks, opts, '\n\n', (n) => `[+${n} cluster(s) hidden for token budget — brainstorm show ${id} --full]`)
  );
}

/** One terse doc line shared by the list tier and the context docs section. */
function docLine(d: Doc): string {
  const sup = d.status === 'superseded' && d.superseded_by ? ` → ${d.superseded_by}` : '';
  const summary = d.summary ? ` — ${d.summary}` : '';
  return `${d.id} [${d.kind}/${d.status}${sup}] "${d.title}"${summary}`;
}

/** `kanban docs` — compact one-line-per-doc list. */
export function renderDocList(
  docs: Doc[],
  opts: { full?: boolean; maxTokens?: number } = {},
): string {
  if (!docs.length) return '(no docs)';
  const rows = docs.map(docLine);
  return budgetBlocks(rows, opts, '\n', (n) => `[+${n} docs hidden for token budget — kanban docs --full]`);
}

/**
 * `kanban doc show D-n` — summary + full markdown body, budgeted by default
 * (`DEFAULT_DOC_MAX_TOKENS`): the body tail sheds line-by-line with a
 * never-silent footer. Docs deliberately store content (ADR 0007) — this
 * budget is the read-side guard rail.
 */
export function renderDoc(
  repo: Repo,
  id: string,
  opts: { full?: boolean; maxTokens?: number } = {},
): string {
  const d = repo.requireDoc(id);
  const tasks = repo.getDocTasks(id);
  const head: string[] = [docLine(d)];
  if (tasks.length) head.push(`linked tasks: ${tasks.join(', ')}`);
  head.push(`updated ${rel(d.updated_at)} ago${d.archived_at ? '  [archived]' : ''}`);
  const header = head.join('\n');
  if (!d.body) return `${header}\n\n(no body)`;

  const max = opts.full ? 0 : opts.maxTokens === undefined ? DEFAULT_DOC_MAX_TOKENS : opts.maxTokens;
  if (!max) return `${header}\n\n${d.body}`;

  const bodyLines = d.body.split('\n');
  let kept = bodyLines.length;
  const build = () =>
    `${header}\n\n${bodyLines.slice(0, kept).join('\n')}` +
    (kept < bodyLines.length
      ? `\n[body trimmed: ${bodyLines.length - kept} more line(s) — doc show ${id} --full]`
      : '');
  let out = build();
  while (kept > 1 && estimateTokens(out) > max) {
    // Halve-then-step keeps this O(log n) for token-bomb bodies.
    kept = estimateTokens(out) > max * 2 ? Math.floor(kept / 2) : kept - 1;
    out = build();
  }
  return out;
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
  opts: { full?: boolean; maxTokens?: number; affect?: AffectConfig } = {},
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
    affect: opts.affect,
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

/**
 * `kanban search` — one line per hit, budgeted (rank order, sheds the tail).
 * A loose result set leads with a header saying so: these came from an OR retry
 * after nothing matched every term, and reading them as exact matches is the
 * mistake the header exists to prevent. The header is the first row, so the
 * budget sheds hits before it.
 */
export function renderSearch(
  results: SearchResult[],
  query: string,
  opts: { full?: boolean; maxTokens?: number; loose?: boolean } = {},
): string {
  if (!results.length) return `(no matches for "${query}")`;
  const rows = results.map((r) => {
    const badge =
      r.type === 'doc'
        ? `[doc/${r.kind}]`
        : r.type === 'comment'
          ? `[comment on ${r.task_id}]`
          : r.type === 'idea'
            ? `[idea/${r.status}${r.task_id ? ` → ${r.task_id}` : ''}]`
            : `[task/${r.status}]`;
    const title = r.title ? ` "${r.title}"` : '';
    return `${r.id} ${badge}${title} — ${r.snippet}`;
  });
  if (opts.loose)
    rows.unshift(
      `[loose: nothing matched every term of "${query}" — these match at least one, best first]`,
    );
  return budgetBlocks(rows, opts, '\n', (n) => `[+${n} hits hidden for token budget — search --full]`);
}

// ---- standup tier (FORMAT_VERSION 17) --------------------------------------

/**
 * `kanban standup` — the narrative board diff. Head line first, then sections
 * in catch-up priority order (what finished, what bounced, what's stuck);
 * empty sections render nothing. Budgeted: trailing sections shed first.
 */
export function renderStandup(
  r: StandupReport,
  opts: { full?: boolean; maxTokens?: number } = {},
): string {
  const windowLabel =
    r.window_days !== null ? `last ${r.window_days}d` : `since seq ${r.since}`;
  const head = `standup · ${windowLabel} · cursor ${r.cursor}`;
  const blocks: string[] = [head];

  if (r.completed.length)
    blocks.push(
      `completed (${r.completed.length}):\n` +
        r.completed.map((c) => `  ${c.id} ${c.title}${c.via_review ? '  [review approved]' : ''}`).join('\n'),
    );
  if (r.rejected.length)
    blocks.push(
      `review kickbacks (${r.rejected.length}):\n` +
        r.rejected.map((k) => `  ${k.id} ${k.title} — "${k.reason}"`).join('\n'),
    );
  if (r.moved.length)
    blocks.push(
      `moved (${r.moved.length}):\n` + r.moved.map((m) => `  ${m.id} ${m.title}  ${m.from} → ${m.to}`).join('\n'),
    );
  if (r.created.length)
    blocks.push(
      `new (${r.created.length}):\n` + r.created.map((c) => `  ${c.id} ${c.title} [${c.status}]`).join('\n'),
    );
  if (r.answered.length)
    blocks.push(
      `answered (${r.answered.length}):\n` +
        r.answered.map((a) => `  ${a.id} on ${a.task_id}: "${a.answer}"${a.defaulted ? ' (defaulted)' : ''}`).join('\n'),
    );
  if (r.asked.length)
    blocks.push(
      `asked (${r.asked.length}):\n` + r.asked.map((q) => `  ${q.id} on ${q.task_id}: "${q.question}"`).join('\n'),
    );
  if (r.resolved.length)
    blocks.push(
      `question resolutions (${r.resolved.length}):\n` +
        r.resolved.map((q) => `  ${q.id} ${q.status} (task ${q.task_id})`).join('\n'),
    );
  // Watches are counted apart from questions: they are not the human's queue, and
  // folding them in makes a quiet board look like it is waiting on someone.
  if (r.watched.length)
    blocks.push(
      `watching (${r.watched.length}):\n` +
        r.watched.map((w) => `  ${w.id} on ${w.task_id}: "${w.event}"`).join('\n'),
    );
  if (r.watch_resolved.length)
    blocks.push(
      `watch resolutions (${r.watch_resolved.length}):\n` +
        r.watch_resolved.map((w) => `  ${w.id} ${w.status} (task ${w.task_id})`).join('\n'),
    );
  if (r.aging.length) {
    const paceTag = r.pace.basis === 'cycle-time' ? ' (pace)' : '';
    blocks.push(
      `aging >${fmtDur(r.pace.stale_ms)}${paceTag} (${r.aging.length}):\n` +
        r.aging.map((a) => `  ${a.id} ${a.title} [${a.status}] ${fmtDur(a.age_ms)}`).join('\n'),
    );
  }

  if (blocks.length === 1) blocks.push('(quiet — nothing happened in the window)');
  if (r.floor_clamped)
    blocks.push(`[history bounded: events below seq ${r.floor} compacted — digest starts there]`);

  return budgetBlocks(blocks, opts, '\n', (n) => `[+${n} section(s) hidden for token budget — standup --full]`);
}

// ---- doctor tier (FORMAT_VERSION 15) --------------------------------------

/**
 * `kanban doctor` — the hygiene report. One line per finding, grouped by check
 * in CHECKS order (the groups are rank-ordered: claims first — they block
 * peers — then missing definitions of done, aging work, unanswered questions,
 * drift, and easy closes). Budgeted like every read tier.
 */
export function renderDoctor(
  report: DoctorReport,
  opts: { full?: boolean; maxTokens?: number } = {},
): string {
  if (report.healthy) return `board healthy — ${report.checks.length} checks clean`;
  const byCheck = new Map<string, DoctorFinding[]>();
  for (const f of report.findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check)!.push(f);
  }
  const blocks: string[] = [
    `${report.findings.length} finding(s) across ${byCheck.size} of ${report.checks.length} checks:`,
  ];
  for (const check of report.checks) {
    const fs = byCheck.get(check);
    if (!fs) continue;
    blocks.push(
      `${check} (${fs.length}):\n` +
        fs
          .map((f) => `  ${f.id}  ${f.detail}` + (f.blind_spot ? ` [cannot see: ${f.blind_spot}]` : ''))
          .join('\n'),
    );
  }
  return budgetBlocks(blocks, opts, '\n', (n) => `[+${n} block(s) hidden for token budget — doctor --full]`);
}

// ---- analytics tier (FORMAT_VERSION 5) -----------------------------------

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

const DAY_MS = 86_400_000;

/** A per-day rate at the natural unit: `2.5/h` when brisk (≥24/day), else `0.3/d`.
 *  Keeps a fast agent-driven board legible without a false "N/day" that reads as
 *  slower than it is. */
export function fmtRate(perDay: number): string {
  return perDay >= 24 ? `${round1(perDay / 24)}/h` : `${round2(perDay)}/d`;
}

/** A bucket-start ISO timestamp as an axis label, scaled to the bucket width:
 *  `14:05` (UTC) for sub-day buckets, `07-10` for day-or-coarser. */
export function fmtBucketTick(iso: string, bucketMs: number): string {
  return bucketMs < DAY_MS ? iso.slice(11, 16) : iso.slice(5, 10);
}

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
  const tp = stats.throughput;
  const lead = stats.timing_summary.lead_ms;
  const cycle = stats.timing_summary.cycle_ms;

  const blocks: string[] = [
    statsHeader(stats),
    throughputLine(stats),
    perStatusLine('WIP', wipCounts(stats), (n) => String(n)),
    `lead p50 ${fmtDur(lead.p50)} · p90 ${fmtDur(lead.p90)} (n=${lead.n})   cycle p50 ${fmtDur(cycle.p50)} · p90 ${fmtDur(cycle.p90)} (n=${cycle.n})`,
    `burndown (remaining): ${sparkline(stats.burndown.map((p) => p.remaining))}  ${burndownEnds(stats)}`,
    `velocity: ${sparkline(tp.series.map((p) => p.completed))}${trendSuffix(tp.trend)}`,
    agingLine(stats),
    // --- expansion lines (FORMAT_VERSION 7) — appended after the core block so
    //     never-silent budgeting sheds them first. ---
    flowEfficiencyLine(stats),
    netFlowLine(stats),
    inputWaitLine(stats),
    agingFlagsLine(stats),
    qualityLine(stats),
    byPriorityLine(stats),
    byLabelLine(stats),
    byAgentLine(stats),
    forecastLine(stats),
    dwellLine(stats),
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

/** `board stats · window 14d · 12h buckets · 29 pts (06-26 … 07-10)`, or, on a
 *  board younger than the requested window with sub-day buckets, `board age 6h`. */
function statsHeader(stats: BoardStats): string {
  const w = stats.window;
  const subDay = w.bucket_ms < DAY_MS;
  const scale = w.clamped && subDay ? `board age ${fmtDur(w.span_ms)}` : `window ${w.days}d`;
  const from = fmtBucketTick(w.from, w.bucket_ms);
  const to = fmtBucketTick(w.to, w.bucket_ms);
  return `board stats · ${scale} · ${w.bucket} buckets · ${w.buckets} pts (${from} … ${to}${subDay ? ' UTC' : ''})`;
}

function throughputLine(stats: BoardStats): string {
  const w = stats.window;
  const tp = stats.throughput;
  // `/week` only reads meaningfully once the span covers at least a week.
  const week = w.span_ms >= 7 * DAY_MS ? `  ·  ${tp.per_week}/week` : '';
  return `throughput: ${tp.total} done / ${fmtDur(w.span_ms)}  ·  ${fmtRate(tp.rolling_avg_per_day)}${week}`;
}

/** ISO timestamp → `2026-07-10 21:00 UTC` for hour-precision ETAs. */
function fmtEtaHour(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function agingLine(stats: BoardStats): string {
  const aged = stats.wip
    .filter((c) => c.oldest && c.status !== 'Done' && c.status !== 'Backlog')
    .map((c) => `${c.status} ${c.oldest!.id} ${fmtDur(c.oldest!.age_ms)}`);
  return aged.length ? `oldest: ${aged.join('  ·  ')}` : '';
}

/** A [0,1] ratio as a whole percent; `—` for an empty (n=0) summary. */
const pct = (r: number): string => `${Math.round(r * 100)}%`;
const summaryPct = (m: MetricSummary): string =>
  m.n ? `p50 ${pct(m.p50)} · avg ${pct(m.avg)} (n=${m.n})` : '—';

function flowEfficiencyLine(stats: BoardStats): string {
  return `flow efficiency: ${summaryPct(stats.timing_summary.flow_efficiency)}`;
}

function netFlowLine(stats: BoardStats): string {
  const f = stats.flow;
  const sign = f.net_per_day > 0 ? '+' : '';
  return `net flow: +${fmtRate(f.arrival_per_day)} in · −${fmtRate(f.departure_per_day)} out · net ${sign}${fmtRate(f.net_per_day)} (${f.trend})`;
}

function inputWaitLine(stats: BoardStats): string {
  const w = stats.input_wait;
  if (!w.open && !w.answered && !w.expired && !w.cancelled) return '';
  const resolved = w.resolved.n ? `resolved p50 ${fmtDur(w.resolved.p50)} · p90 ${fmtDur(w.resolved.p90)} (n=${w.resolved.n})` : 'none resolved';
  const oldest = w.oldest_open_ms !== null ? ` (oldest ${fmtDur(w.oldest_open_ms)})` : '';
  return `input-wait: ${w.open} open${oldest} · ${resolved} · ${w.answered}a/${w.expired}x/${w.cancelled}c`;
}

function agingFlagsLine(stats: BoardStats): string {
  const f = stats.aging_flags;
  if (!f.length) return '';
  const head = f.slice(0, 5).map((a) => `${a.id} ${fmtDur(a.age_ms)}`).join(' · ');
  const more = f.length > 5 ? ` (+${f.length - 5} more)` : '';
  const paceTag = stats.pace.basis === 'cycle-time' ? ' (pace)' : '';
  return `aging >${fmtDur(stats.pace.stale_ms)}${paceTag} (${f.length}): ${head}${more}`;
}

function qualityLine(stats: BoardStats): string {
  const q = stats.quality;
  if (!q.reopened && !q.kickbacks) return '';
  return `rework: reopened ${q.reopened} (${pct(q.reopen_rate)}) · kickbacks ${q.kickbacks} (${pct(q.kickback_rate)})`;
}

function byPriorityLine(stats: BoardStats): string {
  const rows = stats.by_priority.filter((p) => p.n || p.wip);
  if (!rows.length) return '';
  const cells = rows.map(
    (p) => `${p.priority} n${p.n} lead ${fmtDur(p.lead.p50)} cyc ${fmtDur(p.cycle.p50)} wip ${p.wip}`,
  );
  return `by priority: ${cells.join('  ·  ')}`;
}

function byLabelLine(stats: BoardStats): string {
  if (!stats.by_label.length) return '';
  const shown = stats.by_label.slice(0, LABEL_TOP_N);
  const cells = shown.map((l) => `${l.name} n${l.n} cyc ${fmtDur(l.cycle.p50)} wip ${l.wip}`);
  const hidden = stats.by_label.length - shown.length;
  return `by label: ${cells.join('  ·  ')}${hidden ? `  [+${hidden} label(s) hidden — stats --full --json]` : ''}`;
}

function byAgentLine(stats: BoardStats): string {
  if (!stats.by_agent.length) return '';
  const cells = stats.by_agent.map(
    (a) => `${a.agent_id} done ${a.completed} cyc ${fmtDur(a.cycle.p50)} wip ${a.active_wip}`,
  );
  return `by agent: ${cells.join('  ·  ')}`;
}

function forecastLine(stats: BoardStats): string {
  const f = stats.forecast;
  let drain: string;
  if (f.ms_to_drain === null) drain = 'stalled (velocity 0)';
  else if (f.ms_to_drain < 3 * DAY_MS) drain = `~${fmtDur(f.ms_to_drain)} (eta ${fmtEtaHour(f.eta!)})`;
  else drain = `~${f.days_to_drain}d (eta ${f.eta!.slice(0, 10)})`;
  return `forecast: ${f.remaining} open · ${fmtRate(f.velocity_per_day)} → drain ${drain}${f.diverging ? ' · ⚠ diverging' : ''}`;
}

/** ` · trend ↑ +40% (1.2/d vs 0.86/d)` — empty when there's nothing to compare. */
function trendSuffix(t: VelocityTrend): string {
  if (t.delta_pct === null && t.direction === 'flat') return '';
  const arrow = t.direction === 'up' ? '↑' : t.direction === 'down' ? '↓' : '→';
  const delta = t.delta_pct !== null ? ` ${t.delta_pct > 0 ? '+' : ''}${t.delta_pct}%` : '';
  return `  · trend ${arrow}${delta} (${fmtRate(t.recent_per_day)} vs ${fmtRate(t.prior_per_day)})`;
}

/** Closed-stint dwell per active-flow status, flagging the slowest (bottleneck). */
function dwellLine(stats: BoardStats): string {
  const cells = stats.dwell
    .filter((d) => d.closed.n > 0)
    .map((d) => `${d.status} p50 ${fmtDur(d.closed.p50)} · p90 ${fmtDur(d.closed.p90)} (n=${d.closed.n})`);
  if (!cells.length) return '';
  const flag = stats.bottleneck ? `  ⚠ bottleneck: ${stats.bottleneck.status}` : '';
  return `dwell (closed stints): ${cells.join('  ·  ')}${flag}`;
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
    `flow efficiency: ${t.flow_efficiency !== null ? pct(t.flow_efficiency) : '—'}  ·  active ${fmtDur(t.active_in_progress_ms)}`,
    perStatusLine('time', t.time_per_status, fmtDur),
  ];
  if (t.active_in_progress_ms && t.reopened) blocks.push(`active In Progress (all stints): ${fmtDur(t.active_in_progress_ms)}`);
  if (flagBits.length) blocks.push(`flags: ${flagBits.join(' · ')}`);
  if (t.partial_history)
    blocks.push('[history bounded: this task predates the compaction floor — timing is best-effort]');

  return budgetBlocks(blocks, opts, '\n', (n) => `[+${n} line(s) hidden for token budget — stats ${t.id} --full]`);
}
