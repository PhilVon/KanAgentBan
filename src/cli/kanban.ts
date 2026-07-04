#!/usr/bin/env node
import * as fs from 'node:fs';
import { Command } from 'commander';
import { api, CliError, connect, initBoard } from './board';
import { collectList } from './args';
import { normalizeShell, renderCompletion, specFromCommand } from './completion';
import { followChanges, followTask, type FollowHandle } from './follow';
import { renderInbox } from './format';
import { boardPaths, findBoardRoot, readBoardMeta, writeBoardMeta } from '../shared/board-paths';
import type { NudgeConfig } from '../shared/types';

const program = new Command();
program
  .name('kanban')
  .description('Agent-first kanban board CLI (see docs/05-cli-reference.md)')
  .option('--board <path>', 'board root (defaults to nearest .kanban/ above CWD)')
  .option('--as <id>', 'agent identity for claim / next (or KANBAN_AGENT env)');

const out = (s: string): void => {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
};
const conn = () => connect({ board: program.opts().board, agent: program.opts().as });

// ---- read / context ------------------------------------------------------
program
  .command('next')
  .option('--context', 'include the recommended task’s full working set')
  .option('--n <n>', 'list top N candidates')
  .option('--mine', 'only tasks you have claimed')
  .option('--max-tokens <n>', 'token budget (sheds trailing candidates / context)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (o) => {
    const c = await conn();
    const q = new URLSearchParams();
    if (o.context) q.set('context', '1');
    if (o.n) q.set('n', o.n);
    if (o.mine) q.set('mine', '1');
    if (o.maxTokens) q.set('max_tokens', o.maxTokens);
    if (o.full) q.set('full', '1');
    if (o.json) q.set('json', '1');
    const r = await api(c, 'GET', `/api/next?${q}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

program
  .command('list')
  .option('--status <s>')
  .option('--label <l>')
  .option('--limit <n>')
  .option('--max-tokens <n>', 'token budget (sheds trailing rows)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (o) => {
    const c = await conn();
    const q = new URLSearchParams(
      clean({ status: o.status, label: o.label, limit: o.limit, max_tokens: o.maxTokens, full: o.full, json: o.json }),
    );
    const r = await api(c, 'GET', `/api/tasks?${q}`);
    // print the full envelope under --json so the est_tokens meter rides through
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

program
  .command('show <id>')
  .option('--max-tokens <n>', 'token budget (sheds comments, then open input, then summary)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (id, o) => {
    const q = new URLSearchParams(clean({ max_tokens: o.maxTokens, full: o.full, json: o.json }));
    const qs = q.toString();
    const r = await api(await conn(), 'GET', `/api/tasks/${id}${qs ? `?${qs}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

program
  .command('context <id>')
  .option('--full')
  .option('--max-tokens <n>')
  .option('--json')
  .action(async (id, o) => {
    const q = new URLSearchParams();
    q.set('view', 'context');
    if (o.full) q.set('full', '1');
    if (o.maxTokens) q.set('max_tokens', o.maxTokens);
    if (o.json) q.set('json', '1');
    const r = await api(await conn(), 'GET', `/api/tasks/${id}?${q}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

program
  .command('watch <id>')
  .option('--since <seq>', 'event seq to start from (required without --follow)')
  .option('--follow', 'stream events (task + direct deps) as NDJSON until Ctrl-C')
  .action(async (id, o) => {
    if (o.follow) {
      const c = await conn();
      const since = o.since !== undefined ? Number(o.since) : (await api(c, 'GET', '/api/board')).seq;
      runFollow(followTask(c, id, since, (ev) => out(JSON.stringify(ev)), followOpts()));
      return;
    }
    if (o.since === undefined) throw new CliError('watch needs --since <seq> (or --follow)', 1);
    const r = await api(await conn(), 'GET', `/api/tasks/${id}/watch?since=${o.since}`);
    out(JSON.stringify(r, null, 2));
  });

program
  .command('changes')
  .option('--since <seq>', 'event seq to start from (required without --follow)')
  .option('--follow', 'stream board-wide events as NDJSON until Ctrl-C')
  .action(async (o) => {
    if (o.follow) {
      const c = await conn();
      const since = o.since !== undefined ? Number(o.since) : (await api(c, 'GET', '/api/board')).seq;
      runFollow(followChanges(c, since, (ev) => out(JSON.stringify(ev)), followOpts()));
      return;
    }
    if (o.since === undefined) throw new CliError('changes needs --since <seq> (or --follow)', 1);
    out(JSON.stringify(await api(await conn(), 'GET', `/api/changes?since=${o.since}`), null, 2));
  });

// --follow plumbing: the open socket keeps the process alive; Ctrl-C exits 0.
// Reconnect attempts are noted on stderr so a dying server is never silent.
const followOpts = () => ({ onRetry: () => process.stderr.write('reconnecting…\n') });
function runFollow(h: FollowHandle): void {
  process.on('SIGINT', () => {
    h.close();
    process.exit(0);
  });
}

program
  .command('inbox')
  .option('--since <seq>', 'only requests answered after this event seq')
  .option('--json')
  .action(async (o) => {
    const r = await api(await conn(), 'GET', `/api/inbox${o.since ? `?since=${o.since}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : renderInbox(r));
  });

program
  .command('compact')
  .description('compact the event log, retaining only the most recent events')
  .option('--keep <n>', 'events to retain (default: server KANBAN_EVENT_RETENTION)')
  .action(async (o) => {
    const r = await api(await conn(), 'POST', '/api/compact', o.keep ? { keep: Number(o.keep) } : {});
    out(`compacted: removed ${r.removed} event(s); floor now seq ${r.floor}`);
  });

program
  .command('standup')
  .description('narrative board diff: completed, kickbacks, moves, new tasks, question traffic, aging (default: last 1 day)')
  .option('--since <seq>', 'start from this event seq (e.g. your last saved cursor)')
  .option('--days <n>', 'window in days instead of a cursor (default 1)')
  .option('--max-tokens <n>', 'token budget (sheds trailing sections)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (o) => {
    const q = new URLSearchParams(
      clean({ since: o.since, days: o.days, max_tokens: o.maxTokens, full: o.full, json: o.json }),
    );
    const qs = q.toString();
    const r = await api(await conn(), 'GET', `/api/standup${qs ? `?${qs}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

program
  .command('doctor')
  .description('board hygiene report (stale claims, criteria-less WIP, aging tasks, ancient asks, stale summaries, closable parents) — exit 2 when findings')
  .option('--max-tokens <n>', 'token budget (sheds trailing blocks)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (o) => {
    const q = new URLSearchParams(clean({ max_tokens: o.maxTokens, full: o.full, json: o.json }));
    const qs = q.toString();
    const r = await api(await conn(), 'GET', `/api/doctor${qs ? `?${qs}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
    if (!r.healthy) process.exitCode = 2; // semantic: findings need attention
  });

program
  .command('stats [id]')
  .description('board analytics (throughput, WIP, burndown), or per-task timing when <id> is given')
  .option('--window <days>', 'burndown / throughput window in days (default 14)')
  .option('--max-tokens <n>', 'token budget (sheds trailing lines)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (id, o) => {
    const q = new URLSearchParams(clean({ window: o.window, max_tokens: o.maxTokens, full: o.full, json: o.json }));
    const qs = q.toString();
    const path = id ? `/api/tasks/${id}/stats` : '/api/stats';
    const r = await api(await conn(), 'GET', `${path}${qs ? `?${qs}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

// ---- write / workflow ----------------------------------------------------
program
  .command('add <title>')
  .option('--desc <t>')
  .option('--summary <t>')
  .option('--status <s>')
  .option('--prio <p>')
  .option('--parent <id>', 'parent task id (creates a subtask)')
  .option('--label <l>', 'label (repeatable or comma-separated)', collectList)
  .option('--depends <id>', 'blocking task id (repeatable or comma-separated)', collectList)
  .option('--ac <text...>', 'acceptance criterion (repeatable)')
  .action(async (title, o) => {
    const t = await api(await conn(), 'POST', '/api/tasks', {
      title,
      description: o.desc,
      summary: o.summary,
      status: o.status,
      priority: o.prio,
      parent: o.parent,
      labels: o.label,
      depends: o.depends,
      criteria: o.ac,
    });
    out(`${t.id}  created${t.parent_id ? `  (subtask of ${t.parent_id})` : ''}`);
  });

program
  .command('update <id>')
  .option('--title <t>')
  .option('--desc <t>')
  .option('--summary <t>')
  .option('--prio <p>')
  .option('--expect-version <n>')
  .action(async (id, o) => {
    const headers: Record<string, string> = o.expectVersion ? { 'if-match': String(o.expectVersion) } : {};
    const t = await api(await conn(), 'PATCH', `/api/tasks/${id}`, clean({ title: o.title, description: o.desc, summary: o.summary, priority: o.prio }), headers);
    out(`${t.id}  updated (v${t.version})`);
  });

// Comma-separated ids fan into one atomic bulk call (one event per task).
const splitIds = (id: string): string[] => id.split(',').map((s) => s.trim()).filter(Boolean);
program.command('move <id> <column>').description('move a task (or T-1,T-2,… — one transaction) to a column').action(async (id, column) => {
  const ids = splitIds(id);
  if (ids.length > 1) {
    const r = await api(await conn(), 'POST', '/api/tasks/bulk', { op: 'move', ids, status: column });
    out(`${r.count} task(s) -> ${column}`);
    return;
  }
  const t = await api(await conn(), 'POST', `/api/tasks/${id}/move`, { status: column });
  out(`${t.id} -> ${t.status}`);
});
program.command('done <id>').description('move a task (or T-1,T-2,…) to Done').action(async (id) => {
  const ids = splitIds(id);
  if (ids.length > 1) {
    const r = await api(await conn(), 'POST', '/api/tasks/bulk', { op: 'move', ids, status: 'Done' });
    out(`${r.count} task(s) -> Done`);
    return;
  }
  const t = await api(await conn(), 'POST', `/api/tasks/${id}/move`, { status: 'Done' });
  out(`${t.id} -> Done`);
});
program.command('archive <id>').description('archive a task (or T-1,T-2,… — one transaction)').action(async (id) => {
  const ids = splitIds(id);
  if (ids.length > 1) {
    const r = await api(await conn(), 'POST', '/api/tasks/bulk', { op: 'archive', ids });
    out(`${r.count} task(s) archived`);
    return;
  }
  await api(await conn(), 'POST', `/api/tasks/${id}/archive`);
  out(`${id} archived`);
});

program.command('claim <id>')
  .option('--force', 'steal a claim held by another agent')
  .option('--ttl <s>', 'lease seconds — the sweep auto-releases a past-due claim; re-claim to renew')
  .action(async (id, o) => {
    const body: Record<string, unknown> = {};
    if (o.force) body.force = true;
    if (o.ttl) body.ttl = Number(o.ttl);
    const t = await api(await conn(), 'POST', `/api/tasks/${id}/claim`, Object.keys(body).length ? body : undefined);
    out(`${t.id} claimed by ${t.assignee}${t.claim_expires_at ? `  (lease until ${t.claim_expires_at})` : ''}`);
  });
program.command('release <id>').option('--force', 'release a claim held by another agent').action(async (id, o) => {
  const t = await api(await conn(), 'POST', `/api/tasks/${id}/release`, o.force ? { force: true } : undefined);
  out(t.assignee ? `${t.id} still claimed by ${t.assignee}` : `${t.id} released`);
});

const review = program.command('review').description('the Review-column sign-off gate (normally the human, via UI or CLI)');
review
  .command('approve <id>')
  .option('--reason <r>', 'optional sign-off note (recorded as a comment)')
  .action(async (id, o) => {
    const t = await api(await conn(), 'POST', `/api/tasks/${id}/review`, { verdict: 'approve', reason: o.reason });
    out(`${t.id} approved -> ${t.status}`);
  });
review
  .command('reject <id>')
  .requiredOption('--reason <r>', 'why it bounced (recorded as a comment + kickback stat)')
  .action(async (id, o) => {
    const t = await api(await conn(), 'POST', `/api/tasks/${id}/review`, { verdict: 'reject', reason: o.reason });
    out(`${t.id} rejected -> ${t.status}  (reason recorded)`);
  });

const dep = program.command('dep');
dep.command('add <id>').requiredOption('--on <id>').action(async (id, o) => { await api(await conn(), 'POST', `/api/tasks/${id}/deps`, { on: o.on }); out(`${id} now blocked by ${o.on}`); });
dep.command('rm <id>').requiredOption('--on <id>').action(async (id, o) => { await api(await conn(), 'DELETE', `/api/tasks/${id}/deps?on=${o.on}`); out(`removed ${id} -> ${o.on}`); });

program.command('parent <id>')
  .description('set or clear a task\'s parent (subtask nesting)')
  .option('--to <pid>', 'parent task id')
  .option('--clear', 'detach from parent (make top-level)')
  .action(async (id, o) => {
    if (o.clear) {
      const t = await api(await conn(), 'DELETE', `/api/tasks/${id}/parent`);
      out(`${t.id} detached (now top-level)`);
    } else if (o.to) {
      const t = await api(await conn(), 'POST', `/api/tasks/${id}/parent`, { parent: o.to });
      out(`${t.id} now a subtask of ${t.parent_id}`);
    } else {
      out('specify --to <pid> or --clear');
    }
  });

program.command('comment <id> <body>').action(async (id, body) => { const c = await api(await conn(), 'POST', `/api/tasks/${id}/comments`, { body }); out(`${c.id} added`); });

const crit = program.command('criterion');
crit.command('add <id> <text>').action(async (id, text) => { const r = await api(await conn(), 'POST', `/api/tasks/${id}/criteria`, { text }); out(`${r.id} added`); });
crit.command('check <acid>').option('--off').action(async (acid, o) => { await api(await conn(), 'PATCH', `/api/criteria/${acid}`, { checked: !o.off }); out(`${acid} ${o.off ? 'unchecked' : 'checked'}`); });

program.command('label <id>').description('add/remove a label on a task (or T-1,T-2,… — one transaction)').option('--add <l>').option('--rm <l>').action(async (id, o) => {
  const c = await conn();
  const ids = splitIds(id);
  if (ids.length > 1) {
    if (o.add) { const r = await api(c, 'POST', '/api/tasks/bulk', { op: 'label', ids, name: o.add }); out(`+${o.add} on ${r.count} task(s)`); }
    if (o.rm) { const r = await api(c, 'POST', '/api/tasks/bulk', { op: 'unlabel', ids, name: o.rm }); out(`-${o.rm} on ${r.count} task(s)`); }
    return;
  }
  if (o.add) { await api(c, 'POST', `/api/tasks/${id}/labels`, { name: o.add }); out(`+${o.add}`); }
  if (o.rm) { await api(c, 'DELETE', `/api/tasks/${id}/labels?name=${o.rm}`); out(`-${o.rm}`); }
});

program.command('artifact <id>').requiredOption('--kind <k>').requiredOption('--title <t>').requiredOption('--uri <u>')
  .action(async (id, o) => { const a = await api(await conn(), 'POST', `/api/tasks/${id}/artifacts`, { kind: o.kind, title: o.title, uri: o.uri }); out(`${a.id} added`); });

program.command('summarize <id> <summary>').action(async (id, summary) => { await api(await conn(), 'POST', `/api/tasks/${id}/summary`, { summary }); out(`${id} summary updated`); });

program
  .command('checkpoint <id> [text]')
  .description('set the one-slot resume pointer ("did X, next Y, watch Z") — latest wins')
  .option('--clear', 'remove the checkpoint')
  .action(async (id, text, o) => {
    const c = await conn();
    if (o.clear) {
      await api(c, 'POST', `/api/tasks/${id}/checkpoint`, { clear: true });
      out(`${id} checkpoint cleared`);
    } else if (text !== undefined) {
      await api(c, 'POST', `/api/tasks/${id}/checkpoint`, { text });
      out(`${id} checkpoint set`);
    } else {
      const r = await api(c, 'GET', `/api/tasks/${id}?json=1`);
      out(r.task.checkpoint ?? '(no checkpoint)');
    }
  });

// ---- docs (board-native knowledge: design docs / ADRs / research) ---------
const doc = program.command('doc').description('board-native documents: design | adr | spike | research | note');
doc
  .command('add <title>')
  .requiredOption('--kind <k>', 'design | adr | spike | research | note')
  .option('--body <md>', 'markdown body (or --body-file)')
  .option('--body-file <path>', 'read the markdown body from a file')
  .option('--summary <t>', 'short abstract (what list/context tiers show)')
  .option('--status <s>', 'draft | active | accepted | rejected | superseded')
  .option('--link <id>', 'task to link (repeatable or comma-separated)', collectList)
  .action(async (title, o) => {
    if (o.body && o.bodyFile) throw new CliError('use --body or --body-file, not both', 1);
    const body = o.bodyFile ? fs.readFileSync(o.bodyFile, 'utf8') : o.body;
    const d = await api(await conn(), 'POST', '/api/docs', {
      kind: o.kind,
      title,
      body,
      summary: o.summary,
      status: o.status,
      links: o.link,
    });
    out(`${d.id}  created [${d.kind}/${d.status}]${o.link?.length ? `  linked: ${o.link.join(', ')}` : ''}`);
  });
doc
  .command('show <id>')
  .option('--max-tokens <n>', 'token budget (sheds the body tail; default 2000)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (id, o) => {
    const q = new URLSearchParams(clean({ max_tokens: o.maxTokens, full: o.full, json: o.json }));
    const qs = q.toString();
    const r = await api(await conn(), 'GET', `/api/docs/${id}${qs ? `?${qs}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });
doc
  .command('update <id>')
  .option('--title <t>')
  .option('--body <md>', 'replace the markdown body (or --body-file)')
  .option('--body-file <path>')
  .option('--summary <t>')
  .option('--status <s>', 'draft | active | accepted | rejected | superseded')
  .option('--superseded-by <did>', 'doc that replaces this one (also sets status)')
  .action(async (id, o) => {
    if (o.body && o.bodyFile) throw new CliError('use --body or --body-file, not both', 1);
    const body = o.bodyFile ? fs.readFileSync(o.bodyFile, 'utf8') : o.body;
    const d = await api(await conn(), 'PATCH', `/api/docs/${id}`, clean({
      title: o.title,
      body,
      summary: o.summary,
      status: o.status,
      superseded_by: o.supersededBy,
    }));
    out(`${d.id}  updated [${d.kind}/${d.status}]`);
  });
doc.command('link <id> <task>').action(async (id, task) => {
  await api(await conn(), 'POST', `/api/docs/${id}/links`, { task });
  out(`${id} linked to ${task}`);
});
doc.command('unlink <id> <task>').action(async (id, task) => {
  await api(await conn(), 'DELETE', `/api/docs/${id}/links?task=${task}`);
  out(`${id} unlinked from ${task}`);
});
doc.command('archive <id>').action(async (id) => {
  await api(await conn(), 'POST', `/api/docs/${id}/archive`);
  out(`${id} archived`);
});

program
  .command('search <query>')
  .description('board-wide search over tasks, docs, and comments (FTS5)')
  .option('--type <t>', 'task | doc | comment')
  .option('--limit <n>', 'max hits (default 20)')
  .option('--max-tokens <n>', 'token budget (sheds trailing hits)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (query, o) => {
    const q = new URLSearchParams(
      clean({ q: query, type: o.type, limit: o.limit, max_tokens: o.maxTokens, full: o.full, json: o.json }),
    );
    const r = await api(await conn(), 'GET', `/api/search?${q}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

program
  .command('docs')
  .description('list board documents, one terse line each')
  .option('--kind <k>', 'design | adr | spike | research | note')
  .option('--status <s>')
  .option('--task <id>', 'only docs linked to this task')
  .option('--limit <n>')
  .option('--max-tokens <n>', 'token budget (sheds trailing rows)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (o) => {
    const q = new URLSearchParams(
      clean({ kind: o.kind, status: o.status, task: o.task, limit: o.limit, max_tokens: o.maxTokens, full: o.full, json: o.json }),
    );
    const qs = q.toString();
    const r = await api(await conn(), 'GET', `/api/docs${qs ? `?${qs}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

// ---- brainstorm (ideation: capture -> cluster/score -> promote) -----------
const brainstorm = program
  .command('brainstorm')
  .description('structured ideation sessions: capture ideas, cluster, score, promote winners to tasks');
brainstorm
  .command('start <topic>')
  .option('--task <id>', 'anchor the session to a task (shows in its context)')
  .action(async (topic, o) => {
    const s = await api(await conn(), 'POST', '/api/brainstorms', { topic, task: o.task });
    out(`${s.id}  started "${s.topic}"${s.task_id ? `  (anchored to ${s.task_id})` : ''}`);
  });
brainstorm
  .command('add <id> <text>')
  .option('--cluster <name>', 'group related ideas under a free-form cluster name')
  .action(async (id, text, o) => {
    const i = await api(await conn(), 'POST', `/api/brainstorms/${id}/ideas`, { text, cluster: o.cluster });
    out(`${i.id} added${i.cluster ? ` [${i.cluster}]` : ''}`);
  });
brainstorm
  .command('show <id>')
  .option('--max-tokens <n>', 'token budget (sheds lowest-ranked clusters)')
  .option('--full', 'ignore the token budget')
  .option('--json')
  .action(async (id, o) => {
    const q = new URLSearchParams(clean({ max_tokens: o.maxTokens, full: o.full, json: o.json }));
    const qs = q.toString();
    const r = await api(await conn(), 'GET', `/api/brainstorms/${id}${qs ? `?${qs}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });
brainstorm
  .command('list')
  .option('--status <s>', 'open | closed')
  .option('--task <id>')
  .option('--json')
  .action(async (o) => {
    const q = new URLSearchParams(clean({ status: o.status, task: o.task, json: o.json }));
    const qs = q.toString();
    const r = await api(await conn(), 'GET', `/api/brainstorms${qs ? `?${qs}` : ''}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });
brainstorm.command('close <id>').action(async (id) => {
  const s = await api(await conn(), 'POST', `/api/brainstorms/${id}/close`);
  out(`${s.id} closed`);
});

const idea = program.command('idea').description('score, cluster, promote, or drop brainstorm ideas');
idea.command('score <id> <score>').action(async (id, score) => {
  const i = await api(await conn(), 'PATCH', `/api/ideas/${id}`, { score: Number(score) });
  out(`${i.id} scored ${i.score}`);
});
idea.command('cluster <id> <name>').action(async (id, name) => {
  const i = await api(await conn(), 'PATCH', `/api/ideas/${id}`, { cluster: name });
  out(`${i.id} → cluster "${i.cluster}"`);
});
idea
  .command('promote <id>')
  .option('--title <t>', 'task title (default: the idea text)')
  .option('--prio <p>')
  .option('--status <s>')
  .option('--parent <tid>')
  .action(async (id, o) => {
    const r = await api(await conn(), 'POST', `/api/ideas/${id}/promote`, {
      task: clean({ title: o.title, priority: o.prio, status: o.status, parent: o.parent }),
    });
    out(`${r.idea.id} promoted → ${r.task.id} "${r.task.title}"`);
  });
idea.command('drop <id>').description('discard an idea (one-way)').action(async (id) => {
  await api(await conn(), 'PATCH', `/api/ideas/${id}`, { discard: true });
  out(`${id} discarded`);
});

// ---- git linkage (CLI-side git only — ADR 0008) ---------------------------
const git = program
  .command('git')
  .description('link the current repo to board tasks: commits, branches, PR status');
git
  .command('link [id]')
  .description('scan the repo for T-n mentions and record commit/branch artifacts (idempotent)')
  .option('--depth <n>', 'commits to scan (default 500)')
  .action(async (id, o) => {
    const g = await import('./git');
    if (!g.inGitRepo()) throw new CliError('not inside a git repository', 1);
    const c = await conn();
    const commits = g.scanCommits(undefined, o.depth ? Number(o.depth) : undefined);
    const branches = g.scanBranches();
    let commitCount = 0;
    let branchCount = 0;
    const wanted = (ids: string[]) => (id ? ids.filter((x) => x === id) : ids);
    for (const cm of commits) {
      for (const tid of wanted(cm.ids)) {
        try {
          await api(c, 'POST', `/api/tasks/${tid}/artifacts`, {
            kind: 'commit',
            title: cm.subject,
            uri: `git:${cm.sha}`,
          });
          commitCount++;
        } catch {
          /* task id mentioned but not on this board — skip */
        }
      }
    }
    for (const b of branches) {
      for (const tid of wanted(b.ids)) {
        try {
          await api(c, 'POST', `/api/tasks/${tid}/artifacts`, {
            kind: 'branch',
            title: b.name,
            uri: `branch:${b.name}`,
          });
          branchCount++;
        } catch {
          /* skip unknown ids */
        }
      }
    }
    out(`linked ${commitCount} commit(s), ${branchCount} branch(es)${id ? ` for ${id}` : ''} (re-runs are idempotent)`);
  });
git
  .command('branch <id>')
  .description('print (or create) the conventional branch T-n-<slug> for a task')
  .option('--checkout', 'create the branch and switch to it')
  .option('--create', 'create the branch without switching')
  .action(async (id, o) => {
    const g = await import('./git');
    const r = await api(await conn(), 'GET', `/api/tasks/${id}?json=1`);
    const name = g.branchNameFor(id, r.task.title);
    if (o.checkout || o.create) {
      if (!g.inGitRepo()) throw new CliError('not inside a git repository', 1);
      g.createBranch(name, !!o.checkout);
      out(`${name}${o.checkout ? '  (checked out)' : '  (created)'}`);
    } else {
      out(name);
    }
  });
git
  .command('status [id]')
  .description('board git artifacts merged with live repo/PR state (gh optional)')
  .action(async (id) => {
    const g = await import('./git');
    const c = await conn();
    const cur = g.inGitRepo() ? g.currentBranch() : null;
    const ids = id ? [id] : cur ? g.taskIdsIn(cur) : [];
    if (!ids.length)
      throw new CliError('no task id: pass one, or check out a T-n-… branch', 1);
    for (const tid of ids) {
      const r = await api(c, 'GET', `/api/tasks/${tid}?view=context&json=1`);
      const arts: any[] = (r.artifacts ?? []).filter((a: any) =>
        ['commit', 'branch', 'pr'].includes(a.kind),
      );
      out(`${tid} "${r.task.title}" [${r.task.status}]`);
      if (!arts.length) out('  (no git artifacts — run: kanban git link)');
      for (const a of arts) {
        let line = `  ${a.kind.padEnd(6)} ${a.title}  ${a.uri}`;
        if (a.kind === 'branch' && cur && a.uri === `branch:${cur}`) line += '  ← current';
        if (a.kind === 'pr' || a.kind === 'branch') {
          const ref = a.kind === 'branch' ? a.uri.slice('branch:'.length) : a.uri;
          const pr = g.prStatus(ref);
          if (pr) line += `  [PR ${pr.state.toLowerCase()} · ${pr.checks}]`;
        }
        out(line);
      }
    }
  });
git
  .command('install-hooks')
  .description('install prepare-commit-msg (+[T-n] from branch) and post-commit (auto git link) hooks')
  .option('--force', 'overwrite existing non-kanban hooks')
  .action(async (o) => {
    const g = await import('./git');
    if (!g.inGitRepo()) throw new CliError('not inside a git repository', 1);
    try {
      const written = g.installHooks(process.cwd(), !!o.force);
      out(`installed: ${written.join(', ')}`);
    } catch (e) {
      throw new CliError(e instanceof Error ? e.message : String(e), 1);
    }
  });

// ---- human-in-the-loop ---------------------------------------------------
program.command('ask <id> <question>').option('--options <o>', 'answer option (repeatable or comma-separated)', collectList).option('--freeform').option('--expires-at <iso>')
  .option('--default <answer>', 'auto-answer applied at expiry (requires --expires-at; flagged "defaulted")')
  .action(async (id, question, o) => {
    const r = await api(await conn(), 'POST', `/api/tasks/${id}/input-requests`, { question, options: o.options, freeform: !!o.freeform, expires_at: o.expiresAt, default: o.default });
    out(`${r.id}  created on ${id} (task now needs input)${r.default_answer ? `  [defaults to "${r.default_answer}" at expiry]` : ''}`);
  });

program
  .command('await [qid]')
  .option('--task <id>', 'wait for any open question on this task')
  .option('--any', 'wait for any open question on the board')
  .option('--timeout <s>', 'seconds', '60')
  .action(async (qid, o) => {
    if (!qid && !o.task && !o.any) throw new CliError('await needs <Q-id>, --task <id>, or --any', 1);
    const path = qid
      ? `/api/input-requests/${qid}/await?timeout=${o.timeout}`
      : `/api/await?${new URLSearchParams(clean({ task: o.task, any: o.any, timeout: o.timeout }))}`;
    const r = await api(await conn(), 'GET', path);
    if (r.__status === 204) { out('pending'); process.exitCode = 2; return; }
    if (r.status === 'none') { out('no open questions'); return; }
    const id = r.request_id ?? qid;
    out(r.status === 'answered' ? `${id} answered${r.defaulted ? ' (defaulted)' : ''}: ${r.answer}` : `${id} ${r.status}`);
  });

program.command('answer <qid> <text>').action(async (qid, text) => { const r = await api(await conn(), 'POST', `/api/input-requests/${qid}/answer`, { answer: text, answered_by: 'cli' }); out(`${qid} -> ${r.answer}`); });
program.command('cancel <qid>').description('withdraw an open input request').action(async (qid) => { await api(await conn(), 'POST', `/api/input-requests/${qid}/cancel`); out(`${qid} cancelled`); });

// ---- lifecycle -----------------------------------------------------------
const board = program.command('board');
board.command('init').option('--name <n>').action((o) => { const p = initBoard(program.opts().board || process.cwd(), o.name); out(`board initialized at ${p.dir}`); });
board.command('show').action(async () => {
  const r = await api(await conn(), 'GET', '/api/board');
  const meta = readBoardMeta(boardPaths(r.root));
  out(JSON.stringify({ ...r, nudge: meta.nudge ? redactNudge(meta.nudge) : null }, null, 2));
});

// External-nudge auto-resume config (docs/04 §3C). Local board.json edit — no
// server round-trip. Env (KANBAN_NUDGE_URL / KANBAN_NUDGE_CMD) overrides at runtime.
board
  .command('nudge')
  .description('configure external-nudge auto-resume (webhook / command on input.answered)')
  .option('--url <url>', 'webhook URL to POST answered events to')
  .option('--cmd <cmd>', 'local command to spawn on an answer')
  .option('--header <kv...>', 'webhook header as key=value (repeatable)')
  .option('--clear', 'remove all nudge config')
  .action((o) => {
    const root = program.opts().board ?? findBoardRoot(process.cwd());
    if (!root) throw new CliError('no board here — run `kanban board init` first', 3);
    const paths = boardPaths(root);
    const meta = readBoardMeta(paths);
    if (o.clear) {
      delete meta.nudge;
      writeBoardMeta(paths, meta);
      out('nudge config cleared');
      return;
    }
    if (o.url || o.cmd || o.header) {
      const nudge: NudgeConfig = { ...meta.nudge };
      if (o.url) nudge.url = o.url;
      if (o.cmd) nudge.cmd = o.cmd;
      if (o.header) nudge.headers = { ...nudge.headers, ...parseHeaders(o.header) };
      meta.nudge = nudge;
      writeBoardMeta(paths, meta);
      out('nudge config saved (restart the server to apply)');
    }
    out(meta.nudge ? JSON.stringify(redactNudge(meta.nudge), null, 2) : 'no nudge configured');
  });

program.command('export').option('--out <file>', 'write JSON to a file instead of stdout').action(async (o) => {
  const snap = await api(await conn(), 'GET', '/api/export');
  const json = JSON.stringify(snap, null, 2);
  if (o.out) { fs.writeFileSync(o.out, json); out(`exported ${snap.tasks.length} tasks -> ${o.out}`); }
  else out(json);
});

program
  .command('completion <shell>')
  .description('print a static shell completion script (bash | zsh | pwsh)')
  .action((shell) => {
    const s = normalizeShell(shell);
    if (!s) throw new CliError(`unknown shell '${shell}' — use bash, zsh, or pwsh`, 1);
    out(renderCompletion(specFromCommand(program), s));
  });

program.command('open').action(async () => {
  const c = await conn();
  const url = `${c.base}/?token=${c.token}`;
  out(`open: ${url}`);
});

program.command('serve').option('--port <n>', 'bind a specific port (default: ephemeral)').action(async (o) => {
  const root = program.opts().board || process.cwd();
  const { startServer } = await import('../server/server');
  const h = await startServer({ root, port: o.port ? Number(o.port) : undefined });
  out(`KanAgentBan server: ${h.url}  (board: ${root})`);
  // keep the process alive (foreground)
});

program.parseAsync(process.argv).catch((e: unknown) => {
  if (e instanceof CliError) { process.stderr.write(`error: ${e.message}\n`); process.exitCode = e.code; }
  else { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }
});

// helpers
function clean<T extends Record<string, unknown>>(o: T): Record<string, string> {
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== false) r[k] = String(v);
  return r;
}
function parseHeaders(pairs: string[]): Record<string, string> {
  const h: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) h[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return h;
}
/** Hide secrets when displaying nudge config: drop the URL query/userinfo and
 *  mask any header values (they may carry auth tokens). */
function redactNudge(n: NudgeConfig): NudgeConfig {
  const r: NudgeConfig = { ...n };
  if (r.url) {
    try {
      const u = new URL(r.url);
      r.url = `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
    } catch {
      /* leave malformed URL as-is */
    }
  }
  if (r.headers) r.headers = Object.fromEntries(Object.keys(r.headers).map((k) => [k, '…']));
  return r;
}
