#!/usr/bin/env node
import * as fs from 'node:fs';
import { Command } from 'commander';
import { api, CliError, connect, initBoard } from './board';
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
  .option('--json')
  .action(async (o) => {
    const c = await conn();
    const q = new URLSearchParams();
    if (o.context) q.set('context', '1');
    if (o.n) q.set('n', o.n);
    if (o.mine) q.set('mine', '1');
    if (o.json) q.set('json', '1');
    const r = await api(c, 'GET', `/api/next?${q}`);
    out(o.json ? JSON.stringify(r, null, 2) : r.text);
  });

program
  .command('list')
  .option('--status <s>')
  .option('--label <l>')
  .option('--limit <n>')
  .option('--json')
  .action(async (o) => {
    const c = await conn();
    const q = new URLSearchParams(clean({ status: o.status, label: o.label, limit: o.limit, json: o.json }));
    const r = await api(c, 'GET', `/api/tasks?${q}`);
    out(o.json ? JSON.stringify(r.tasks, null, 2) : r.text);
  });

program
  .command('show <id>')
  .option('--json')
  .action(async (id, o) => {
    const q = o.json ? '?json=1' : '';
    const r = await api(await conn(), 'GET', `/api/tasks/${id}${q}`);
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
  .requiredOption('--since <seq>')
  .action(async (id, o) => {
    const r = await api(await conn(), 'GET', `/api/tasks/${id}/watch?since=${o.since}`);
    out(JSON.stringify(r, null, 2));
  });

program
  .command('changes')
  .requiredOption('--since <seq>')
  .action(async (o) => out(JSON.stringify(await api(await conn(), 'GET', `/api/changes?since=${o.since}`), null, 2)));

program.command('inbox').action(async () => out(JSON.stringify(await api(await conn(), 'GET', '/api/inbox'), null, 2)));

// ---- write / workflow ----------------------------------------------------
program
  .command('add <title>')
  .option('--desc <t>')
  .option('--summary <t>')
  .option('--status <s>')
  .option('--prio <p>')
  .option('--label <list>', 'comma-separated')
  .option('--depends <list>', 'comma-separated task ids')
  .option('--ac <text...>', 'acceptance criterion (repeatable)')
  .action(async (title, o) => {
    const t = await api(await conn(), 'POST', '/api/tasks', {
      title,
      description: o.desc,
      summary: o.summary,
      status: o.status,
      priority: o.prio,
      labels: split(o.label),
      depends: split(o.depends),
      criteria: o.ac,
    });
    out(`${t.id}  created`);
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

program.command('move <id> <column>').action(async (id, column) => {
  const t = await api(await conn(), 'POST', `/api/tasks/${id}/move`, { status: column });
  out(`${t.id} -> ${t.status}`);
});
program.command('done <id>').action(async (id) => {
  const t = await api(await conn(), 'POST', `/api/tasks/${id}/move`, { status: 'Done' });
  out(`${t.id} -> Done`);
});
program.command('archive <id>').action(async (id) => { await api(await conn(), 'POST', `/api/tasks/${id}/archive`); out(`${id} archived`); });

program.command('claim <id>').option('--force', 'steal a claim held by another agent').action(async (id, o) => {
  const t = await api(await conn(), 'POST', `/api/tasks/${id}/claim`, o.force ? { force: true } : undefined);
  out(`${t.id} claimed by ${t.assignee}`);
});
program.command('release <id>').option('--force', 'release a claim held by another agent').action(async (id, o) => {
  const t = await api(await conn(), 'POST', `/api/tasks/${id}/release`, o.force ? { force: true } : undefined);
  out(t.assignee ? `${t.id} still claimed by ${t.assignee}` : `${t.id} released`);
});

const dep = program.command('dep');
dep.command('add <id>').requiredOption('--on <id>').action(async (id, o) => { await api(await conn(), 'POST', `/api/tasks/${id}/deps`, { on: o.on }); out(`${id} now blocked by ${o.on}`); });
dep.command('rm <id>').requiredOption('--on <id>').action(async (id, o) => { await api(await conn(), 'DELETE', `/api/tasks/${id}/deps?on=${o.on}`); out(`removed ${id} -> ${o.on}`); });

program.command('comment <id> <body>').action(async (id, body) => { const c = await api(await conn(), 'POST', `/api/tasks/${id}/comments`, { body }); out(`${c.id} added`); });

const crit = program.command('criterion');
crit.command('add <id> <text>').action(async (id, text) => { const r = await api(await conn(), 'POST', `/api/tasks/${id}/criteria`, { text }); out(`${r.id} added`); });
crit.command('check <acid>').option('--off').action(async (acid, o) => { await api(await conn(), 'PATCH', `/api/criteria/${acid}`, { checked: !o.off }); out(`${acid} ${o.off ? 'unchecked' : 'checked'}`); });

program.command('label <id>').option('--add <l>').option('--rm <l>').action(async (id, o) => {
  const c = await conn();
  if (o.add) { await api(c, 'POST', `/api/tasks/${id}/labels`, { name: o.add }); out(`+${o.add}`); }
  if (o.rm) { await api(c, 'DELETE', `/api/tasks/${id}/labels?name=${o.rm}`); out(`-${o.rm}`); }
});

program.command('artifact <id>').requiredOption('--kind <k>').requiredOption('--title <t>').requiredOption('--uri <u>')
  .action(async (id, o) => { const a = await api(await conn(), 'POST', `/api/tasks/${id}/artifacts`, { kind: o.kind, title: o.title, uri: o.uri }); out(`${a.id} added`); });

program.command('summarize <id> <summary>').action(async (id, summary) => { await api(await conn(), 'POST', `/api/tasks/${id}/summary`, { summary }); out(`${id} summary updated`); });

// ---- human-in-the-loop ---------------------------------------------------
program.command('ask <id> <question>').option('--options <list>').option('--freeform').option('--expires-at <iso>')
  .action(async (id, question, o) => {
    const r = await api(await conn(), 'POST', `/api/tasks/${id}/input-requests`, { question, options: split(o.options), freeform: !!o.freeform, expires_at: o.expiresAt });
    out(`${r.id}  created on ${id} (task now needs input)`);
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
    out(`${r.request_id ?? qid} answered: ${r.answer}`);
  });

program.command('answer <qid> <text>').action(async (qid, text) => { const r = await api(await conn(), 'POST', `/api/input-requests/${qid}/answer`, { answer: text, answered_by: 'cli' }); out(`${qid} -> ${r.answer}`); });

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
function split(s?: string): string[] | undefined {
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
}
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
