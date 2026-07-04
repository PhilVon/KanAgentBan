// MCP tool table for KanAgentBan.
//
// Each tool is a thin adapter over the existing REST surface, reached through the
// same `connect()` + `api()` helpers the CLI uses (src/cli/board.ts). This keeps
// the MCP server a *client* of the one sole-writer server — it never opens its own
// Repo/DB, so the single-writer invariant (ADR 0003) and realtime/HITL coherence
// hold (docs/12-mcp.md).
//
// Handlers (`run`) are decoupled from the SDK so they can be unit-tested directly
// against a running test server (tests/mcp.test.ts). `registerTools` wires them
// into an McpServer; `runTool` is the shared dispatch that maps CliError to an
// MCP error result instead of throwing.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { api, CliError, type Conn } from '../cli/board';
import { renderInbox } from '../cli/format';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  run: (conn: Conn, args: any) => Promise<string>;
}

/** Build a `?a=b` query string, dropping undefined/null/false/'' and mapping true→1. */
function qs(params: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    u.set(k, v === true ? '1' : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Read responses ride through `?json=1` so the est_tokens meter is preserved. */
function readText(r: any): string {
  const t = typeof r?.text === 'string' ? r.text : JSON.stringify(r, null, 2);
  return r?.est_tokens != null ? `${t}\n\n[est_tokens: ${r.est_tokens}]` : t;
}

export const TOOLS: ToolDef[] = [
  // ---- read / context (the token-efficient read ladder) -------------------
  {
    name: 'next',
    description:
      'Recommend the next task(s) to work on, each with a one-line "why". The cheapest read — prefer this over `context` for "what should I do?". Pass context=true to also load the recommended task\'s full working set in one call.',
    inputSchema: {
      context: z.boolean().optional().describe('include the recommended task\'s full working set'),
      n: z.number().int().positive().optional().describe('list the top N candidates'),
      mine: z.boolean().optional().describe('only tasks you have claimed'),
      max_tokens: z.number().int().positive().optional().describe('token budget (sheds trailing candidates / context)'),
      full: z.boolean().optional().describe('ignore the token budget'),
    },
    run: async (c, a) =>
      readText(
        await api(c, 'GET', `/api/next${qs({ context: a.context, n: a.n, mine: a.mine, max_tokens: a.max_tokens, full: a.full, json: 1 })}`),
      ),
  },
  {
    name: 'list',
    description: 'List tasks, one terse line each (~15 tokens/task). Filter by status or label. Use to scan the board; use `next` to decide what to do.',
    inputSchema: {
      status: z.string().optional(),
      label: z.string().optional(),
      limit: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional().describe('token budget (sheds trailing rows)'),
      full: z.boolean().optional(),
    },
    run: async (c, a) =>
      readText(await api(c, 'GET', `/api/tasks${qs({ status: a.status, label: a.label, limit: a.limit, max_tokens: a.max_tokens, full: a.full, json: 1 })}`)),
  },
  {
    name: 'show',
    description: 'Medium detail for one task: title, criteria/blocker counts, user comments (the human\'s directives) + recent agent notes, open questions. Reach for `context` when you need the full working set.',
    inputSchema: {
      id: z.string().describe('task id, e.g. T-12'),
      max_tokens: z.number().int().positive().optional(),
      full: z.boolean().optional(),
    },
    run: async (c, a) => readText(await api(c, 'GET', `/api/tasks/${a.id}${qs({ max_tokens: a.max_tokens, full: a.full, json: 1 })}`)),
  },
  {
    name: 'context',
    description: 'The flagship working set for one task (summary, criteria, subtasks, deps, open input, user comments + agent notes, artifacts, labels), budgeted to a token ceiling. User comments are surfaced distinctly and protected from shedding. Use to (re)load a task before working it.',
    inputSchema: {
      id: z.string().describe('task id, e.g. T-12'),
      max_tokens: z.number().int().positive().optional().describe('token budget (default 2000; sheds trailing sections)'),
      full: z.boolean().optional(),
    },
    run: async (c, a) => readText(await api(c, 'GET', `/api/tasks/${a.id}${qs({ view: 'context', max_tokens: a.max_tokens, full: a.full, json: 1 })}`)),
  },
  {
    name: 'watch',
    description: 'Scoped event delta for a task and its direct dependencies since an event seq (tens of tokens). The cheap "what changed on this task?" read.',
    inputSchema: { id: z.string(), since: z.number().int().nonnegative().describe('last-seen event seq') },
    run: async (c, a) => JSON.stringify(await api(c, 'GET', `/api/tasks/${a.id}/watch?since=${a.since}`), null, 2),
  },
  {
    name: 'changes',
    description: 'Board-wide event delta since an event seq. Heavier than `watch`; use when you need everything that changed, not just one task.',
    inputSchema: { since: z.number().int().nonnegative().describe('last-seen event seq') },
    run: async (c, a) => JSON.stringify(await api(c, 'GET', `/api/changes?since=${a.since}`), null, 2),
  },
  {
    name: 'inbox',
    description: 'The resume entry point: open, answered, and resolved (cancelled/expired) input requests since a cursor. Check this when resuming work to pick up answers to questions you asked earlier.',
    inputSchema: { since: z.number().int().nonnegative().optional().describe('only requests resolved after this event seq') },
    run: async (c, a) => renderInbox(await api(c, 'GET', `/api/inbox${a.since != null ? `?since=${a.since}` : ''}`)),
  },
  {
    name: 'stats',
    description:
      'Board analytics (throughput + trend, WIP & aging, dwell/bottleneck, burndown, forecast) — or per-task timing (lead/cycle, time per status) when id is given. Token-budgeted text; never silent about bounded (compacted) history.',
    inputSchema: {
      id: z.string().optional().describe('task id for per-task timing (omit for board stats)'),
      window: z.number().int().positive().optional().describe('window in days (default 14)'),
      max_tokens: z.number().int().positive().optional().describe('token budget (sheds trailing lines)'),
      full: z.boolean().optional().describe('ignore the token budget'),
    },
    run: async (c, a) =>
      readText(
        await api(
          c,
          'GET',
          `${a.id ? `/api/tasks/${a.id}/stats` : '/api/stats'}${qs({ window: a.window, max_tokens: a.max_tokens, full: a.full, json: 1 })}`,
        ),
      ),
  },

  // ---- write / workflow ---------------------------------------------------
  {
    name: 'add',
    description: 'Create a task. Optionally seed labels, blocking dependencies, acceptance criteria, and a parent (to create a subtask) in one call.',
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      summary: z.string().optional(),
      status: z.string().optional().describe('Backlog | Ready | In Progress | Review | Done (default Backlog)'),
      priority: z.string().optional().describe('P0 | P1 | P2 | P3'),
      parent: z.string().optional().describe('parent task id — creates a subtask'),
      labels: z.array(z.string()).optional(),
      depends: z.array(z.string()).optional().describe('task ids this task is blocked by'),
      criteria: z.array(z.string()).optional().describe('acceptance criteria'),
    },
    run: async (c, a) => {
      const t = await api(c, 'POST', '/api/tasks', {
        title: a.title,
        description: a.description,
        summary: a.summary,
        status: a.status,
        priority: a.priority,
        parent: a.parent,
        labels: a.labels,
        depends: a.depends,
        criteria: a.criteria,
      });
      return `${t.id} created${t.parent_id ? ` (subtask of ${t.parent_id})` : ''}`;
    },
  },
  {
    name: 'update',
    description: 'Update a task\'s title, description, summary, or priority. Pass expect_version for optimistic concurrency (fails with a conflict if the task changed since you read it).',
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      summary: z.string().optional(),
      priority: z.string().optional(),
      expect_version: z.number().int().optional().describe('optimistic-lock guard (If-Match)'),
    },
    run: async (c, a) => {
      const headers: Record<string, string> = a.expect_version != null ? { 'if-match': String(a.expect_version) } : {};
      const t = await api(c, 'PATCH', `/api/tasks/${a.id}`, { title: a.title, description: a.description, summary: a.summary, priority: a.priority }, headers);
      return `${t.id} updated (v${t.version})`;
    },
  },
  {
    name: 'move',
    description: 'Move a task to a workflow column (Backlog | Ready | In Progress | Review | Done). Moving to Done is refused while the task has open subtasks.',
    inputSchema: { id: z.string(), status: z.string().describe('target column') },
    run: async (c, a) => {
      const t = await api(c, 'POST', `/api/tasks/${a.id}/move`, { status: a.status });
      return `${t.id} -> ${t.status}`;
    },
  },
  {
    name: 'claim',
    description: 'Claim a task for yourself (or release it with op=release). A claimed task drops out of other agents\' `next`. Use force=true to steal/release a claim held by another agent.',
    inputSchema: {
      id: z.string(),
      op: z.enum(['claim', 'release']).optional().describe('default claim'),
      force: z.boolean().optional(),
    },
    run: async (c, a) => {
      const op = a.op ?? 'claim';
      const t = await api(c, 'POST', `/api/tasks/${a.id}/${op}`, a.force ? { force: true } : undefined);
      if (op === 'release') return t.assignee ? `${t.id} still claimed by ${t.assignee}` : `${t.id} released`;
      return `${t.id} claimed by ${t.assignee}`;
    },
  },
  {
    name: 'archive',
    description: 'Archive (soft-delete) a task. Refused while it has live (non-archived) children.',
    inputSchema: { id: z.string() },
    run: async (c, a) => {
      await api(c, 'POST', `/api/tasks/${a.id}/archive`);
      return `${a.id} archived`;
    },
  },
  {
    name: 'dep',
    description: 'Add (op=add) or remove (op=remove) a blocking dependency: task `id` is blocked by task `on`. Cycles and self-deps are rejected.',
    inputSchema: { id: z.string(), on: z.string().describe('the prerequisite task id'), op: z.enum(['add', 'remove']) },
    run: async (c, a) => {
      if (a.op === 'add') {
        await api(c, 'POST', `/api/tasks/${a.id}/deps`, { on: a.on });
        return `${a.id} now blocked by ${a.on}`;
      }
      await api(c, 'DELETE', `/api/tasks/${a.id}/deps?on=${a.on}`);
      return `removed ${a.id} -> ${a.on}`;
    },
  },
  {
    name: 'parent',
    description: 'Nest a task under a parent (to) or detach it (clear=true). Single-parent tree; cycles are rejected.',
    inputSchema: { id: z.string(), to: z.string().optional().describe('parent task id'), clear: z.boolean().optional() },
    run: async (c, a) => {
      if (a.clear) {
        const t = await api(c, 'DELETE', `/api/tasks/${a.id}/parent`);
        return `${t.id} detached (now top-level)`;
      }
      if (a.to) {
        const t = await api(c, 'POST', `/api/tasks/${a.id}/parent`, { parent: a.to });
        return `${t.id} now a subtask of ${t.parent_id}`;
      }
      throw new CliError('parent needs `to` (a parent id) or clear=true', 1);
    },
  },
  {
    name: 'comment',
    description: 'Add an agent comment to a task. Record decisions and non-obvious choices — not status updates the board already tracks. Note: the human leaves `user` comments on tasks as directives; read those via `show`/`context` and act on them.',
    inputSchema: { id: z.string(), body: z.string() },
    run: async (c, a) => {
      const r = await api(c, 'POST', `/api/tasks/${a.id}/comments`, { body: a.body });
      return `${r.id} added`;
    },
  },
  {
    name: 'criterion',
    description: 'Manage acceptance criteria: op=add (needs id + text) appends a criterion; op=check (needs acid; checked defaults true) ticks/unticks one.',
    inputSchema: {
      op: z.enum(['add', 'check']),
      id: z.string().optional().describe('task id (for op=add)'),
      text: z.string().optional().describe('criterion text (for op=add)'),
      acid: z.string().optional().describe('criterion id, e.g. AC-3 (for op=check)'),
      checked: z.boolean().optional().describe('for op=check; default true'),
    },
    run: async (c, a) => {
      if (a.op === 'add') {
        if (!a.id || !a.text) throw new CliError('criterion add needs id and text', 1);
        const r = await api(c, 'POST', `/api/tasks/${a.id}/criteria`, { text: a.text });
        return `${r.id} added`;
      }
      if (!a.acid) throw new CliError('criterion check needs acid', 1);
      const checked = a.checked ?? true;
      await api(c, 'PATCH', `/api/criteria/${a.acid}`, { checked });
      return `${a.acid} ${checked ? 'checked' : 'unchecked'}`;
    },
  },
  {
    name: 'label',
    description: 'Add (op=add) or remove (op=remove) a label on a task.',
    inputSchema: { id: z.string(), name: z.string(), op: z.enum(['add', 'remove']) },
    run: async (c, a) => {
      if (a.op === 'add') {
        await api(c, 'POST', `/api/tasks/${a.id}/labels`, { name: a.name });
        return `+${a.name}`;
      }
      await api(c, 'DELETE', `/api/tasks/${a.id}/labels?name=${a.name}`);
      return `-${a.name}`;
    },
  },
  {
    name: 'artifact',
    description: 'Attach an artifact reference to a task (a link/file/pr/output). Store references, never blob contents (ADR 0005).',
    inputSchema: {
      id: z.string(),
      kind: z.enum(['link', 'file', 'pr', 'output']),
      title: z.string(),
      uri: z.string(),
    },
    run: async (c, a) => {
      const r = await api(c, 'POST', `/api/tasks/${a.id}/artifacts`, { kind: a.kind, title: a.title, uri: a.uri });
      return `${r.id} added`;
    },
  },

  // ---- search --------------------------------------------------------------
  {
    name: 'search',
    description:
      'Board-wide search over tasks (title/description/summary), docs (title/summary/body), and comments. Ranked matches with a snippet, one line each. Use before re-researching or re-deciding something — prior findings and ADRs surface here.',
    inputSchema: {
      query: z.string().describe('search terms (FTS5 syntax allowed; falls back to a literal phrase)'),
      type: z.enum(['task', 'doc', 'comment']).optional().describe('restrict to one entity type'),
      limit: z.number().int().positive().optional().describe('max hits (default 20)'),
      max_tokens: z.number().int().positive().optional().describe('token budget (sheds trailing hits)'),
      full: z.boolean().optional(),
    },
    run: async (c, a) =>
      readText(
        await api(c, 'GET', `/api/search${qs({ q: a.query, type: a.type, limit: a.limit, max_tokens: a.max_tokens, full: a.full, json: 1 })}`),
      ),
  },

  // ---- docs (board-native knowledge — ADR 0007) ---------------------------
  {
    name: 'doc',
    description:
      'Board-native documents (design docs, ADRs, spike write-ups, research notes) with markdown bodies stored on the board — durable and linked to tasks. op=add creates (kind + title, optional body/summary/links); op=show renders one doc (body budgeted — pass full=true for everything); op=list scans titles (filter by kind/status/task); op=update edits fields incl. status (draft|active|accepted|rejected|superseded) and superseded_by; op=link/unlink manages task links. Write an ADR for hard-to-reverse decisions; a research note for reusable findings.',
    inputSchema: {
      op: z.enum(['add', 'show', 'list', 'update', 'link', 'unlink']),
      id: z.string().optional().describe('doc id, e.g. D-3 (for show/update/link/unlink)'),
      kind: z.enum(['design', 'adr', 'spike', 'research', 'note']).optional().describe('for op=add (required) or op=list (filter)'),
      title: z.string().optional().describe('for op=add (required) or op=update'),
      body: z.string().optional().describe('markdown body (add/update); capped at 64 KB'),
      summary: z.string().optional().describe('short abstract — what list/context tiers show'),
      status: z.string().optional().describe('draft | active | accepted | rejected | superseded'),
      superseded_by: z.string().optional().describe('doc id replacing this one (op=update; also sets status)'),
      task: z.string().optional().describe('task id (link/unlink target, or list filter)'),
      links: z.array(z.string()).optional().describe('task ids to link at creation (op=add)'),
      max_tokens: z.number().int().positive().optional().describe('token budget for op=show (default 2000)'),
      full: z.boolean().optional().describe('op=show: ignore the token budget'),
    },
    run: async (c, a) => {
      switch (a.op) {
        case 'add': {
          if (!a.kind || !a.title) throw new CliError('doc add needs kind and title', 1);
          const d = await api(c, 'POST', '/api/docs', {
            kind: a.kind, title: a.title, body: a.body, summary: a.summary, status: a.status, links: a.links,
          });
          return `${d.id} created [${d.kind}/${d.status}]`;
        }
        case 'show': {
          if (!a.id) throw new CliError('doc show needs id', 1);
          const r = await api(c, 'GET', `/api/docs/${a.id}${qs({ max_tokens: a.max_tokens, full: a.full })}`);
          return r.text;
        }
        case 'list': {
          const r = await api(c, 'GET', `/api/docs${qs({ kind: a.kind, status: a.status, task: a.task, max_tokens: a.max_tokens, full: a.full })}`);
          return r.text;
        }
        case 'update': {
          if (!a.id) throw new CliError('doc update needs id', 1);
          const d = await api(c, 'PATCH', `/api/docs/${a.id}`, {
            title: a.title, body: a.body, summary: a.summary, status: a.status, superseded_by: a.superseded_by,
          });
          return `${d.id} updated [${d.kind}/${d.status}]`;
        }
        case 'link':
        case 'unlink': {
          if (!a.id || !a.task) throw new CliError(`doc ${a.op} needs id and task`, 1);
          if (a.op === 'link') await api(c, 'POST', `/api/docs/${a.id}/links`, { task: a.task });
          else await api(c, 'DELETE', `/api/docs/${a.id}/links?task=${a.task}`);
          return `${a.id} ${a.op}ed ${a.op === 'link' ? 'to' : 'from'} ${a.task}`;
        }
      }
    },
  },

  // ---- brainstorm (ideation) -----------------------------------------------
  {
    name: 'brainstorm',
    description:
      'Structured ideation sessions: capture ideas fast, then cluster, score (0–10), and promote winners to real tasks. Use when exploring more than ~3 candidate approaches — otherwise just add tasks. op=start (topic, optional task anchor); op=idea_add (id + text, optional cluster); op=idea_score / idea_cluster / idea_discard shape the pool; op=idea_promote turns an idea into a task atomically (optional title/priority override); op=show renders clustered score-ranked ideas; op=list scans sessions; op=close ends a session. Recipe: start → add → score → promote winners → distill into a doc → close.',
    inputSchema: {
      op: z.enum(['start', 'close', 'show', 'list', 'idea_add', 'idea_score', 'idea_cluster', 'idea_promote', 'idea_discard']),
      id: z.string().optional().describe('session id B-n (start/close/show/idea_add) or idea id I-n (idea_* ops)'),
      topic: z.string().optional().describe('for op=start (required)'),
      task: z.string().optional().describe('op=start: anchor task; op=list: filter'),
      text: z.string().optional().describe('idea text (op=idea_add, required)'),
      cluster: z.string().optional().describe('cluster name (idea_add / idea_cluster)'),
      score: z.number().int().min(0).max(10).optional().describe('op=idea_score (required)'),
      title: z.string().optional().describe('op=idea_promote: task title (default: idea text)'),
      priority: z.string().optional().describe('op=idea_promote: P0–P3'),
      status: z.string().optional().describe('op=list filter (open|closed)'),
      max_tokens: z.number().int().positive().optional(),
      full: z.boolean().optional(),
    },
    run: async (c, a) => {
      switch (a.op) {
        case 'start': {
          if (!a.topic) throw new CliError('brainstorm start needs topic', 1);
          const s = await api(c, 'POST', '/api/brainstorms', { topic: a.topic, task: a.task });
          return `${s.id} started "${s.topic}"${s.task_id ? ` (anchored to ${s.task_id})` : ''}`;
        }
        case 'close': {
          if (!a.id) throw new CliError('brainstorm close needs id', 1);
          const s = await api(c, 'POST', `/api/brainstorms/${a.id}/close`);
          return `${s.id} closed`;
        }
        case 'show': {
          if (!a.id) throw new CliError('brainstorm show needs id', 1);
          const r = await api(c, 'GET', `/api/brainstorms/${a.id}${qs({ max_tokens: a.max_tokens, full: a.full })}`);
          return r.text;
        }
        case 'list': {
          const r = await api(c, 'GET', `/api/brainstorms${qs({ status: a.status, task: a.task })}`);
          return r.text;
        }
        case 'idea_add': {
          if (!a.id || !a.text) throw new CliError('idea_add needs id (session) and text', 1);
          const i = await api(c, 'POST', `/api/brainstorms/${a.id}/ideas`, { text: a.text, cluster: a.cluster });
          return `${i.id} added${i.cluster ? ` [${i.cluster}]` : ''}`;
        }
        case 'idea_score': {
          if (!a.id || a.score === undefined) throw new CliError('idea_score needs id (idea) and score', 1);
          const i = await api(c, 'PATCH', `/api/ideas/${a.id}`, { score: a.score });
          return `${i.id} scored ${i.score}`;
        }
        case 'idea_cluster': {
          if (!a.id || !a.cluster) throw new CliError('idea_cluster needs id (idea) and cluster', 1);
          const i = await api(c, 'PATCH', `/api/ideas/${a.id}`, { cluster: a.cluster });
          return `${i.id} → cluster "${i.cluster}"`;
        }
        case 'idea_promote': {
          if (!a.id) throw new CliError('idea_promote needs id (idea)', 1);
          const r = await api(c, 'POST', `/api/ideas/${a.id}/promote`, {
            task: { ...(a.title ? { title: a.title } : {}), ...(a.priority ? { priority: a.priority } : {}) },
          });
          return `${r.idea.id} promoted → ${r.task.id} "${r.task.title}"`;
        }
        case 'idea_discard': {
          if (!a.id) throw new CliError('idea_discard needs id (idea)', 1);
          await api(c, 'PATCH', `/api/ideas/${a.id}`, { discard: true });
          return `${a.id} discarded`;
        }
      }
    },
  },

  // ---- human-in-the-loop (durable async; never block) ---------------------
  {
    name: 'ask',
    description: 'Raise a question for the human about a task. Returns a Q-id immediately and does NOT block — the task is now needs_input. Provide options for a constrained choice, or freeform=true for free text.',
    inputSchema: {
      id: z.string().describe('task id the question is about'),
      question: z.string(),
      options: z.array(z.string()).optional().describe('constrained choices'),
      freeform: z.boolean().optional(),
      expires_at: z.string().optional().describe('ISO timestamp; the request auto-expires after this'),
    },
    run: async (c, a) => {
      const r = await api(c, 'POST', `/api/tasks/${a.id}/input-requests`, {
        question: a.question,
        options: a.options,
        freeform: !!a.freeform,
        expires_at: a.expires_at,
      });
      return `${r.id} created on ${a.id} (task now needs input). Durable: don't block — await briefly, otherwise yield this turn and resume via inbox.`;
    },
  },
  {
    name: 'await',
    description: 'Long-poll briefly for a question to resolve. Provide qid for a specific question, or task / any for scoped waits. A timeout returns "pending" — that is NOT an error: yield this turn and resume later via inbox. Never blocks indefinitely.',
    inputSchema: {
      qid: z.string().optional().describe('specific question id'),
      task: z.string().optional().describe('wait for any open question on this task'),
      any: z.boolean().optional().describe('wait for any open question on the board'),
      timeout: z.number().int().positive().optional().describe('seconds to wait (default 30)'),
    },
    run: async (c, a) => {
      if (!a.qid && !a.task && !a.any) throw new CliError('await needs qid, task, or any', 1);
      const timeout = a.timeout ?? 30;
      const path = a.qid
        ? `/api/input-requests/${a.qid}/await?timeout=${timeout}`
        : `/api/await${qs({ task: a.task, any: a.any, timeout })}`;
      const r = await api(c, 'GET', path);
      if (r.__status === 204) return `pending — no answer within ${timeout}s. Not an error: yield this turn and resume later via inbox.`;
      if (r.status === 'none') return 'no open questions';
      const id = r.request_id ?? a.qid;
      return r.status === 'answered' ? `${id} answered: ${r.answer}` : `${id} ${r.status}`;
    },
  },
  {
    name: 'cancel',
    description: 'Withdraw an open input request you no longer need. Fires input.cancelled and clears the task\'s needs_input.',
    inputSchema: { qid: z.string() },
    run: async (c, a) => {
      await api(c, 'POST', `/api/input-requests/${a.qid}/cancel`);
      return `${a.qid} cancelled`;
    },
  },
];

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Shared dispatch: run a tool by name, mapping CliError to an MCP error result. */
export async function runTool(conn: Conn, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`unknown tool: ${name}`);
  try {
    const text = await tool.run(conn, (args ?? {}) as any);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    if (e instanceof CliError) return errorResult(`error (exit ${e.code}): ${e.message}`);
    return errorResult(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Register every tool on an McpServer, bound to a single board connection. */
export function registerTools(server: McpServer, conn: Conn): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args: unknown) => runTool(conn, tool.name, args),
    );
  }
}
