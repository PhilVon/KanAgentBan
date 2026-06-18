import express, { type NextFunction, type Request, type Response } from 'express';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { openDb, type DB } from './db';
import { Repo, ConflictError, NotFoundError, ValidationError } from './repo';
import {
  renderContext,
  renderList,
  renderNext,
  renderShow,
  estimateTokens,
  FORMAT_VERSION,
} from './render';
import { recommend } from './recommend';
import { deriveState } from './derive';
import { ensureBoard, readToken, readBoardMeta } from '../shared/board-paths';
import { attachNudge } from './nudge';
import { DISPLAY_COLUMNS, type ActorType, type NudgeConfig } from '../shared/types';

const WEB_DIR = path.resolve(__dirname, '../../web');
// Non-sensitive client assets served without a token (see auth middleware).
const STATIC_PATHS = new Set(['/', '/index.html', '/app.js', '/style.css']);

// helpers
const errBody = (code: string, message: string) => ({ error: { code, message } });
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));

// Loopback guard for Origin/Host headers (docs/10-security-lifecycle §4).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
function loopbackHostname(hostHeader?: string): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}
function wrap(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);
}

/** Build the Express app for a given repo + token. Exported for tests. */
export function buildApp(repo: Repo, token: string, root: string): express.Express {
  const db: DB = repo.db;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // --- security: localhost origin + bearer token (docs/10-security-lifecycle) -
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/healthz') return next();
    const origin = req.get('origin');
    if (origin) {
      try {
        const h = new URL(origin).hostname;
        if (h !== '127.0.0.1' && h !== 'localhost')
          return res.status(403).json(errBody('forbidden_origin', 'bad origin'));
      } catch {
        return res.status(403).json(errBody('forbidden_origin', 'bad origin'));
      }
    }
    // Host must be loopback — blocks DNS rebinding (docs/10 §4).
    const host = loopbackHostname(req.get('host'));
    if (!host || !LOOPBACK.has(host))
      return res.status(403).json(errBody('forbidden_host', 'bad host'));
    // Static client assets carry no board data; serve them without a token so the
    // browser can bootstrap (sub-resource GETs can't send a Bearer header). The
    // token still guards every /api and /ws path; Origin/Host checks above apply.
    if (req.method === 'GET' && STATIC_PATHS.has(req.path)) return next();
    const auth = req.get('authorization') || '';
    const got = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (got !== token) return res.status(401).json(errBody('unauthorized', 'bad or missing token'));
    next();
  });

  const actor = (req: Request): ActorType => (req.get('x-actor') as ActorType) || 'agent';
  // Agent *identity* (multi-agent claim), distinct from the actor *type* above.
  const agentId = (req: Request): string => str(req.get('x-agent')) ?? 'agent';

  // Structured working set for the UI drawer and `--json` context reads.
  const taskDetail = (id: string) => {
    const t = repo.requireTask(id);
    return {
      task: t,
      derived: deriveState(db, t),
      criteria: repo.getCriteria(t.id),
      blockers: repo.getBlockers(t.id),
      blocked_by: repo.getBlockedBy(t.id),
      comments: repo.getComments(t.id),
      artifacts: repo.getArtifacts(t.id),
      labels: repo.getLabels(t.id),
      open_input: repo.getOpenRequests(t.id),
    };
  };

  // --- board & health ---------------------------------------------------
  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, format_version: FORMAT_VERSION, seq: repo.maxSeq() }),
  );
  app.get('/api/board', (_req, res) =>
    res.json({ root, format_version: FORMAT_VERSION, seq: repo.maxSeq() }),
  );

  // UI-oriented board view: cards with derived flags + the input inbox.
  app.get('/api/ui/board', (_req, res) => {
    const tasks = repo.listTasks({}).map((t) => {
      const d = deriveState(db, t);
      const crit = repo.getCriteria(t.id);
      return {
        ...t,
        ...d,
        column: d.blocked_by_deps || d.needs_input ? 'Blocked' : t.status,
        comments: repo.countComments(t.id),
        open_input: repo.getOpenRequests(t.id).length,
        criteria_done: crit.filter((c) => c.checked).length,
        criteria_total: crit.length,
        labels: repo.getLabels(t.id),
      };
    });
    res.json({ columns: DISPLAY_COLUMNS, tasks, inbox: repo.getOpenRequests(), seq: repo.maxSeq() });
  });

  // Per-task detail for the UI drawer.
  app.get('/api/ui/tasks/:id', wrap((req, res) => res.json(taskDetail(req.params.id))));

  // --- reads ------------------------------------------------------------
  app.get('/api/next', (req, res) => {
    const n = num(req.query.n);
    const agent = agentId(req);
    const mine = req.query.mine !== undefined;
    const text = renderNext(repo, {
      context: req.query.context !== undefined,
      n,
      agent,
      mine,
      full: req.query.full !== undefined,
      maxTokens: num(req.query.max_tokens),
    });
    if (req.query.json !== undefined) {
      const r = recommend(repo, n ?? 1, agent, mine);
      const meter = { est_tokens: estimateTokens(text) };
      return res.json('none' in r ? { text, blocked: r.blocked, ...meter } : { text, next: r, ...meter });
    }
    res.json({ text });
  });
  app.get('/api/tasks', (req, res) => {
    const opts = {
      status: str(req.query.status),
      label: str(req.query.label),
      limit: num(req.query.limit),
      full: req.query.full !== undefined,
      maxTokens: num(req.query.max_tokens),
    };
    if (req.query.json !== undefined)
      return res.json({ tasks: repo.listTasks(opts), est_tokens: estimateTokens(renderList(repo, opts)) });
    res.json({ text: renderList(repo, opts) });
  });
  app.get(
    '/api/tasks/:id',
    wrap((req, res) => {
      const view = str(req.query.view) ?? 'show';
      const text =
        view === 'context'
          ? renderContext(repo, req.params.id, {
              full: req.query.full !== undefined,
              maxTokens: num(req.query.max_tokens),
            })
          : renderShow(repo, req.params.id, {
              full: req.query.full !== undefined,
              maxTokens: num(req.query.max_tokens),
            });
      if (req.query.json !== undefined) {
        const meter = { est_tokens: estimateTokens(text) };
        return res.json(
          view === 'context'
            ? { ...taskDetail(req.params.id), ...meter }
            : { task: repo.requireTask(req.params.id), ...meter },
        );
      }
      res.json({ text, task: repo.getTask(req.params.id) });
    }),
  );
  app.get(
    '/api/tasks/:id/watch',
    wrap((req, res) =>
      res.json({ events: repo.watch(req.params.id, num(req.query.since) ?? 0), cursor: repo.maxSeq() }),
    ),
  );
  app.get('/api/changes', (req, res) =>
    res.json({ events: repo.changes(num(req.query.since) ?? 0), cursor: repo.maxSeq() }),
  );
  app.get('/api/inbox', (req, res) => res.json(repo.inbox(num(req.query.since) ?? 0)));

  // --- mutations --------------------------------------------------------
  app.post('/api/tasks', wrap((req, res) => res.json(repo.createTask({ ...req.body, actor: actor(req) }))));
  app.patch(
    '/api/tasks/:id',
    wrap((req, res) => {
      const expect = req.get('if-match');
      res.json(
        repo.updateTask(req.params.id, req.body, {
          expectVersion: expect ? Number(expect) : undefined,
          actor: actor(req),
        }),
      );
    }),
  );
  app.post('/api/tasks/:id/move', wrap((req, res) => res.json(repo.moveTask(req.params.id, req.body.status, actor(req)))));
  app.post('/api/tasks/:id/claim', wrap((req, res) =>
    res.json(repo.claimTask(req.params.id, agentId(req), { force: !!req.body?.force, actor: actor(req) })),
  ));
  app.post('/api/tasks/:id/release', wrap((req, res) =>
    res.json(repo.releaseTask(req.params.id, agentId(req), { force: !!req.body?.force, actor: actor(req) })),
  ));
  app.post(
    '/api/tasks/:id/archive',
    wrap((req, res) => {
      repo.archiveTask(req.params.id, actor(req));
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/tasks/:id/deps',
    wrap((req, res) => {
      repo.addDep(req.params.id, req.body.on, actor(req));
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/tasks/:id/deps',
    wrap((req, res) => {
      repo.removeDep(req.params.id, str(req.query.on)!, actor(req));
      res.json({ ok: true });
    }),
  );
  app.post('/api/tasks/:id/comments', wrap((req, res) =>
    res.json(repo.addComment(req.params.id, req.body.body, actor(req), req.body.author_name ?? 'claude')),
  ));
  app.post('/api/tasks/:id/criteria', wrap((req, res) =>
    res.json({ id: repo.addCriterion(req.params.id, req.body.text, actor(req)) }),
  ));
  app.patch(
    '/api/criteria/:acid',
    wrap((req, res) => {
      repo.checkCriterion(req.params.acid, !!req.body.checked, actor(req));
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/tasks/:id/labels',
    wrap((req, res) => {
      repo.addLabel(req.params.id, req.body.name, actor(req));
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/tasks/:id/labels',
    wrap((req, res) => {
      repo.removeLabel(req.params.id, str(req.query.name)!, actor(req));
      res.json({ ok: true });
    }),
  );
  app.post('/api/tasks/:id/artifacts', wrap((req, res) =>
    res.json(repo.addArtifact(req.params.id, req.body.kind, req.body.title, req.body.uri, actor(req))),
  ));
  app.post('/api/tasks/:id/summary', wrap((req, res) =>
    res.json(repo.updateTask(req.params.id, { summary: req.body.summary }, { actor: actor(req) })),
  ));

  // --- human-in-the-loop ------------------------------------------------
  app.post('/api/tasks/:id/input-requests', wrap((req, res) =>
    res.json(
      repo.ask(req.params.id, req.body.question, {
        options: req.body.options,
        freeform: req.body.freeform,
        expiresAt: req.body.expires_at,
        actor: actor(req),
      }),
    ),
  ));
  app.post('/api/input-requests/:qid/answer', wrap((req, res) =>
    res.json(repo.answer(req.params.qid, req.body.answer, req.body.answered_by ?? 'user')),
  ));
  // Long-poll await — checks committed state BEFORE parking (no lost wakeup).
  app.get(
    '/api/input-requests/:qid/await',
    wrap(async (req, res) => {
      const qid = req.params.qid;
      const existing = repo.getRequest(qid);
      if (!existing) return res.status(404).json(errBody('not_found', 'no such request'));
      if (existing.status === 'answered')
        return res.json({ status: 'answered', answer: existing.answer });
      const timeoutMs = (num(req.query.timeout) ?? 60) * 1000;
      const ev = await repo.bus.waitFor(
        (e) => e.type === 'input.answered' && (e.payload as any).request_id === qid,
        timeoutMs,
      );
      if (!ev) return res.status(204).end(); // pending -> CLI exit 2
      res.json({ status: 'answered', answer: (ev.payload as any).answer });
    }),
  );
  // Scoped long-poll await: wait for the next answer to any open request on a
  // task (?task=T-n) or anywhere (?any=1). Subscribe-then-read order avoids the
  // lost-wakeup race; clean up immediately when there is nothing to wait on.
  app.get(
    '/api/await',
    wrap(
      (req, res) =>
        new Promise<void>((resolve) => {
          const task = str(req.query.task);
          const any = req.query.any !== undefined;
          if (!task && !any) {
            res.status(400).json(errBody('validation', 'await needs ?task= or ?any='));
            return resolve();
          }
          const timeoutMs = (num(req.query.timeout) ?? 60) * 1000;
          const inScope = (e: any) =>
            e.type === 'input.answered' && (any || e.task_id === task);
          const onEvent = (e: any) => {
            if (!inScope(e)) return;
            cleanup();
            res.json({ status: 'answered', request_id: e.payload.request_id, answer: e.payload.answer });
            resolve();
          };
          const timer = setTimeout(() => {
            cleanup();
            res.status(204).end(); // pending -> CLI exit 2
            resolve();
          }, timeoutMs);
          const cleanup = () => {
            clearTimeout(timer);
            repo.bus.off('event', onEvent);
          };
          repo.bus.on('event', onEvent); // subscribe FIRST
          if (repo.getOpenRequests(task).length === 0) {
            cleanup();
            res.json({ status: 'none' }); // nothing open in scope -> don't hang
            resolve();
          }
        }),
    ),
  );

  // --- export -----------------------------------------------------------
  app.get('/api/export', (_req, res) => res.json({ format_version: FORMAT_VERSION, ...repo.snapshot() }));

  // --- static web UI ----------------------------------------------------
  if (fs.existsSync(WEB_DIR)) app.use(express.static(WEB_DIR));

  // --- error mapper -----------------------------------------------------
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (e instanceof NotFoundError) return res.status(404).json(errBody('not_found', e.message));
    if (e instanceof ConflictError) return res.status(409).json(errBody('conflict', e.message));
    if (e instanceof ValidationError) return res.status(400).json(errBody('validation', e.message));
    res.status(500).json(errBody('internal', e instanceof Error ? e.message : 'error'));
  });

  return app;
}

/** Attach the WebSocket broadcaster (subscribe-then-replay) to an http server. */
export function attachWs(server: http.Server, repo: Repo, token: string): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.searchParams.get('token') !== token) return ws.close(4401, 'unauthorized');
    // Loopback-only handshake (docs/10 §4): reject foreign Origin / Host.
    const origin = req.headers.origin;
    if (origin) {
      const oh = loopbackHostname(new URL(origin).host);
      if (!oh || !LOOPBACK.has(oh)) return ws.close(4403, 'forbidden');
    }
    const host = loopbackHostname(req.headers.host);
    if (!host || !LOOPBACK.has(host)) return ws.close(4403, 'forbidden');
    const sent = new Set<number>();
    const onEvent = (ev: any) => {
      if (sent.has(ev.seq)) return;
      sent.add(ev.seq);
      ws.send(JSON.stringify(ev));
    };
    repo.bus.on('event', onEvent); // subscribe FIRST
    const since = Number(url.searchParams.get('since') ?? 0);
    for (const ev of repo.changes(since)) onEvent(ev); // then replay; dedupe by seq
    ws.on('close', () => repo.bus.off('event', onEvent));
  });
  return wss;
}

export interface ServerHandle {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  url: string;
  token: string;
  repo: Repo;
  close: () => Promise<void>;
}

/** Open the board DB, build the app + WS, and start listening. */
export async function startServer(opts: { root?: string; port?: number } = {}): Promise<ServerHandle> {
  const root = opts.root || process.env.BOARD_ROOT || process.cwd();
  const paths = ensureBoard(root);
  const token = readToken(paths);
  const db = openDb(paths.db);
  const repo = new Repo(db);
  const app = buildApp(repo, token, root);
  const server = http.createServer(app);
  const wss = attachWs(server, repo, token);

  // External-nudge auto-resume (docs/04 §3C). Config from board.json, with env
  // overrides for ad-hoc / secret-bearing values. Inert unless configured.
  const meta = readBoardMeta(paths);
  const nudge: NudgeConfig = {
    ...meta.nudge,
    url: process.env.KANBAN_NUDGE_URL ?? meta.nudge?.url,
    cmd: process.env.KANBAN_NUDGE_CMD ?? meta.nudge?.cmd,
  };
  const detachNudge = attachNudge(repo, nudge, root);

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as any).port as number;
  fs.writeFileSync(paths.port, String(port));
  fs.writeFileSync(paths.pid, String(process.pid));

  const close = () =>
    new Promise<void>((resolve) => {
      detachNudge();
      wss.close();
      server.close(() => {
        db.close();
        try {
          fs.rmSync(paths.port);
          fs.rmSync(paths.pid);
        } catch {
          /* ignore */
        }
        resolve();
      });
    });

  return { server, wss, port, url: `http://127.0.0.1:${port}`, token, repo, close };
}

// Run as a standalone process (CLI auto-start / `kanban serve`).
if (require.main === module) {
  startServer()
    .then((h) => {
      console.log(`KanAgentBan server: ${h.url}  (board: ${process.env.BOARD_ROOT || process.cwd()})`);
      const shutdown = () => h.close().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((e) => {
      console.error('failed to start server:', e);
      process.exit(1);
    });
}
