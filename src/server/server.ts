import express, { type NextFunction, type Request, type Response } from 'express';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { openDb, type DB } from './db';
import { Repo, ConflictError, NotFoundError, ValidationError } from './repo';
import {
  renderBrainstorm,
  renderBrainstormList,
  renderContext,
  renderDoc,
  renderDocList,
  renderDoctor,
  renderList,
  renderNext,
  renderSearch,
  renderShow,
  renderStandup,
  renderStats,
  renderTaskStats,
  estimateTokens,
  FORMAT_VERSION,
} from './render';
import { recommend } from './recommend';
import { runDoctor } from './doctor';
import { standup } from './standup';
import { boardStats, taskTiming } from './stats';
import { childProgress, countCriteria, deriveState } from './derive';
import {
  affectLine,
  consultAboutCommand,
  cuesForLabels,
  AFFECT_OFF,
  type AffectConfig,
} from './affect';
import { ensureBoard, readToken, readBoardMeta } from '../shared/board-paths';
import { attachNudge } from './nudge';
import { DISPLAY_COLUMNS, type ActorType, type InputKind, type NudgeConfig } from '../shared/types';

const WEB_DIR = path.resolve(__dirname, '../../web');
// Non-sensitive client assets served without a token (see auth middleware).
const STATIC_PATHS = new Set(['/', '/index.html', '/app.js', '/style.css']);
// Vendored static assets (e.g. self-hosted Font Awesome) — token-free by prefix.
const STATIC_PREFIXES = ['/vendor/'];

// Terminal input-request transitions an `await` waiter resolves on.
const INPUT_RESOLVED = new Set(['input.answered', 'input.cancelled', 'input.expired']);
// Input-request expiry sweep interval — resolves past-due questions (see repo.expireDue).
const EXPIRY_SWEEP_MS = 60 * 1000;

// Event-log retention: keep at most this many events; a low-frequency timer
// compacts the tail above it and `kanban compact` triggers it on demand. `0`
// disables auto-compaction. Read at call time so tests can override the env.
const eventRetention = () => Number(process.env.KANBAN_EVENT_RETENTION ?? 50000);

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
  // Project identity for the UI: board.json `name` (set at init from the dir
  // basename, editable) so multiple concurrent boards are distinguishable.
  const boardName = readBoardMeta(ensureBoard(root)).name || path.basename(root);
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
    if (
      req.method === 'GET' &&
      (STATIC_PATHS.has(req.path) || STATIC_PREFIXES.some((p) => req.path.startsWith(p)))
    )
      return next();
    const auth = req.get('authorization') || '';
    const got = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (got !== token) return res.status(401).json(errBody('unauthorized', 'bad or missing token'));
    next();
  });

  // Affect config is read per request, not cached at boot: `kanban board affect
  // --on` writes board.json locally, and a restart to pick it up would be a
  // surprising cost for a preference nudge. Off unless explicitly enabled.
  const affect = (): AffectConfig => {
    const m = readBoardMeta(ensureBoard(root)).affect;
    return m?.enabled ? { enabled: true, map: m.map ?? {} } : AFFECT_OFF;
  };
  /** The hint for a prospective action, or null when hints are off. */
  const actionHint = (what: string, labels: string[]): string | null => {
    const cfg = affect();
    if (!cfg.enabled) return null;
    return affectLine(consultAboutCommand(what, cuesForLabels(labels, cfg.map)));
  };

  const actor = (req: Request): ActorType => (req.get('x-actor') as ActorType) || 'agent';
  // Agent *identity* (multi-agent claim), distinct from the actor *type* above.
  const agentId = (req: Request): string => str(req.get('x-agent')) ?? 'agent';

  // Structured working set for the UI drawer and `--json` context reads.
  const taskDetail = (id: string) => {
    const t = repo.requireTask(id);
    const parent = repo.getParent(t.id);
    return {
      task: t,
      derived: deriveState(db, t),
      criteria: repo.getCriteria(t.id),
      blockers: repo.getBlockers(t.id),
      blocked_by: repo.getBlockedBy(t.id),
      parent: parent ? { id: parent.id, title: parent.title, status: parent.status } : null,
      children: repo.getChildren(t.id).map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        ...deriveState(db, c),
      })),
      comments: repo.getComments(t.id),
      artifacts: repo.getArtifacts(t.id),
      labels: repo.getLabels(t.id),
      open_input: repo.getOpenRequests(t.id),
      // Linked docs, titles + summaries only — a drawer/context read never pays
      // for doc bodies; those load via `doc show` / GET /api/docs/:id.
      docs: repo.getTaskDocs(t.id).map(({ body: _body, ...d }) => d),
    };
  };

  // --- board & health ---------------------------------------------------
  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, format_version: FORMAT_VERSION, seq: repo.maxSeq() }),
  );
  app.get('/api/board', (_req, res) =>
    res.json({ root, name: boardName, format_version: FORMAT_VERSION, seq: repo.maxSeq() }),
  );

  // One board card: task fields + the derived flags/rollups the UI renders. The
  // sole source of card shape — shared by the board view and the per-card refresh
  // route so an event-routed single-card update is byte-identical to a full load.
  const cardView = (t: ReturnType<typeof repo.requireTask>) => {
    const d = deriveState(db, t);
    const crit = repo.getCriteria(t.id);
    const kids = childProgress(db, t.id);
    return {
      ...t,
      ...d,
      column: d.blocked_by_deps || d.needs_input || d.blocked_by_children ? 'Blocked' : t.status,
      comments: repo.countComments(t.id),
      open_input: repo.getOpenRequests(t.id).length,
      ...(() => {
        // Retired criteria leave both sides of the card count; `criteria_retired`
        // and `criteria_human_open` are additive so an old client still reads.
        const n = countCriteria(crit);
        return {
          criteria_done: n.done,
          criteria_total: n.total,
          criteria_retired: n.retired,
          criteria_human_open: n.human_open,
        };
      })(),
      child_done: kids.done,
      child_total: kids.total,
      labels: repo.getLabels(t.id),
    };
  };

  // UI-oriented board view: cards with derived flags + the input inbox.
  app.get('/api/ui/board', (_req, res) => {
    res.json({
      name: boardName,
      columns: DISPLAY_COLUMNS,
      tasks: repo.listTasks({}).map(cardView),
      inbox: repo.getOpenRequests(),
      seq: repo.maxSeq(),
    });
  });

  // Single card for event-routed refresh — the UI fetches just the affected task
  // on a WebSocket frame instead of re-pulling the whole board. Archived tasks are
  // "gone" to the board: 404 them so a stray event (e.g. an input-expiry sweep) on
  // an already-archived task drives the client's removeCard path instead of
  // resurrecting the card into its old column.
  app.get(
    '/api/ui/tasks/:id/card',
    wrap((req, res) => {
      const t = repo.requireTask(req.params.id);
      if (t.archived_at !== null) throw new NotFoundError(`task ${t.id} is archived`);
      res.json(cardView(t));
    }),
  );

  // Per-task detail for the UI drawer.
  app.get('/api/ui/tasks/:id', wrap((req, res) => res.json(taskDetail(req.params.id))));

  // Activity log: newest-first page of retained events, optionally scoped to one
  // task; `before` pages older. `floor` rides along so bounded history is never
  // silent (a page read, not a delta cursor — no reset semantics needed).
  app.get('/api/ui/activity', (req, res) => {
    const rawLimit = num(req.query.limit);
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? (rawLimit as number) : 100));
    const task = req.query.task ? String(req.query.task) : undefined;
    res.json({
      events: repo.listEventsDesc({ task, before: num(req.query.before), limit }),
      floor: repo.floor(),
      cursor: repo.maxSeq(),
    });
  });

  // Dependency graph for the graph panel: light nodes + blocks-edges between
  // non-archived tasks. Edges point prerequisite -> dependent so the drawing
  // reads left-to-right in execution order (dependency rows store the reverse:
  // from_task is blocked by to_task).
  app.get('/api/ui/graph', (_req, res) => {
    const tasks = repo.listTasks({});
    const ids = new Set(tasks.map((t) => t.id));
    res.json({
      nodes: tasks.map((t) => {
        const d = deriveState(db, t);
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          blocked: d.blocked_by_deps || d.needs_input || d.blocked_by_children,
        };
      }),
      edges: repo
        .getDependencies()
        .filter((e) => e.type === 'blocks' && ids.has(e.from_task) && ids.has(e.to_task))
        .map((e) => ({ from: e.to_task, to: e.from_task })),
    });
  });

  // Docs panel: list rows (no bodies) with their linked task ids; the panel
  // fetches GET /api/docs/:id?json for a body on click.
  app.get('/api/ui/docs', (_req, res) => {
    res.json({
      docs: repo.listDocs({}).map(({ body: _b, ...d }) => ({ ...d, tasks: repo.getDocTasks(d.id) })),
    });
  });

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
      affect: affect(),
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
              affect: affect(),
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
  // Analytics — read-only derivation over the event log (docs/13-analytics.md).
  // Never-silent about the compaction floor (stamped on the json envelope).
  app.get('/api/stats', (req, res) => {
    const stats = boardStats(repo, { windowDays: num(req.query.window) });
    const text = renderStats(stats, { full: req.query.full !== undefined, maxTokens: num(req.query.max_tokens) });
    // The CFD series is per-day × per-status; gate it behind ?cfd=1 so the default
    // json envelope stays lean (the web panel opts in explicitly).
    const cfd = req.query.cfd !== undefined ? stats.cfd : [];
    if (req.query.json !== undefined) return res.json({ ...stats, cfd, text, est_tokens: estimateTokens(text) });
    res.json({ text });
  });
  app.get(
    '/api/tasks/:id/stats',
    wrap((req, res) => {
      const timing = taskTiming(repo, req.params.id); // 404 via requireTask + wrap
      const text = renderTaskStats(timing, {
        full: req.query.full !== undefined,
        maxTokens: num(req.query.max_tokens),
      });
      if (req.query.json !== undefined) return res.json({ ...timing, text, est_tokens: estimateTokens(text) });
      res.json({ text });
    }),
  );

  // Standup digest — narrative diff since ?since= (event seq) or over ?days=N.
  app.get('/api/standup', (req, res) => {
    const report = standup(repo, { since: num(req.query.since), days: num(req.query.days) });
    const text = renderStandup(report, {
      full: req.query.full !== undefined,
      maxTokens: num(req.query.max_tokens),
    });
    if (req.query.json !== undefined)
      return res.json({ ...report, text, est_tokens: estimateTokens(text) });
    res.json({ text, cursor: report.cursor });
  });

  // Hygiene report — read-only sweep over live rows (no event-log derivation).
  app.get('/api/doctor', (req, res) => {
    const report = runDoctor(repo);
    const text = renderDoctor(report, {
      full: req.query.full !== undefined,
      maxTokens: num(req.query.max_tokens),
    });
    if (req.query.json !== undefined)
      return res.json({ ...report, text, est_tokens: estimateTokens(text) });
    res.json({ text, healthy: report.healthy });
  });

  // Delta reads carry the compaction floor for transparency. A cursor predating
  // the floor gets `{reset:true}` instead of a silently-truncated delta — the
  // consumer must reseed from current state (docs/11-roadmap.md §2, docs/03).
  const resetBody = () => ({ reset: true, floor: repo.floor(), cursor: repo.maxSeq() });
  app.get(
    '/api/tasks/:id/watch',
    wrap((req, res) => {
      const since = num(req.query.since) ?? 0;
      if (repo.isStale(since)) return res.json(resetBody());
      res.json({ events: repo.watch(req.params.id, since), cursor: repo.maxSeq(), floor: repo.floor() });
    }),
  );
  app.get('/api/changes', (req, res) => {
    const since = num(req.query.since) ?? 0;
    if (repo.isStale(since)) return res.json(resetBody());
    res.json({ events: repo.changes(since), cursor: repo.maxSeq(), floor: repo.floor() });
  });
  app.get('/api/inbox', (req, res) => {
    const since = num(req.query.since) ?? 0;
    if (repo.isStale(since)) return res.json(resetBody());
    res.json({ ...repo.inbox(since), floor: repo.floor() });
  });

  // --- search (board-wide, FTS5 with LIKE fallback) ----------------------
  app.get('/api/search', (req, res) => {
    const q = str(req.query.q);
    if (!q) return res.status(400).json(errBody('validation', 'search needs ?q='));
    const { hits: results, loose } = repo.searchBoard(q, {
      type: str(req.query.type),
      limit: num(req.query.limit),
    });
    const text = renderSearch(results, q, {
      full: req.query.full !== undefined,
      maxTokens: num(req.query.max_tokens),
      loose,
    });
    if (req.query.json !== undefined)
      return res.json({ results, loose, fts: repo.ftsEnabled(), text, est_tokens: estimateTokens(text) });
    res.json({ text });
  });

  // --- docs (board-native knowledge — ADR 0007) --------------------------
  app.get('/api/docs', (req, res) => {
    const docs = repo.listDocs({
      kind: str(req.query.kind),
      status: str(req.query.status),
      task: str(req.query.task),
      limit: num(req.query.limit),
    });
    const text = renderDocList(docs, { full: req.query.full !== undefined, maxTokens: num(req.query.max_tokens) });
    if (req.query.json !== undefined)
      // List reads never carry bodies — that's `GET /api/docs/:id`'s job.
      return res.json({ docs: docs.map(({ body: _b, ...d }) => d), est_tokens: estimateTokens(text) });
    res.json({ text });
  });
  app.post('/api/docs', wrap((req, res) => res.json(repo.createDoc({ ...req.body, actor: actor(req) }))));
  app.get(
    '/api/docs/:id',
    wrap((req, res) => {
      const text = renderDoc(repo, req.params.id, {
        full: req.query.full !== undefined,
        maxTokens: num(req.query.max_tokens),
      });
      if (req.query.json !== undefined) {
        const d = repo.requireDoc(req.params.id);
        return res.json({ ...d, tasks: repo.getDocTasks(d.id), est_tokens: estimateTokens(text) });
      }
      res.json({ text });
    }),
  );
  app.patch('/api/docs/:id', wrap((req, res) => res.json(repo.updateDoc(req.params.id, req.body, actor(req)))));
  app.post(
    '/api/docs/:id/archive',
    wrap((req, res) => {
      repo.archiveDoc(req.params.id, actor(req));
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/docs/:id/links',
    wrap((req, res) => {
      repo.linkDoc(req.params.id, req.body.task, actor(req));
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/docs/:id/links',
    wrap((req, res) => {
      repo.unlinkDoc(req.params.id, str(req.query.task)!, actor(req));
      res.json({ ok: true });
    }),
  );

  // --- brainstorms (ideation: capture -> cluster/score -> promote) -------
  app.get('/api/brainstorms', (req, res) => {
    const sessions = repo.listBrainstorms({ status: str(req.query.status), task: str(req.query.task) });
    const text = renderBrainstormList(repo, sessions, {
      full: req.query.full !== undefined,
      maxTokens: num(req.query.max_tokens),
    });
    if (req.query.json !== undefined) return res.json({ sessions, est_tokens: estimateTokens(text) });
    res.json({ text });
  });
  app.post('/api/brainstorms', wrap((req, res) => {
    const s = repo.startBrainstorm(req.body.topic, { task: req.body.task, actor: actor(req) });
    // The strongest moment by construction: more than ~3 candidate approaches
    // IS the definition of an open choice.
    const labels = s.task_id ? repo.getLabels(s.task_id) : [];
    const hint = actionHint(s.topic, labels);
    res.json(hint ? { ...s, affect: hint } : s);
  }));
  app.get(
    '/api/brainstorms/:id',
    wrap((req, res) => {
      const text = renderBrainstorm(repo, req.params.id, {
        full: req.query.full !== undefined,
        maxTokens: num(req.query.max_tokens),
      });
      if (req.query.json !== undefined) {
        const s = repo.requireBrainstorm(req.params.id);
        return res.json({ ...s, ideas: repo.getIdeas(s.id), est_tokens: estimateTokens(text) });
      }
      res.json({ text });
    }),
  );
  app.post('/api/brainstorms/:id/close', wrap((req, res) => res.json(repo.closeBrainstorm(req.params.id, actor(req)))));
  app.post('/api/brainstorms/:id/ideas', wrap((req, res) =>
    res.json(repo.addIdea(req.params.id, req.body.text, { cluster: req.body.cluster, actor: actor(req) })),
  ));
  app.patch('/api/ideas/:id', wrap((req, res) =>
    res.json(
      repo.updateIdea(
        req.params.id,
        { score: req.body.score, cluster: req.body.cluster, text: req.body.text, discard: !!req.body.discard },
        actor(req),
      ),
    ),
  ));
  app.post('/api/ideas/:id/promote', wrap((req, res) =>
    res.json(repo.promoteIdea(req.params.id, req.body?.task ?? {}, actor(req))),
  ));

  // --- templates (reusable blueprints) -----------------------------------
  app.get('/api/templates', (_req, res) => res.json({ templates: repo.listTemplates() }));
  app.get('/api/templates/:name', wrap((req, res) => res.json(repo.requireTemplate(req.params.name))));
  // PUT = save/overwrite a snapshot of task {from}; a template is config, not history.
  app.put('/api/templates/:name', wrap((req, res) =>
    res.json(repo.saveTemplateFromTask(req.params.name, req.body.from, actor(req))),
  ));
  app.delete('/api/templates/:name', wrap((req, res) => {
    repo.deleteTemplate(req.params.name, actor(req));
    res.json({ ok: true });
  }));
  app.post('/api/templates/:name/apply', wrap((req, res) =>
    res.json(
      repo.applyTemplate(
        req.params.name,
        { title: req.body.title, status: req.body.status, priority: req.body.priority, parent: req.body.parent },
        actor(req),
      ),
    ),
  ));

  // --- mutations --------------------------------------------------------
  app.post('/api/tasks', wrap((req, res) => res.json(repo.createTask({ ...req.body, actor: actor(req) }))));
  // Bulk-archive the Done column. Registered before the `:id` routes so the
  // literal `archive-done` segment is never captured as a task id.
  app.post('/api/tasks/archive-done', wrap((req, res) => res.json(repo.archiveDoneTasks(actor(req)))));
  // Bulk move/label/unlabel/archive: one transaction, one event per task,
  // all-or-nothing. Registered before the `:id` routes like archive-done.
  app.post('/api/tasks/bulk', wrap((req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    res.json(
      repo.bulk(req.body?.op, ids, { status: str(req.body?.status), name: str(req.body?.name) }, actor(req)),
    );
  }));
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
  // Review gate: {verdict: approve|reject, reason?} — reject requires a reason.
  app.post('/api/tasks/:id/review', wrap((req, res) =>
    res.json(
      repo.reviewTask(req.params.id, req.body?.verdict, {
        reason: str(req.body?.reason),
        actor: actor(req),
        by: agentId(req),
      }),
    ),
  ));
  app.post('/api/tasks/:id/parent', wrap((req, res) =>
    res.json(repo.setParent(req.params.id, req.body.parent ?? null, actor(req))),
  ));
  app.delete('/api/tasks/:id/parent', wrap((req, res) => res.json(repo.setParent(req.params.id, null, actor(req)))));
  app.post('/api/tasks/:id/claim', wrap((req, res) => {
    const t = repo.claimTask(req.params.id, agentId(req), {
      force: !!req.body?.force,
      ttlSeconds: num(req.body?.ttl),
      actor: actor(req),
    });
    // Committing to a piece of work is the estimating-difficulty moment.
    const hint = actionHint(`picking up ${t.id}: ${t.title}`, repo.getLabels(t.id));
    res.json(hint ? { ...t, affect: hint } : t);
  }));
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
    res.json({
      id: repo.addCriterion(req.params.id, req.body.text, actor(req), { human: !!req.body.human }),
    }),
  ));
  // PATCH carries the two in-place edits: `checked` ticks, `text` amends.
  app.patch(
    '/api/criteria/:acid',
    wrap((req, res) => {
      if (typeof req.body.text === 'string')
        return res.json(repo.amendCriterion(req.params.acid, req.body.text, actor(req)));
      repo.checkCriterion(req.params.acid, !!req.body.checked, actor(req));
      res.json({ ok: true });
    }),
  );
  // Retirement is its own route, not a PATCH field: it is a state transition
  // with a REQUIRED reason, and the reason is the point of the state.
  app.post(
    '/api/criteria/:acid/retire',
    wrap((req, res) =>
      res.json(
        repo.retireCriterion(req.params.acid, str(req.body.because) ?? '', {
          successor: str(req.body.successor),
          actor: actor(req),
        }),
      ),
    ),
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
  // Checkpoint resume pointer: `{text}` sets (latest wins), `{clear:true}` clears.
  // A body with neither is rejected — a malformed set must never silently clear.
  app.post('/api/tasks/:id/checkpoint', wrap((req, res) => {
    const clear = !!req.body?.clear;
    const text = req.body?.text;
    if (!clear && typeof text !== 'string')
      return res.status(400).json(errBody('validation', 'checkpoint needs {text} or {clear:true}'));
    res.json(
      repo.setCheckpoint(req.params.id, clear ? null : text, { actor: actor(req), by: agentId(req) }),
    );
  }));

  // --- human-in-the-loop ------------------------------------------------
  app.post('/api/tasks/:id/input-requests', wrap((req, res) =>
    res.json(
      repo.ask(req.params.id, req.body.question, {
        options: req.body.options,
        freeform: req.body.freeform,
        expiresAt: req.body.expires_at,
        defaultAnswer: str(req.body.default),
        actor: actor(req),
        // `kind: 'watch'` (kanban expect) — an event to wait for rather than a
        // decision to make, so it does not set needs_input.
        kind: str(req.body.kind) as InputKind | undefined,
      }),
    ),
  ));
  app.post('/api/input-requests/:qid/answer', wrap((req, res) =>
    res.json(repo.answer(req.params.qid, req.body.answer, req.body.answered_by ?? 'user', str(req.body.note))),
  ));
  app.post('/api/input-requests/:qid/cancel', wrap((req, res) =>
    res.json(repo.cancel(req.params.qid, actor(req))),
  ));
  // Long-poll await — checks committed state BEFORE parking (no lost wakeup).
  // Resolves on any terminal transition (answered / cancelled / expired) so a
  // waiter never hangs on a question that was withdrawn or timed out.
  app.get(
    '/api/input-requests/:qid/await',
    wrap(async (req, res) => {
      const qid = req.params.qid;
      const existing = repo.getRequest(qid);
      if (!existing) return res.status(404).json(errBody('not_found', 'no such request'));
      if (existing.status !== 'open')
        return res.json({
          status: existing.status,
          answer: existing.answer,
          ...(existing.answered_by === 'system:default' ? { defaulted: true } : {}),
        });
      const timeoutMs = (num(req.query.timeout) ?? 60) * 1000;
      const ev = await repo.bus.waitFor(
        (e) => INPUT_RESOLVED.has(e.type) && (e.payload as any).request_id === qid,
        timeoutMs,
      );
      if (!ev) return res.status(204).end(); // pending -> CLI exit 2
      res.json({
        status: ev.type.slice('input.'.length),
        answer: (ev.payload as any).answer,
        ...((ev.payload as any).defaulted ? { defaulted: true } : {}),
      });
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
            INPUT_RESOLVED.has(e.type) && (any || e.task_id === task);
          const onEvent = (e: any) => {
            if (!inScope(e)) return;
            cleanup();
            res.json({
              status: e.type.slice('input.'.length),
              request_id: e.payload.request_id,
              answer: e.payload.answer,
              ...(e.payload.defaulted ? { defaulted: true } : {}),
            });
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

  // --- compaction -------------------------------------------------------
  // Bound event-log growth on demand. `keep` defaults to the server's retention.
  app.post('/api/compact', (req, res) => res.json(repo.compact(num(req.body?.keep) ?? eventRetention())));

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
    // A cursor below the compaction floor can't replay gap-free — tell the client
    // to reseed from current state before we replay the retained tail.
    if (repo.isStale(since)) ws.send(JSON.stringify({ type: 'reset', floor: repo.floor(), cursor: repo.maxSeq() }));
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

  // Auto-archive policy: config read at call time (env override first, then
  // board.json) so `kanban board autoarchive` applies at the next sweep with
  // no server restart. Inert when unset/0.
  const autoArchiveDays = (): number => {
    const env = process.env.KANBAN_AUTO_ARCHIVE_DAYS;
    const v = env !== undefined ? Number(env) : readBoardMeta(paths).auto_archive_days ?? 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const autoArchive = () => {
    const days = autoArchiveDays();
    if (days > 0) repo.archiveDoneOlderThan(days);
  };

  // Auto-compaction: a low-frequency sweep bounds event-log growth without a
  // COUNT on every mutation. Inert when retention is 0 (docs/11-roadmap §2).
  // The auto-archive policy rides the same timer (+ one pass at startup, so
  // short-lived servers still apply it).
  const compactTimer = setInterval(() => {
    const keep = eventRetention();
    if (keep > 0 && repo.eventCount() > keep) repo.compact(keep);
    autoArchive();
  }, 5 * 60 * 1000);
  compactTimer.unref?.(); // don't keep the process (or tests) alive
  autoArchive();

  // Input-request expiry + stale-claim leases: one low-frequency sweep resolves
  // past-due questions (`input.expired`) and releases past-due claim leases
  // (`task.released` with `expired:true`). Cheap + inert when nothing carries a
  // TTL; mirrors the compaction sweep above.
  const expireTimer = setInterval(() => {
    repo.expireDue();
    repo.releaseExpiredClaims();
  }, EXPIRY_SWEEP_MS);
  expireTimer.unref?.();

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as any).port as number;
  fs.writeFileSync(paths.port, String(port));
  fs.writeFileSync(paths.pid, String(process.pid));

  const close = () =>
    new Promise<void>((resolve) => {
      clearInterval(compactTimer);
      clearInterval(expireTimer);
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
