import type { DB } from './db';
import { Bus } from './bus';
import {
  nextArtifactId,
  nextCommentId,
  nextCriterionId,
  nextRequestId,
  nextSeq,
  nextTaskId,
} from './ids';
import type {
  AcceptanceCriterion,
  Artifact,
  ActorType,
  BoardEvent,
  Comment,
  Dependency,
  EventType,
  InputRequest,
  Priority,
  Task,
  WorkflowStatus,
} from '../shared/types';

const now = () => new Date().toISOString();

/** Append a comment-author filter to a WHERE clause, pushing any bound param. */
function commentAuthorClause(author: ActorType | 'non-user' | undefined, params: any[]): string {
  if (!author) return '';
  if (author === 'non-user') return " AND author_type != 'user'";
  params.push(author);
  return ' AND author_type = ?';
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

interface NewTaskInput {
  title: string;
  description?: string;
  summary?: string;
  status?: WorkflowStatus;
  priority?: Priority;
  parent?: string;
  labels?: string[];
  depends?: string[];
  criteria?: string[];
  actor?: ActorType;
  actorName?: string;
}

export class Repo {
  /** Per-Repo event bus; consumed by the WS broadcaster and long-poll `await`. */
  readonly bus = new Bus();

  constructor(public readonly db: DB) {}

  // ---- row mappers -------------------------------------------------------

  private mapTask = (r: any): Task | undefined =>
    r && {
      ...r,
      version: Number(r.version),
      position: r.position === null ? null : Number(r.position),
    };

  // ---- reads -------------------------------------------------------------

  getTask(id: string): Task | undefined {
    return this.mapTask(this.db.prepare('SELECT * FROM task WHERE id = ?').get(id));
  }

  requireTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new NotFoundError(`task ${id} not found`);
    return t;
  }

  listTasks(opts: { status?: string; label?: string; limit?: number } = {}): Task[] {
    const where: string[] = ['archived_at IS NULL'];
    const params: any[] = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    let sql = `SELECT t.* FROM task t`;
    if (opts.label) {
      sql += ` JOIN task_label tl ON tl.task_id = t.id AND tl.label_name = ?`;
      params.unshift(opts.label);
    }
    sql += ` WHERE ${where.join(' AND ')} ORDER BY priority ASC, created_at ASC`;
    if (opts.limit && opts.limit > 0) sql += ` LIMIT ${opts.limit | 0}`;
    return (this.db.prepare(sql).all(...params) as any[]).map(this.mapTask) as Task[];
  }

  /** Every task incl. archived, oldest first — for analytics/export derivations. */
  allTasks(): Task[] {
    return (
      this.db.prepare('SELECT * FROM task ORDER BY created_at ASC').all() as any[]
    ).map(this.mapTask) as Task[];
  }

  /**
   * Comments, newest first. `author` filters by source: a specific `ActorType`
   * (e.g. `'user'` for the human's directives), or `'non-user'` for agent/system
   * self-notes. The renderer uses this to keep user comments visible while
   * shedding agent notes under token budget (see render.ts).
   */
  getComments(taskId: string, limit?: number, author?: ActorType | 'non-user'): Comment[] {
    const params: any[] = [taskId];
    let sql = 'SELECT * FROM comment WHERE task_id = ?';
    sql += commentAuthorClause(author, params);
    sql += ' ORDER BY created_at DESC';
    if (limit && limit > 0) sql += ` LIMIT ${limit | 0}`;
    return this.db.prepare(sql).all(...params) as Comment[];
  }

  countComments(taskId: string, author?: ActorType | 'non-user'): number {
    const params: any[] = [taskId];
    let sql = 'SELECT COUNT(*) n FROM comment WHERE task_id = ?';
    sql += commentAuthorClause(author, params);
    return (this.db.prepare(sql).get(...params) as { n: number }).n;
  }

  getCriteria(taskId: string): AcceptanceCriterion[] {
    return (
      this.db
        .prepare('SELECT * FROM acceptance_criterion WHERE task_id = ? ORDER BY position ASC')
        .all(taskId) as any[]
    ).map((r) => ({ ...r, checked: !!r.checked }));
  }

  getArtifacts(taskId: string): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifact WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Artifact[];
  }

  getLabels(taskId: string): string[] {
    return (
      this.db.prepare('SELECT label_name FROM task_label WHERE task_id = ?').all(taskId) as {
        label_name: string;
      }[]
    ).map((r) => r.label_name);
  }

  getOpenRequests(taskId?: string): InputRequest[] {
    const rows = taskId
      ? this.db
          .prepare(`SELECT * FROM input_request WHERE task_id = ? AND status = 'open'`)
          .all(taskId)
      : this.db.prepare(`SELECT * FROM input_request WHERE status = 'open'`).all();
    return (rows as any[]).map(this.mapRequest);
  }

  getRequest(id: string): InputRequest | undefined {
    const r = this.db.prepare('SELECT * FROM input_request WHERE id = ?').get(id);
    return r ? this.mapRequest(r) : undefined;
  }

  private mapRequest = (r: any): InputRequest => ({
    ...r,
    options: r.options ? JSON.parse(r.options) : null,
    answer_freeform: !!r.answer_freeform,
  });

  /** Direct blockers (tasks this one depends on). */
  getBlockers(taskId: string): Task[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM dependency d JOIN task t ON t.id = d.to_task
            WHERE d.from_task = ? AND d.type = 'blocks'`,
        )
        .all(taskId) as any[]
    ).map(this.mapTask) as Task[];
  }

  /** Tasks that depend on this one. */
  getBlockedBy(taskId: string): Task[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM dependency d JOIN task t ON t.id = d.from_task
            WHERE d.to_task = ? AND d.type = 'blocks'`,
        )
        .all(taskId) as any[]
    ).map(this.mapTask) as Task[];
  }

  /** Direct, non-archived children of a parent task (subtasks), oldest first. */
  getChildren(parentId: string): Task[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM task WHERE parent_id = ? AND archived_at IS NULL
            ORDER BY created_at ASC`,
        )
        .all(parentId) as any[]
    ).map(this.mapTask) as Task[];
  }

  /** The parent task, if this is a subtask. */
  getParent(taskId: string): Task | undefined {
    const t = this.getTask(taskId);
    return t?.parent_id ? this.getTask(t.parent_id) : undefined;
  }

  /** Count of non-archived children (any status). */
  childCount(parentId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) n FROM task WHERE parent_id = ? AND archived_at IS NULL')
        .get(parentId) as { n: number }
    ).n;
  }

  /** Count of non-archived children that are not yet Done. */
  openChildCount(parentId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) n FROM task
            WHERE parent_id = ? AND archived_at IS NULL AND status != 'Done'`,
        )
        .get(parentId) as { n: number }
    ).n;
  }

  maxSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM event').get() as { s: number };
    return r.s;
  }

  changes(sinceSeq: number): BoardEvent[] {
    return (
      this.db.prepare('SELECT * FROM event WHERE seq > ? ORDER BY seq ASC').all(sinceSeq) as any[]
    ).map(this.mapEvent);
  }

  /** Highest `seq` deleted by compaction; `0` means nothing has been compacted. */
  floor(): number {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'compaction_floor'").get() as
      | { value: string }
      | undefined;
    return r ? Number(r.value) : 0;
  }

  /**
   * A delta cursor predating the compaction floor cannot receive a gap-free delta —
   * the events between it and the floor are gone. Such a consumer must reseed from
   * current state (the never-silent reset signal). `since === 0` is a full replay
   * request and never stale.
   */
  isStale(since: number): boolean {
    return since > 0 && since < this.floor();
  }

  eventCount(): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM event').get() as { n: number }).n;
  }

  /**
   * Bound event-log growth: retain the most recent `keep` events, delete the rest,
   * and advance the persisted compaction floor. State is never rebuilt from events
   * (the server is model-free — see derive.ts), so this loses only delta-replay
   * history below the floor; consumers whose cursor predates it reseed via the
   * reset signal. Always retains >=1 event so `MAX(event.seq)` stays equal to the
   * `seq` counter and existing `maxSeq()` cursors are unaffected. Runs in its own
   * transaction and emits no domain event (compaction is meta, not a board
   * mutation). See docs/11-roadmap.md §2 and docs/02-data-model.md.
   */
  compact(keep: number): { floor: number; removed: number } {
    const k = Math.max(1, Math.floor(keep));
    // The (k+1)-th newest event: everything at or below its seq is deleted, leaving
    // exactly the k newest. Undefined when there are <= k events -> nothing to do.
    const cutoff = this.db
      .prepare('SELECT seq FROM event ORDER BY seq DESC LIMIT 1 OFFSET ?')
      .get(k) as { seq: number } | undefined;
    if (!cutoff) return { floor: this.floor(), removed: 0 };
    const newFloor = Math.max(this.floor(), cutoff.seq);
    const tx = this.db.transaction(() => {
      const info = this.db.prepare('DELETE FROM event WHERE seq <= ?').run(newFloor);
      this.db
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('compaction_floor', ?)")
        .run(String(newFloor));
      return info.changes as number;
    });
    return { floor: newFloor, removed: tx() };
  }

  /** Scoped delta: events touching the task or its direct deps. */
  watch(taskId: string, sinceSeq: number): BoardEvent[] {
    const related = new Set<string>([taskId]);
    for (const t of this.getBlockers(taskId)) related.add(t.id);
    for (const t of this.getBlockedBy(taskId)) related.add(t.id);
    return this.changes(sinceSeq).filter((e) => e.task_id !== null && related.has(e.task_id));
  }

  /**
   * Inbox: open requests, plus requests answered or otherwise resolved
   * (cancelled / expired) after the given event cursor. The `resolved` bucket
   * keeps a vanished question never-silent for a resuming agent — it sees the
   * cancellation/expiry instead of the request simply dropping out of `open`.
   */
  inbox(sinceSeq = 0): {
    open: InputRequest[];
    answered: InputRequest[];
    resolved: InputRequest[];
    cursor: number;
  } {
    const open = this.getOpenRequests();
    const since = this.changes(sinceSeq);
    const requestsOfType = (type: EventType) =>
      since
        .filter((e) => e.type === type)
        .map((e) => this.getRequest(String((e.payload as any).request_id)))
        .filter((r): r is InputRequest => !!r);
    const answered = requestsOfType('input.answered');
    const resolved = [...requestsOfType('input.cancelled'), ...requestsOfType('input.expired')];
    return { open, answered, resolved, cursor: this.maxSeq() };
  }

  /** All input requests, any status (for export). */
  getAllRequests(): InputRequest[] {
    return (
      this.db.prepare('SELECT * FROM input_request ORDER BY created_at ASC').all() as any[]
    ).map(this.mapRequest);
  }

  /** Raw dependency edges (from_task blocks -> to_task), for export. */
  getDependencies(): Dependency[] {
    return this.db.prepare('SELECT * FROM dependency').all() as Dependency[];
  }

  /**
   * Full board snapshot for `kanban export` — every task (incl. archived) with its
   * nested children, the dependency edges, all input requests, and the event log.
   * The caller stamps `format_version` (docs/05-cli-reference.md §export).
   */
  snapshot(): Record<string, unknown> {
    const allTasks = (
      this.db.prepare('SELECT * FROM task ORDER BY created_at ASC').all() as any[]
    ).map(this.mapTask) as Task[];
    const tasks = allTasks.map((t) => ({
      ...t,
      labels: this.getLabels(t.id),
      criteria: this.getCriteria(t.id),
      comments: this.getComments(t.id),
      artifacts: this.getArtifacts(t.id),
    }));
    return {
      exported_at: now(),
      seq: this.maxSeq(),
      // Full state (all tables above) is always complete; the event tail may be
      // bounded by compaction. `compaction_floor` makes that never-silent — events
      // at or below it are gone (docs/11-roadmap.md §2).
      compaction_floor: this.floor(),
      tasks,
      dependencies: this.getDependencies(),
      input_requests: this.getAllRequests(),
      events: this.changes(0),
    };
  }

  private mapEvent = (r: any): BoardEvent => ({ ...r, payload: JSON.parse(r.payload) });

  // ---- mutation plumbing -------------------------------------------------

  /**
   * Run `fn` in a single write transaction. `fn` records events via the supplied
   * recorder; after commit those events are published to the bus (WS + waiters).
   * This guarantees event order == commit order (docs/09-concurrency.md).
   */
  private mutate<T>(fn: (rec: (e: Omit<BoardEvent, 'seq' | 'ts'>) => void) => T): T {
    const collected: BoardEvent[] = [];
    const tx = this.db.transaction(() => {
      const rec = (e: Omit<BoardEvent, 'seq' | 'ts'>) => {
        const seq = nextSeq(this.db);
        const ts = now();
        this.db
          .prepare('INSERT INTO event(seq, ts, type, task_id, actor_type, payload) VALUES(?,?,?,?,?,?)')
          .run(seq, ts, e.type, e.task_id, e.actor_type, JSON.stringify(e.payload));
        collected.push({ seq, ts, ...e });
      };
      return fn(rec);
    });
    const result = tx();
    this.bus.publish(collected);
    return result;
  }

  // ---- mutations ---------------------------------------------------------

  createTask(input: NewTaskInput): Task {
    const actor = input.actor ?? 'agent';
    return this.mutate((rec) => {
      const parentId = input.parent ?? null;
      if (parentId !== null) {
        const parent = this.requireTask(parentId);
        if (parent.archived_at !== null)
          throw new ValidationError(`cannot parent under an archived task (${parentId})`);
      }
      const id = nextTaskId(this.db);
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO task(id,title,description,summary,summary_source,summary_updated_at,
            description_updated_at,status,priority,parent_id,version,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          id,
          input.title,
          input.description ?? null,
          input.summary ?? null,
          input.summary ? actor : null,
          input.summary ? ts : null,
          input.description ? ts : null,
          input.status ?? 'Backlog',
          input.priority ?? 'P2',
          parentId,
          ts,
          ts,
        );
      rec({
        type: 'task.created',
        task_id: id,
        actor_type: actor,
        payload: { title: input.title, ...(parentId ? { parent_id: parentId } : {}) },
      });

      for (const name of input.labels ?? []) this.addLabelTx(rec, id, name, actor);
      for (const dep of input.depends ?? []) this.addDepTx(rec, id, dep, actor);
      for (const text of input.criteria ?? []) this.addCriterionTx(rec, id, text, actor);

      return this.requireTask(id);
    });
  }

  updateTask(
    id: string,
    fields: Partial<Pick<Task, 'title' | 'description' | 'summary' | 'priority'>>,
    opts: { expectVersion?: number; actor?: ActorType } = {},
  ): Task {
    const actor = opts.actor ?? 'agent';
    return this.mutate((rec) => {
      const t = this.requireTask(id);
      if (opts.expectVersion !== undefined && opts.expectVersion !== t.version) {
        throw new ConflictError(`stale version: expected ${opts.expectVersion}, have ${t.version}`);
      }
      const ts = now();
      const sets: string[] = ['version = version + 1', 'updated_at = @ts'];
      const params: any = { id, ts };
      if (fields.title !== undefined) (sets.push('title = @title'), (params.title = fields.title));
      if (fields.description !== undefined) {
        sets.push('description = @description', 'description_updated_at = @ts');
        params.description = fields.description;
      }
      if (fields.summary !== undefined) {
        sets.push('summary = @summary', 'summary_source = @actor', 'summary_updated_at = @ts');
        params.summary = fields.summary;
        params.actor = actor;
      }
      if (fields.priority !== undefined)
        (sets.push('priority = @priority'), (params.priority = fields.priority));
      this.db.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = @id`).run(params);
      rec({ type: 'task.updated', task_id: id, actor_type: actor, payload: { fields: Object.keys(fields) } });
      return this.requireTask(id);
    });
  }

  /** Set the workflow status (the UI "Blocked" column is derived, never set here). */
  moveTask(id: string, status: WorkflowStatus, actor: ActorType = 'agent'): Task {
    return this.mutate((rec) => {
      const t = this.requireTask(id);
      if (status === 'Done') {
        const open = this.openChildCount(id);
        if (open > 0)
          throw new ValidationError(`cannot complete ${id}: ${open} open subtask(s) remain`);
      }
      this.db
        .prepare('UPDATE task SET status = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(status, now(), id);
      rec({
        type: 'task.moved',
        task_id: id,
        actor_type: actor,
        payload: { from: t.status, to: status },
      });
      return this.requireTask(id);
    });
  }

  /**
   * Atomically claim a task for an agent (multi-agent coordination, docs/09 §9).
   * The check-and-set runs inside `mutate()`'s single write transaction, so two
   * agents racing to claim the same task are serialized — exactly one wins.
   * Idempotent when already held by the same agent; `force` steals another's claim.
   */
  claimTask(
    id: string,
    agent: string,
    opts: { force?: boolean; actor?: ActorType } = {},
  ): Task {
    const actor = opts.actor ?? 'agent';
    return this.mutate((rec) => {
      const t = this.requireTask(id);
      if (t.archived_at !== null) throw new ValidationError(`cannot claim an archived task (${id})`);
      if (t.status === 'Done') throw new ValidationError(`cannot claim a Done task (${id})`);
      if (t.assignee === agent) return t; // idempotent: already mine, no event
      if (t.assignee && t.assignee !== agent && !opts.force) {
        throw new ConflictError(`${id} already claimed by ${t.assignee}`);
      }
      const stolenFrom = t.assignee && t.assignee !== agent ? t.assignee : undefined;
      this.db
        .prepare('UPDATE task SET assignee = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(agent, now(), id);
      rec({
        type: 'task.claimed',
        task_id: id,
        actor_type: actor,
        payload: { assignee: agent, ...(stolenFrom ? { stolen_from: stolenFrom } : {}) },
      });
      return this.requireTask(id);
    });
  }

  /**
   * Release a claim. Idempotent when already unassigned (safe to call in cleanup
   * / yield paths). Only the owner may release unless `force` is set.
   */
  releaseTask(
    id: string,
    agent: string,
    opts: { force?: boolean; actor?: ActorType } = {},
  ): Task {
    const actor = opts.actor ?? 'agent';
    return this.mutate((rec) => {
      const t = this.requireTask(id);
      if (t.assignee === null) return t; // idempotent: nothing to release, no event
      if (t.assignee !== agent && !opts.force) {
        throw new ConflictError(`${id} claimed by ${t.assignee}, not you (use --force)`);
      }
      this.db
        .prepare('UPDATE task SET assignee = NULL, version = version + 1, updated_at = ? WHERE id = ?')
        .run(now(), id);
      rec({
        type: 'task.released',
        task_id: id,
        actor_type: actor,
        payload: { released_from: t.assignee },
      });
      return this.requireTask(id);
    });
  }

  archiveTask(id: string, actor: ActorType = 'agent'): void {
    this.mutate((rec) => {
      this.requireTask(id);
      const open = this.childCount(id);
      if (open > 0)
        throw new ValidationError(
          `cannot archive ${id}: ${open} subtask(s) still attached — archive or reparent them first`,
        );
      this.db.prepare('UPDATE task SET archived_at = ? WHERE id = ?').run(now(), id);
      rec({ type: 'task.archived', task_id: id, actor_type: actor, payload: {} });
    });
  }

  // dependencies ----------------------------------------------------------

  private reachable(start: string, target: string): boolean {
    // Follow `from -> to` (dependency) edges from `start`; can we reach `target`?
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const tos = this.db
        .prepare(`SELECT to_task FROM dependency WHERE from_task = ? AND type = 'blocks'`)
        .all(cur) as { to_task: string }[];
      for (const r of tos) stack.push(r.to_task);
    }
    return false;
  }

  private addDepTx(rec: any, from: string, to: string, actor: ActorType) {
    if (from === to) throw new ValidationError('a task cannot depend on itself');
    this.requireTask(from);
    this.requireTask(to);
    const dup = this.db
      .prepare(`SELECT 1 FROM dependency WHERE from_task=? AND to_task=? AND type='blocks'`)
      .get(from, to);
    if (dup) throw new ValidationError(`dependency ${from} -> ${to} already exists`);
    // Adding from->to closes a cycle if `to` already reaches `from`.
    if (this.reachable(to, from)) throw new ValidationError('dependency would create a cycle');
    this.db
      .prepare(`INSERT INTO dependency(from_task,to_task,type) VALUES(?,?,'blocks')`)
      .run(from, to);
    rec({ type: 'dep.added', task_id: from, actor_type: actor, payload: { to } });
  }

  addDep(from: string, to: string, actor: ActorType = 'agent'): void {
    this.mutate((rec) => this.addDepTx(rec, from, to, actor));
  }

  removeDep(from: string, to: string, actor: ActorType = 'agent'): void {
    this.mutate((rec) => {
      this.db
        .prepare(`DELETE FROM dependency WHERE from_task=? AND to_task=? AND type='blocks'`)
        .run(from, to);
      rec({ type: 'dep.removed', task_id: from, actor_type: actor, payload: { to } });
    });
  }

  // subtasks (parent/child tree) -----------------------------------------

  /** Walk `parent_id` edges upward from `start`; can we reach `target`? */
  private reachableParent(start: string, target: string): boolean {
    let cur: string | null = start;
    const seen = new Set<string>();
    while (cur) {
      if (cur === target) return true;
      if (seen.has(cur)) break; // defensive: never loop on pre-existing corruption
      seen.add(cur);
      const row = this.db.prepare('SELECT parent_id FROM task WHERE id = ?').get(cur) as
        | { parent_id: string | null }
        | undefined;
      cur = row?.parent_id ?? null;
    }
    return false;
  }

  /**
   * Set (or clear, with `null`) a task's parent. Single-parent tree, distinct from
   * the `dependency` DAG. Rejects self-parenting and any move that would make a
   * task a descendant of itself (cycle guard mirrors `reachable()` for deps).
   */
  setParent(id: string, parentId: string | null, actor: ActorType = 'agent'): Task {
    return this.mutate((rec) => {
      const t = this.requireTask(id);
      const from = t.parent_id;
      if (parentId !== null) {
        if (parentId === id) throw new ValidationError('a task cannot be its own parent');
        if (t.archived_at !== null) throw new ValidationError(`cannot reparent an archived task (${id})`);
        const parent = this.requireTask(parentId);
        if (parent.archived_at !== null)
          throw new ValidationError(`cannot parent under an archived task (${parentId})`);
        // A cycle forms iff `parentId` is `id` or one of its descendants — i.e.
        // walking up from `parentId` reaches `id`.
        if (this.reachableParent(parentId, id))
          throw new ValidationError('reparent would create a cycle');
      }
      if (from === parentId) return t; // no-op: no event
      this.db
        .prepare('UPDATE task SET parent_id = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(parentId, now(), id);
      rec({ type: 'task.reparented', task_id: id, actor_type: actor, payload: { from, to: parentId } });
      return this.requireTask(id);
    });
  }

  // comments / criteria / artifacts / labels ------------------------------

  addComment(taskId: string, body: string, author_type: ActorType, author_name: string): Comment {
    return this.mutate((rec) => {
      this.requireTask(taskId);
      const id = nextCommentId(this.db);
      const ts = now();
      this.db
        .prepare('INSERT INTO comment(id,task_id,body,author_type,author_name,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, taskId, body, author_type, author_name, ts);
      rec({ type: 'comment.added', task_id: taskId, actor_type: author_type, payload: { id } });
      return { id, task_id: taskId, body, author_type, author_name, created_at: ts };
    });
  }

  private addCriterionTx(rec: any, taskId: string, text: string, actor: ActorType): string {
    const id = nextCriterionId(this.db);
    const pos =
      (
        this.db
          .prepare('SELECT COALESCE(MAX(position),0) p FROM acceptance_criterion WHERE task_id=?')
          .get(taskId) as { p: number }
      ).p + 1;
    this.db
      .prepare('INSERT INTO acceptance_criterion(id,task_id,text,checked,position) VALUES(?,?,?,0,?)')
      .run(id, taskId, text, pos);
    rec({ type: 'criterion.added', task_id: taskId, actor_type: actor, payload: { id } });
    return id;
  }

  addCriterion(taskId: string, text: string, actor: ActorType = 'agent'): string {
    return this.mutate((rec) => {
      this.requireTask(taskId);
      return this.addCriterionTx(rec, taskId, text, actor);
    });
  }

  checkCriterion(acId: string, checked: boolean, actor: ActorType = 'agent'): void {
    this.mutate((rec) => {
      const c = this.db.prepare('SELECT * FROM acceptance_criterion WHERE id=?').get(acId) as any;
      if (!c) throw new NotFoundError(`criterion ${acId} not found`);
      this.db
        .prepare('UPDATE acceptance_criterion SET checked=?, checked_at=? WHERE id=?')
        .run(checked ? 1 : 0, checked ? now() : null, acId);
      rec({
        type: checked ? 'criterion.checked' : 'criterion.unchecked',
        task_id: c.task_id,
        actor_type: actor,
        payload: { id: acId },
      });
    });
  }

  addArtifact(
    taskId: string,
    kind: Artifact['kind'],
    title: string,
    uri: string,
    actor: ActorType = 'agent',
  ): Artifact {
    return this.mutate((rec) => {
      this.requireTask(taskId);
      const id = nextArtifactId(this.db);
      const ts = now();
      this.db
        .prepare('INSERT INTO artifact(id,task_id,kind,title,uri,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, taskId, kind, title, uri, ts);
      rec({ type: 'artifact.added', task_id: taskId, actor_type: actor, payload: { id, kind } });
      return { id, task_id: taskId, kind, title, uri, created_at: ts };
    });
  }

  private addLabelTx(rec: any, taskId: string, name: string, actor: ActorType) {
    this.db.prepare('INSERT OR IGNORE INTO label(name) VALUES(?)').run(name);
    this.db
      .prepare('INSERT OR IGNORE INTO task_label(task_id,label_name) VALUES(?,?)')
      .run(taskId, name);
    rec({ type: 'label.added', task_id: taskId, actor_type: actor, payload: { name } });
  }

  addLabel(taskId: string, name: string, actor: ActorType = 'agent'): void {
    this.mutate((rec) => {
      this.requireTask(taskId);
      this.addLabelTx(rec, taskId, name, actor);
    });
  }

  removeLabel(taskId: string, name: string, actor: ActorType = 'agent'): void {
    this.mutate((rec) => {
      this.db.prepare('DELETE FROM task_label WHERE task_id=? AND label_name=?').run(taskId, name);
      rec({ type: 'label.removed', task_id: taskId, actor_type: actor, payload: { name } });
    });
  }

  // human-in-the-loop -----------------------------------------------------

  ask(
    taskId: string,
    question: string,
    opts: { options?: string[]; freeform?: boolean; expiresAt?: string; actor?: ActorType } = {},
  ): InputRequest {
    const actor = opts.actor ?? 'agent';
    return this.mutate((rec) => {
      this.requireTask(taskId);
      const id = nextRequestId(this.db);
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO input_request(id,task_id,question,options,answer_freeform,status,created_at,expires_at)
           VALUES(?,?,?,?,?, 'open', ?, ?)`,
        )
        .run(
          id,
          taskId,
          question,
          opts.options ? JSON.stringify(opts.options) : null,
          opts.freeform ? 1 : 0,
          ts,
          opts.expiresAt ?? null,
        );
      rec({ type: 'input.requested', task_id: taskId, actor_type: actor, payload: { request_id: id, question } });
      return this.getRequest(id)!;
    });
  }

  answer(requestId: string, answer: string, answeredBy: string): InputRequest {
    return this.mutate((rec) => {
      const r = this.getRequest(requestId);
      if (!r) throw new NotFoundError(`request ${requestId} not found`);
      if (r.status !== 'open') throw new ValidationError(`request ${requestId} is ${r.status}`);
      if (r.options && !r.answer_freeform && !r.options.includes(answer)) {
        throw new ValidationError(`answer must be one of: ${r.options.join(', ')}`);
      }
      this.db
        .prepare(`UPDATE input_request SET status='answered', answer=?, answered_by=?, answered_at=? WHERE id=?`)
        .run(answer, answeredBy, now(), requestId);
      rec({
        type: 'input.answered',
        task_id: r.task_id,
        actor_type: 'user',
        payload: { request_id: requestId, answer },
      });
      return this.getRequest(requestId)!;
    });
  }

  /**
   * Withdraw an open question the agent no longer needs. Mirrors `answer` but
   * resolves to `cancelled` with no answer; only an `open` request can be
   * cancelled. Clears the task's derived `needs_input` (derive.ts keys off
   * `status='open'`), and fires the previously-dead `input.cancelled` event.
   */
  cancel(requestId: string, actor: ActorType = 'agent'): InputRequest {
    return this.mutate((rec) => {
      const r = this.getRequest(requestId);
      if (!r) throw new NotFoundError(`request ${requestId} not found`);
      if (r.status !== 'open') throw new ValidationError(`request ${requestId} is ${r.status}`);
      this.db
        .prepare(`UPDATE input_request SET status='cancelled', answered_at=? WHERE id=?`)
        .run(now(), requestId);
      rec({ type: 'input.cancelled', task_id: r.task_id, actor_type: actor, payload: { request_id: requestId } });
      return this.getRequest(requestId)!;
    });
  }

  /**
   * Resolve every open request whose `expires_at` has passed: mark it `expired`
   * and fire `input.expired`. The `rec` collector batches all of them into one
   * transaction + one broadcast. `nowTs` is injectable so tests drive expiry
   * deterministically. Called by the server's low-frequency sweep (server.ts);
   * inert when no open request carries an `expires_at`.
   */
  expireDue(nowTs: string = now()): { expired: number } {
    return this.mutate((rec) => {
      const due = this.db
        .prepare(
          `SELECT * FROM input_request WHERE status='open' AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .all(nowTs)
        .map(this.mapRequest);
      const upd = this.db.prepare(`UPDATE input_request SET status='expired', answered_at=? WHERE id=?`);
      for (const r of due) {
        upd.run(nowTs, r.id);
        rec({ type: 'input.expired', task_id: r.task_id, actor_type: 'system', payload: { request_id: r.id } });
      }
      return { expired: due.length };
    });
  }
}
