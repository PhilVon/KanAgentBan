import type { DB } from './db';
import { Bus } from './bus';
import {
  nextArtifactId,
  nextBrainstormId,
  nextCommentId,
  nextCriterionId,
  nextDocId,
  nextIdeaId,
  nextRequestId,
  nextSeq,
  nextTaskId,
} from './ids';
import { DOC_KINDS, DOC_STATUSES, WORKFLOW_STATUSES } from '../shared/types';
import type {
  AcceptanceCriterion,
  Artifact,
  ActorType,
  BoardEvent,
  BrainstormSession,
  Comment,
  Dependency,
  Doc,
  DocKind,
  DocStatus,
  EventType,
  Idea,
  InputRequest,
  Priority,
  SearchResult,
  Task,
  WorkflowStatus,
} from '../shared/types';

const now = () => new Date().toISOString();

/** Ceiling on a doc's markdown body. Docs deliberately store content on the
 *  board (ADR 0007) — the cap keeps a single doc from becoming a token bomb
 *  and stays well inside the server's 1 MB JSON body limit. */
export const MAX_DOC_BODY_BYTES = 64 * 1024;

/** Ceiling on a checkpoint. It is a resume *pointer* ("did X, next Y, watch Z"),
 *  not a progress log — real detail belongs in comments or docs. */
export const MAX_CHECKPOINT_CHARS = 1000;

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

/**
 * Guard against phantom columns. Only the five workflow statuses are settable;
 * "Blocked" is a *derived projection* (adr/0004, docs/04) and is intentionally
 * absent, so moving to it is rejected too. Without this, an arbitrary string
 * (e.g. "To Do") would be written verbatim and the card would vanish from the
 * web UI, which renders a fixed column set ([DISPLAY_COLUMNS]).
 */
function assertWritableStatus(status: string): asserts status is WorkflowStatus {
  if (!(WORKFLOW_STATUSES as readonly string[]).includes(status))
    throw new ValidationError(
      `invalid status "${status}"; valid columns are: ${WORKFLOW_STATUSES.join(', ')} ` +
        `(Blocked is derived, not settable)`,
    );
}

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

  /** Newest-first page of retained events for the activity log, optionally
   *  scoped to one task and/or to events older than a `before` seq (paging). */
  listEventsDesc(opts: { task?: string; before?: number; limit: number }): BoardEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.task) {
      clauses.push('task_id = ?');
      params.push(opts.task);
    }
    if (opts.before !== undefined) {
      clauses.push('seq < ?');
      params.push(opts.before);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts.limit);
    return (
      this.db.prepare(`SELECT * FROM event ${where} ORDER BY seq DESC LIMIT ?`).all(...params) as any[]
    ).map(this.mapEvent);
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
      docs: (this.db.prepare('SELECT * FROM doc ORDER BY created_at ASC').all() as Doc[]).map(
        (d) => ({ ...d, tasks: this.getDocTasks(d.id) }),
      ),
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
    if (input.status !== undefined) assertWritableStatus(input.status);
    return this.mutate((rec) => this.createTaskTx(rec, input, actor));
  }

  /** Task-creation body, shared with `promoteIdea` (which must create the task
   *  inside its own transaction — nesting `mutate()` would double-publish). */
  private createTaskTx(rec: any, input: NewTaskInput, actor: ActorType): Task {
    {
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
    }
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

  /**
   * Set (or clear, with `null`) a task's checkpoint — the one-slot resume
   * pointer for cross-session continuity. Latest wins; there is no history
   * (the event log keeps the trail). Clearing an already-clear checkpoint is
   * an idempotent no-op (no event).
   */
  setCheckpoint(
    id: string,
    text: string | null,
    opts: { actor?: ActorType; by?: string } = {},
  ): Task {
    const actor = opts.actor ?? 'agent';
    if (text !== null && !text.trim()) throw new ValidationError('checkpoint text cannot be empty (use clear)');
    if (text !== null && text.length > MAX_CHECKPOINT_CHARS)
      throw new ValidationError(
        `checkpoint too long (${text.length} > ${MAX_CHECKPOINT_CHARS} chars) — it is a resume pointer, not a log; put detail in a comment or doc`,
      );
    return this.mutate((rec) => {
      const t = this.requireTask(id);
      if (text === null && t.checkpoint === null) return t; // idempotent: nothing to clear
      const ts = now();
      this.db
        .prepare(
          `UPDATE task SET checkpoint = ?, checkpoint_at = ?, checkpoint_by = ?,
             version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(text, text === null ? null : ts, text === null ? null : (opts.by ?? 'agent'), ts, id);
      rec({
        type: 'task.checkpointed',
        task_id: id,
        actor_type: actor,
        payload: text === null ? { cleared: true } : { text },
      });
      return this.requireTask(id);
    });
  }

  /** Set the workflow status (the UI "Blocked" column is derived, never set here). */
  moveTask(id: string, status: WorkflowStatus, actor: ActorType = 'agent'): Task {
    assertWritableStatus(status);
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
   *
   * With `ttlSeconds` the claim is a *lease*: past-due it is auto-released by the
   * server sweep ([releaseExpiredClaims]) and may be taken over by any agent
   * without `force`. Re-claiming your own task refreshes (or, without a ttl,
   * clears) the lease in place — a heartbeat, not an event.
   */
  claimTask(
    id: string,
    agent: string,
    opts: { force?: boolean; actor?: ActorType; ttlSeconds?: number } = {},
  ): Task {
    const actor = opts.actor ?? 'agent';
    if (opts.ttlSeconds !== undefined && (!Number.isFinite(opts.ttlSeconds) || opts.ttlSeconds <= 0))
      throw new ValidationError('claim ttl must be a positive number of seconds');
    return this.mutate((rec) => {
      const t = this.requireTask(id);
      if (t.archived_at !== null) throw new ValidationError(`cannot claim an archived task (${id})`);
      if (t.status === 'Done') throw new ValidationError(`cannot claim a Done task (${id})`);
      const ts = now();
      const expiresAt =
        opts.ttlSeconds !== undefined
          ? new Date(Date.now() + opts.ttlSeconds * 1000).toISOString()
          : null;
      if (t.assignee === agent) {
        if (t.claim_expires_at === expiresAt) return t; // idempotent: already mine, no event
        // Heartbeat: refresh (ttl) or clear (no ttl) my own lease — no event spam.
        this.db
          .prepare('UPDATE task SET claim_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ?')
          .run(expiresAt, ts, id);
        return this.requireTask(id);
      }
      const leaseExpired = !!t.assignee && t.claim_expires_at !== null && t.claim_expires_at <= ts;
      if (t.assignee && !opts.force && !leaseExpired) {
        throw new ConflictError(`${id} already claimed by ${t.assignee}`);
      }
      // A dead lease releases lazily at takeover (the sweep may not have run yet).
      if (t.assignee && leaseExpired)
        rec({
          type: 'task.released',
          task_id: id,
          actor_type: 'system',
          payload: { released_from: t.assignee, expired: true },
        });
      const stolenFrom = t.assignee && !leaseExpired ? t.assignee : undefined;
      this.db
        .prepare(
          'UPDATE task SET assignee = ?, claim_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ?',
        )
        .run(agent, expiresAt, ts, id);
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
   * The review gate: resolve a task sitting in `Review`. `approve` moves it to
   * Done, `reject` kicks it back to `In Progress` — via the same `task.moved`
   * event the rework/kickback stats already derive from, extended with
   * `{review: verdict, reason?}`. A reject **requires a reason** (a recorded
   * kickback is the point) and drops it on the task as a comment so the next
   * agent session sees *why* it bounced. Only a `Review` task can be reviewed;
   * approving a parent with open subtasks fails like any Done move.
   */
  reviewTask(
    id: string,
    verdict: 'approve' | 'reject',
    opts: { reason?: string; actor?: ActorType; by?: string } = {},
  ): Task {
    const actor = opts.actor ?? 'user';
    const reason = opts.reason?.trim();
    if (verdict !== 'approve' && verdict !== 'reject')
      throw new ValidationError(`review verdict must be approve or reject`);
    if (verdict === 'reject' && !reason)
      throw new ValidationError('review reject requires a reason (the kickback is recorded)');
    return this.mutate((rec) => {
      const t = this.requireTask(id);
      if (t.status !== 'Review')
        throw new ValidationError(`${id} is ${t.status}, not Review — the gate only applies there`);
      const to: WorkflowStatus = verdict === 'approve' ? 'Done' : 'In Progress';
      const open = this.openChildCount(id);
      if (to === 'Done' && open > 0)
        throw new ValidationError(`cannot approve ${id}: ${open} open subtask(s) remain`);
      this.db
        .prepare('UPDATE task SET status = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(to, now(), id);
      rec({
        type: 'task.moved',
        task_id: id,
        actor_type: actor,
        payload: {
          from: 'Review',
          to,
          review: verdict === 'approve' ? 'approved' : 'rejected',
          ...(reason ? { reason } : {}),
        },
      });
      if (reason)
        this.addCommentTx(
          rec,
          id,
          `review ${verdict === 'approve' ? 'approved' : 'rejected'}: ${reason}`,
          actor,
          opts.by ?? 'review',
        );
      return this.requireTask(id);
    });
  }

  /**
   * Sweep: release every claim whose lease is past due (`task.released` with
   * `expired: true`, actor `system`) so a dead agent never wedges a task.
   * Called on the server's low-frequency sweep timer; cheap when nothing leases.
   */
  releaseExpiredClaims(nowTs: string = now()): { released: number } {
    const due = this.db
      .prepare(
        `SELECT id, assignee FROM task
          WHERE assignee IS NOT NULL AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ? AND archived_at IS NULL`,
      )
      .all(nowTs) as { id: string; assignee: string }[];
    if (!due.length) return { released: 0 };
    return this.mutate((rec) => {
      for (const row of due) {
        this.db
          .prepare(
            'UPDATE task SET assignee = NULL, claim_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ?',
          )
          .run(now(), row.id);
        rec({
          type: 'task.released',
          task_id: row.id,
          actor_type: 'system',
          payload: { released_from: row.assignee, expired: true },
        });
      }
      return { released: due.length };
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
        .prepare(
          'UPDATE task SET assignee = NULL, claim_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ?',
        )
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

  /**
   * Bulk-archive every Done task in one transaction. Processed bottom-up
   * (fixpoint loop): a task is archived only once it has no live children, so a
   * fully-Done subtree collapses parent-and-all. A Done task still holding a
   * live child — e.g. a child moved back out of Done — is skipped, not errored
   * (mirrors `archiveTask`'s guard without throwing). Returns how many were
   * archived and the ids left behind.
   */
  archiveDoneTasks(actor: ActorType = 'agent'): { archived: number; skipped: string[] } {
    return this.mutate((rec) => {
      const remaining = new Set(
        (
          this.db
            .prepare(`SELECT id FROM task WHERE status = 'Done' AND archived_at IS NULL`)
            .all() as { id: string }[]
        ).map((r) => r.id),
      );
      let archived = 0;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const id of [...remaining]) {
          if (this.childCount(id) > 0) continue; // live children remain — revisit next pass
          this.db.prepare('UPDATE task SET archived_at = ? WHERE id = ?').run(now(), id);
          rec({ type: 'task.archived', task_id: id, actor_type: actor, payload: {} });
          remaining.delete(id);
          archived++;
          progressed = true;
        }
      }
      return { archived, skipped: [...remaining] };
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
    return this.mutate((rec) => this.addCommentTx(rec, taskId, body, author_type, author_name));
  }

  /** Comment body shared with `reviewTask` (which records the kickback reason
   *  inside its own transaction — nesting `mutate()` would double-publish). */
  private addCommentTx(
    rec: any,
    taskId: string,
    body: string,
    author_type: ActorType,
    author_name: string,
  ): Comment {
    this.requireTask(taskId);
    const id = nextCommentId(this.db);
    const ts = now();
    this.db
      .prepare('INSERT INTO comment(id,task_id,body,author_type,author_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, taskId, body, author_type, author_name, ts);
    rec({ type: 'comment.added', task_id: taskId, actor_type: author_type, payload: { id } });
    return { id, task_id: taskId, body, author_type, author_name, created_at: ts };
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

  /**
   * Idempotent on (task_id, kind, uri): re-attaching the same reference returns
   * the existing artifact and emits no duplicate event — `kanban git link`
   * re-scans a repo safely (docs/07). The title is not part of the identity.
   */
  addArtifact(
    taskId: string,
    kind: Artifact['kind'],
    title: string,
    uri: string,
    actor: ActorType = 'agent',
  ): Artifact {
    return this.mutate((rec) => {
      this.requireTask(taskId);
      const existing = this.db
        .prepare('SELECT * FROM artifact WHERE task_id = ? AND kind = ? AND uri = ?')
        .get(taskId, kind, uri) as Artifact | undefined;
      if (existing) return existing;
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

  // docs (board-native knowledge: design docs / ADRs / research — ADR 0007) --

  getDoc(id: string): Doc | undefined {
    return this.db.prepare('SELECT * FROM doc WHERE id = ?').get(id) as Doc | undefined;
  }

  requireDoc(id: string): Doc {
    const d = this.getDoc(id);
    if (!d) throw new NotFoundError(`doc ${id} not found`);
    return d;
  }

  listDocs(opts: { kind?: string; status?: string; task?: string; limit?: number } = {}): Doc[] {
    const where: string[] = ['d.archived_at IS NULL'];
    const params: any[] = [];
    let sql = 'SELECT d.* FROM doc d';
    if (opts.task) {
      sql += ' JOIN doc_link dl ON dl.doc_id = d.id AND dl.task_id = ?';
      params.push(opts.task);
    }
    if (opts.kind) {
      where.push('d.kind = ?');
      params.push(opts.kind);
    }
    if (opts.status) {
      where.push('d.status = ?');
      params.push(opts.status);
    }
    sql += ` WHERE ${where.join(' AND ')} ORDER BY d.updated_at DESC`;
    if (opts.limit && opts.limit > 0) sql += ` LIMIT ${opts.limit | 0}`;
    return this.db.prepare(sql).all(...params) as Doc[];
  }

  /** Non-archived docs linked to a task, newest-updated first. */
  getTaskDocs(taskId: string): Doc[] {
    return this.db
      .prepare(
        `SELECT d.* FROM doc_link dl JOIN doc d ON d.id = dl.doc_id
          WHERE dl.task_id = ? AND d.archived_at IS NULL ORDER BY d.updated_at DESC`,
      )
      .all(taskId) as Doc[];
  }

  /** Task ids a doc is linked to (live tasks only). */
  getDocTasks(docId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT dl.task_id FROM doc_link dl JOIN task t ON t.id = dl.task_id
            WHERE dl.doc_id = ? AND t.archived_at IS NULL ORDER BY dl.task_id`,
        )
        .all(docId) as { task_id: string }[]
    ).map((r) => r.task_id);
  }

  private assertDocKind(kind: string): asserts kind is DocKind {
    if (!(DOC_KINDS as readonly string[]).includes(kind))
      throw new ValidationError(`invalid doc kind "${kind}"; valid: ${DOC_KINDS.join(', ')}`);
  }

  private assertDocBody(body: string | undefined | null): void {
    if (body && Buffer.byteLength(body, 'utf8') > MAX_DOC_BODY_BYTES)
      throw new ValidationError(
        `doc body exceeds ${MAX_DOC_BODY_BYTES / 1024} KB — split it or store it as a file and attach an artifact reference instead`,
      );
  }

  createDoc(input: {
    kind: string;
    title: string;
    body?: string;
    summary?: string;
    status?: string;
    links?: string[];
    actor?: ActorType;
  }): Doc {
    const actor = input.actor ?? 'agent';
    this.assertDocKind(input.kind);
    this.assertDocBody(input.body);
    if (input.status !== undefined && !(DOC_STATUSES as readonly string[]).includes(input.status))
      throw new ValidationError(`invalid doc status "${input.status}"; valid: ${DOC_STATUSES.join(', ')}`);
    return this.mutate((rec) => {
      const id = nextDocId(this.db);
      const ts = now();
      // ADRs/designs/spikes start as drafts; research/notes are immediately live.
      const status =
        input.status ?? (input.kind === 'research' || input.kind === 'note' ? 'active' : 'draft');
      this.db
        .prepare(
          `INSERT INTO doc(id,kind,title,body,summary,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(id, input.kind, input.title, input.body ?? null, input.summary ?? null, status, ts, ts);
      rec({
        type: 'doc.created',
        task_id: null,
        actor_type: actor,
        payload: { doc_id: id, kind: input.kind, title: input.title },
      });
      for (const taskId of input.links ?? []) this.linkDocTx(rec, id, taskId, actor);
      return this.requireDoc(id);
    });
  }

  updateDoc(
    id: string,
    fields: Partial<Pick<Doc, 'title' | 'body' | 'summary' | 'status' | 'superseded_by'>>,
    actor: ActorType = 'agent',
  ): Doc {
    this.assertDocBody(fields.body);
    if (fields.status !== undefined && !(DOC_STATUSES as readonly string[]).includes(fields.status))
      throw new ValidationError(`invalid doc status "${fields.status}"; valid: ${DOC_STATUSES.join(', ')}`);
    return this.mutate((rec) => {
      this.requireDoc(id);
      if (fields.superseded_by !== undefined && fields.superseded_by !== null) {
        if (fields.superseded_by === id) throw new ValidationError('a doc cannot supersede itself');
        this.requireDoc(fields.superseded_by);
      }
      const sets: string[] = ['updated_at = @ts'];
      const params: any = { id, ts: now() };
      for (const key of ['title', 'body', 'summary', 'status', 'superseded_by'] as const) {
        if (fields[key] !== undefined) {
          sets.push(`${key} = @${key}`);
          params[key] = fields[key];
        }
      }
      // Marking a doc superseded (either way in) keeps both fields coherent.
      if (fields.superseded_by && fields.status === undefined) {
        sets.push(`status = 'superseded'`);
      }
      this.db.prepare(`UPDATE doc SET ${sets.join(', ')} WHERE id = @id`).run(params);
      rec({
        type: 'doc.updated',
        task_id: null,
        actor_type: actor,
        payload: { doc_id: id, fields: Object.keys(fields), ...(fields.status ? { status: fields.status } : {}) },
      });
      return this.requireDoc(id);
    });
  }

  archiveDoc(id: string, actor: ActorType = 'agent'): void {
    this.mutate((rec) => {
      this.requireDoc(id);
      this.db.prepare('UPDATE doc SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
      rec({ type: 'doc.updated', task_id: null, actor_type: actor, payload: { doc_id: id, fields: ['archived_at'] } });
    });
  }

  private linkDocTx(rec: any, docId: string, taskId: string, actor: ActorType) {
    this.requireDoc(docId);
    this.requireTask(taskId);
    // Idempotent: re-linking is a no-op with no duplicate event.
    const info = this.db
      .prepare('INSERT OR IGNORE INTO doc_link(doc_id, task_id) VALUES(?, ?)')
      .run(docId, taskId);
    if (info.changes > 0)
      rec({ type: 'doc.linked', task_id: taskId, actor_type: actor, payload: { doc_id: docId } });
  }

  linkDoc(docId: string, taskId: string, actor: ActorType = 'agent'): void {
    this.mutate((rec) => this.linkDocTx(rec, docId, taskId, actor));
  }

  unlinkDoc(docId: string, taskId: string, actor: ActorType = 'agent'): void {
    this.mutate((rec) => {
      const info = this.db
        .prepare('DELETE FROM doc_link WHERE doc_id = ? AND task_id = ?')
        .run(docId, taskId);
      if (info.changes > 0)
        rec({ type: 'doc.unlinked', task_id: taskId, actor_type: actor, payload: { doc_id: docId } });
    });
  }

  // brainstorm (structured ideation: capture -> cluster/score -> promote) ---

  getBrainstorm(id: string): BrainstormSession | undefined {
    return this.db.prepare('SELECT * FROM brainstorm_session WHERE id = ?').get(id) as
      | BrainstormSession
      | undefined;
  }

  requireBrainstorm(id: string): BrainstormSession {
    const s = this.getBrainstorm(id);
    if (!s) throw new NotFoundError(`brainstorm ${id} not found`);
    return s;
  }

  listBrainstorms(opts: { status?: string; task?: string } = {}): BrainstormSession[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.task) {
      where.push('task_id = ?');
      params.push(opts.task);
    }
    const sql =
      'SELECT * FROM brainstorm_session' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC';
    return this.db.prepare(sql).all(...params) as BrainstormSession[];
  }

  getIdea(id: string): Idea | undefined {
    return this.db.prepare('SELECT * FROM idea WHERE id = ?').get(id) as Idea | undefined;
  }

  requireIdea(id: string): Idea {
    const i = this.getIdea(id);
    if (!i) throw new NotFoundError(`idea ${id} not found`);
    return i;
  }

  /** Ideas of a session, best first (scored desc, then unscored, oldest first). */
  getIdeas(sessionId: string): Idea[] {
    return this.db
      .prepare(
        `SELECT * FROM idea WHERE session_id = ?
          ORDER BY score IS NULL, score DESC, created_at ASC`,
      )
      .all(sessionId) as Idea[];
  }

  startBrainstorm(topic: string, opts: { task?: string; actor?: ActorType } = {}): BrainstormSession {
    const actor = opts.actor ?? 'agent';
    return this.mutate((rec) => {
      const taskId = opts.task ?? null;
      if (taskId !== null) this.requireTask(taskId);
      const id = nextBrainstormId(this.db);
      const ts = now();
      this.db
        .prepare(`INSERT INTO brainstorm_session(id,topic,status,task_id,created_at) VALUES(?,?,'open',?,?)`)
        .run(id, topic, taskId, ts);
      rec({
        type: 'brainstorm.started',
        task_id: taskId,
        actor_type: actor,
        payload: { session_id: id, topic },
      });
      return this.requireBrainstorm(id);
    });
  }

  closeBrainstorm(id: string, actor: ActorType = 'agent'): BrainstormSession {
    return this.mutate((rec) => {
      const s = this.requireBrainstorm(id);
      if (s.status === 'closed') return s; // idempotent, no event
      this.db
        .prepare(`UPDATE brainstorm_session SET status='closed', closed_at=? WHERE id=?`)
        .run(now(), id);
      rec({ type: 'brainstorm.closed', task_id: s.task_id, actor_type: actor, payload: { session_id: id } });
      return this.requireBrainstorm(id);
    });
  }

  addIdea(sessionId: string, text: string, opts: { cluster?: string; actor?: ActorType } = {}): Idea {
    const actor = opts.actor ?? 'agent';
    if (!text.trim()) throw new ValidationError('an idea needs text');
    if (text.length > 2000) throw new ValidationError('idea text exceeds 2000 chars — write a doc instead');
    return this.mutate((rec) => {
      const s = this.requireBrainstorm(sessionId);
      if (s.status !== 'open') throw new ValidationError(`brainstorm ${sessionId} is closed`);
      const id = nextIdeaId(this.db);
      this.db
        .prepare(`INSERT INTO idea(id,session_id,text,cluster,status,created_at) VALUES(?,?,?,?,'open',?)`)
        .run(id, sessionId, text, opts.cluster ?? null, now());
      rec({
        type: 'idea.added',
        task_id: s.task_id,
        actor_type: actor,
        payload: { idea_id: id, session_id: sessionId },
      });
      return this.requireIdea(id);
    });
  }

  /**
   * Edit an idea: score (0–10, null clears), cluster (null clears), text, or
   * discard (status -> discarded). Promoted/discarded ideas are frozen — the
   * lifecycle is one-way; re-add the idea if a discard was wrong.
   */
  updateIdea(
    id: string,
    fields: { score?: number | null; cluster?: string | null; text?: string; discard?: boolean },
    actor: ActorType = 'agent',
  ): Idea {
    if (fields.score !== undefined && fields.score !== null) {
      if (!Number.isInteger(fields.score) || fields.score < 0 || fields.score > 10)
        throw new ValidationError('score must be an integer 0–10');
    }
    if (fields.text !== undefined && !fields.text.trim()) throw new ValidationError('an idea needs text');
    return this.mutate((rec) => {
      const i = this.requireIdea(id);
      if (i.status !== 'open') throw new ValidationError(`idea ${id} is ${i.status} and can no longer change`);
      const sets: string[] = [];
      const params: any = { id };
      const changed: string[] = [];
      if (fields.score !== undefined) (sets.push('score = @score'), (params.score = fields.score), changed.push('score'));
      if (fields.cluster !== undefined)
        (sets.push('cluster = @cluster'), (params.cluster = fields.cluster), changed.push('cluster'));
      if (fields.text !== undefined) (sets.push('text = @text'), (params.text = fields.text), changed.push('text'));
      if (fields.discard) (sets.push(`status = 'discarded'`), changed.push('status'));
      if (!sets.length) return i;
      this.db.prepare(`UPDATE idea SET ${sets.join(', ')} WHERE id = @id`).run(params);
      const s = this.getBrainstorm(i.session_id);
      rec({
        type: 'idea.updated',
        task_id: s?.task_id ?? null,
        actor_type: actor,
        payload: {
          idea_id: id,
          fields: changed,
          ...(fields.score !== undefined ? { score: fields.score } : {}),
          ...(fields.discard ? { status: 'discarded' } : {}),
        },
      });
      return this.requireIdea(id);
    });
  }

  /**
   * Promote an idea to a real task — one transaction: the task exists iff the
   * idea is marked promoted. Defaults: title = idea text, description carries
   * provenance; `task` options (priority/parent/status/labels…) pass through to
   * task creation.
   */
  promoteIdea(
    id: string,
    taskInput: Partial<NewTaskInput> = {},
    actor: ActorType = 'agent',
  ): { idea: Idea; task: Task } {
    return this.mutate((rec) => {
      const i = this.requireIdea(id);
      if (i.status !== 'open') throw new ValidationError(`idea ${id} is already ${i.status}`);
      const s = this.requireBrainstorm(i.session_id);
      const task = this.createTaskTx(
        rec,
        {
          title: taskInput.title ?? i.text,
          description:
            taskInput.description ??
            `${i.text}\n\n(promoted from idea ${i.id} in brainstorm ${s.id} "${s.topic}")`,
          ...taskInput,
          actor,
        } as NewTaskInput,
        actor,
      );
      this.db
        .prepare(`UPDATE idea SET status='promoted', promoted_task_id=? WHERE id=?`)
        .run(task.id, id);
      rec({
        type: 'idea.promoted',
        task_id: task.id,
        actor_type: actor,
        payload: { idea_id: id, session_id: s.id },
      });
      return { idea: this.requireIdea(id), task };
    });
  }

  // search (board-wide: tasks / docs / comments) ---------------------------

  /** Whether the FTS5 index is available on this board (see db.ts v5 guard). */
  ftsEnabled(): boolean {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'fts_enabled'").get() as
      | { value: string }
      | undefined;
    return r?.value === '1';
  }

  /**
   * Board-wide search over tasks (title/description/summary), docs
   * (title/summary/body), and comments. FTS5 `MATCH` ranked by bm25 with a
   * quoted-phrase retry on user-syntax errors; LIKE fallback when FTS5 is
   * unavailable. Archived content never surfaces: task/doc rows drop out of the
   * index via triggers, and a comment on an archived task is filtered here.
   */
  search(q: string, opts: { type?: string; limit?: number } = {}): SearchResult[] {
    const query = q.trim();
    if (!query) return [];
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 100) : 20;
    const raw = this.ftsEnabled() ? this.searchFts(query, opts.type, limit) : this.searchLike(query, opts.type, limit);
    const out: SearchResult[] = [];
    for (const r of raw) {
      const hit = this.toSearchResult(r);
      if (hit) out.push(hit);
      if (out.length >= limit) break;
    }
    return out;
  }

  private searchFts(query: string, type: string | undefined, limit: number): any[] {
    // Over-fetch: the liveness check below may drop comment hits on archived tasks.
    const run = (m: string) => {
      const params: any[] = [m];
      let sql = `SELECT type, ref_id, snippet(search_index, -1, '', '', '…', 12) AS snip
                   FROM search_index WHERE search_index MATCH ?`;
      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }
      sql += ' ORDER BY bm25(search_index) LIMIT ?';
      params.push(limit * 3);
      return this.db.prepare(sql).all(...params) as any[];
    };
    try {
      return run(query);
    } catch {
      // User input isn't FTS5 query syntax (stray quotes/operators) — retry as a
      // literal quoted phrase rather than erroring the read.
      return run(`"${query.replace(/"/g, '""')}"`);
    }
  }

  private searchLike(query: string, type: string | undefined, limit: number): any[] {
    const esc = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const parts: string[] = [];
    if (!type || type === 'task')
      parts.push(`SELECT 'task' AS type, id AS ref_id,
        substr(title || ' ' || COALESCE(description,''), 1, 60) AS snip, updated_at AS ts
        FROM task WHERE archived_at IS NULL AND (title LIKE $q ESCAPE '\\'
          OR description LIKE $q ESCAPE '\\' OR summary LIKE $q ESCAPE '\\')`);
    if (!type || type === 'doc')
      parts.push(`SELECT 'doc' AS type, id AS ref_id,
        substr(title || ' ' || COALESCE(summary,''), 1, 60) AS snip, updated_at AS ts
        FROM doc WHERE archived_at IS NULL AND (title LIKE $q ESCAPE '\\'
          OR summary LIKE $q ESCAPE '\\' OR body LIKE $q ESCAPE '\\')`);
    if (!type || type === 'comment')
      parts.push(`SELECT 'comment' AS type, id AS ref_id, substr(body, 1, 60) AS snip, created_at AS ts
        FROM comment WHERE body LIKE $q ESCAPE '\\'`);
    if (!type || type === 'idea')
      parts.push(`SELECT 'idea' AS type, id AS ref_id, substr(text, 1, 60) AS snip, created_at AS ts
        FROM idea WHERE text LIKE $q ESCAPE '\\'`);
    if (!parts.length) return [];
    const sql = parts.join(' UNION ALL ') + ` ORDER BY ts DESC LIMIT ${(limit * 3) | 0}`;
    return this.db.prepare(sql).all({ q: esc }) as any[];
  }

  /** Enrich an index row from its source table; null = stale/archived, drop it. */
  private toSearchResult(r: { type: string; ref_id: string; snip: string }): SearchResult | null {
    if (r.type === 'task') {
      const t = this.getTask(r.ref_id);
      if (!t || t.archived_at !== null) return null;
      return { type: 'task', id: t.id, title: t.title, snippet: r.snip, task_id: t.id, kind: null, status: t.status };
    }
    if (r.type === 'doc') {
      const d = this.getDoc(r.ref_id);
      if (!d || d.archived_at !== null) return null;
      return { type: 'doc', id: d.id, title: d.title, snippet: r.snip, task_id: null, kind: d.kind, status: d.status };
    }
    if (r.type === 'idea') {
      const i = this.getIdea(r.ref_id);
      if (!i) return null;
      const s = this.getBrainstorm(i.session_id);
      return {
        type: 'idea',
        id: i.id,
        title: s ? s.topic : '',
        snippet: r.snip,
        task_id: i.promoted_task_id,
        kind: null,
        status: i.status,
      };
    }
    const c = this.db.prepare('SELECT * FROM comment WHERE id = ?').get(r.ref_id) as Comment | undefined;
    if (!c) return null;
    const t = this.getTask(c.task_id);
    if (!t || t.archived_at !== null) return null; // comment on an archived task
    return { type: 'comment', id: c.id, title: t.title, snippet: r.snip, task_id: c.task_id, kind: null, status: null };
  }

  // human-in-the-loop -----------------------------------------------------

  ask(
    taskId: string,
    question: string,
    opts: {
      options?: string[];
      freeform?: boolean;
      expiresAt?: string;
      defaultAnswer?: string;
      actor?: ActorType;
    } = {},
  ): InputRequest {
    const actor = opts.actor ?? 'agent';
    // A default only ever applies at expiry — without a deadline it would be
    // unreachable dead state, so require the pairing up front.
    if (opts.defaultAnswer !== undefined && !opts.expiresAt)
      throw new ValidationError('a default answer needs --expires-at (it is applied at expiry)');
    if (
      opts.defaultAnswer !== undefined &&
      opts.options &&
      !opts.freeform &&
      !opts.options.includes(opts.defaultAnswer)
    )
      throw new ValidationError(`default must be one of: ${opts.options.join(', ')}`);
    return this.mutate((rec) => {
      this.requireTask(taskId);
      const id = nextRequestId(this.db);
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO input_request(id,task_id,question,options,answer_freeform,status,created_at,expires_at,default_answer)
           VALUES(?,?,?,?,?, 'open', ?, ?, ?)`,
        )
        .run(
          id,
          taskId,
          question,
          opts.options ? JSON.stringify(opts.options) : null,
          opts.freeform ? 1 : 0,
          ts,
          opts.expiresAt ?? null,
          opts.defaultAnswer ?? null,
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
   * Resolve every open request whose `expires_at` has passed. A request carrying
   * a `default_answer` resolves as **answered** (`answered_by: 'system:default'`,
   * `input.answered` flagged `defaulted: true`) — the agent stays unblocked when
   * the human is away, never silently: the flag rides the event and the
   * answered_by. Requests without a default expire as before (`input.expired`).
   * The `rec` collector batches all of them into one transaction + one
   * broadcast. `nowTs` is injectable so tests drive expiry deterministically.
   * Called by the server's low-frequency sweep (server.ts); inert when no open
   * request carries an `expires_at`.
   */
  expireDue(nowTs: string = now()): { expired: number; defaulted: number } {
    return this.mutate((rec) => {
      const due = this.db
        .prepare(
          `SELECT * FROM input_request WHERE status='open' AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .all(nowTs)
        .map(this.mapRequest);
      const expire = this.db.prepare(`UPDATE input_request SET status='expired', answered_at=? WHERE id=?`);
      const applyDefault = this.db.prepare(
        `UPDATE input_request SET status='answered', answer=?, answered_by='system:default', answered_at=? WHERE id=?`,
      );
      let expired = 0;
      let defaulted = 0;
      for (const r of due) {
        if (r.default_answer !== null) {
          applyDefault.run(r.default_answer, nowTs, r.id);
          rec({
            type: 'input.answered',
            task_id: r.task_id,
            actor_type: 'system',
            payload: { request_id: r.id, answer: r.default_answer, defaulted: true },
          });
          defaulted++;
        } else {
          expire.run(nowTs, r.id);
          rec({ type: 'input.expired', task_id: r.task_id, actor_type: 'system', payload: { request_id: r.id } });
          expired++;
        }
      }
      return { expired, defaulted };
    });
  }
}
