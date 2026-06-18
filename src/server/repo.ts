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

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

interface NewTaskInput {
  title: string;
  description?: string;
  summary?: string;
  status?: WorkflowStatus;
  priority?: Priority;
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

  getComments(taskId: string, limit?: number): Comment[] {
    let sql = 'SELECT * FROM comment WHERE task_id = ? ORDER BY created_at DESC';
    if (limit && limit > 0) sql += ` LIMIT ${limit | 0}`;
    return this.db.prepare(sql).all(taskId) as Comment[];
  }

  countComments(taskId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) n FROM comment WHERE task_id = ?').get(taskId) as {
        n: number;
      }
    ).n;
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

  maxSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM event').get() as { s: number };
    return r.s;
  }

  changes(sinceSeq: number): BoardEvent[] {
    return (
      this.db.prepare('SELECT * FROM event WHERE seq > ? ORDER BY seq ASC').all(sinceSeq) as any[]
    ).map(this.mapEvent);
  }

  /** Scoped delta: events touching the task or its direct deps. */
  watch(taskId: string, sinceSeq: number): BoardEvent[] {
    const related = new Set<string>([taskId]);
    for (const t of this.getBlockers(taskId)) related.add(t.id);
    for (const t of this.getBlockedBy(taskId)) related.add(t.id);
    return this.changes(sinceSeq).filter((e) => e.task_id !== null && related.has(e.task_id));
  }

  /** Inbox: open requests + requests answered after the given event cursor. */
  inbox(sinceSeq = 0): { open: InputRequest[]; answered: InputRequest[]; cursor: number } {
    const open = this.getOpenRequests();
    const answeredEvents = this.changes(sinceSeq).filter((e) => e.type === 'input.answered');
    const answered = answeredEvents
      .map((e) => this.getRequest(String((e.payload as any).request_id)))
      .filter((r): r is InputRequest => !!r);
    return { open, answered, cursor: this.maxSeq() };
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
      const id = nextTaskId(this.db);
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO task(id,title,description,summary,summary_source,summary_updated_at,
            description_updated_at,status,priority,version,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`,
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
          ts,
          ts,
        );
      rec({ type: 'task.created', task_id: id, actor_type: actor, payload: { title: input.title } });

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
}
