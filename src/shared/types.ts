// Shared domain types. Mirrors docs/02-data-model.md.

/** Stored workflow status. NOTE: "Blocked" is a *derived projection* (see
 *  docs/02-data-model.md §4-5) and is never written to `task.status`. */
export type WorkflowStatus = 'Backlog' | 'Ready' | 'In Progress' | 'Review' | 'Done';

export const WORKFLOW_STATUSES: WorkflowStatus[] = [
  'Backlog',
  'Ready',
  'In Progress',
  'Review',
  'Done',
];

/** Ordered display columns shown in the UI. "Blocked" is a projection. */
export const DISPLAY_COLUMNS = [
  'Backlog',
  'Ready',
  'In Progress',
  'Blocked',
  'Review',
  'Done',
] as const;

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export type ActorType = 'agent' | 'user' | 'system';
export type AuthorType = ActorType;

export type InputStatus = 'open' | 'answered' | 'cancelled' | 'expired';

/**
 * What an open request is *for*. `ask` had one shape and two jobs: a **question**
 * is a decision with an answer to choose, and it rightly parks the task
 * `needs_input`. A **watch** ("tell me when the files land") has no answer to
 * choose and nothing to chase — written as a question it set `needs_input`, the
 * UI derived **Blocked** from that, and it sat for days looking like a question
 * the human had failed to answer, with every remedy `doctor` offered wrong for
 * it. A watch is *supposed* to be open, so it does not block.
 */
export type InputKind = 'question' | 'watch';
export const INPUT_KINDS: readonly InputKind[] = ['question', 'watch'] as const;
export type DepType = 'blocks' | 'relates' | 'duplicates';
/** `commit` (`uri: git:<sha>`) and `branch` (`uri: branch:<name>`) are git
 *  references recorded by `kanban git link` — still references, never contents
 *  (ADR 0005; git execution is CLI-side only, ADR 0008). */
export type ArtifactKind = 'link' | 'file' | 'pr' | 'output' | 'commit' | 'branch';
export type SummarySource = 'human' | 'agent' | 'auto';

export type DocKind = 'design' | 'adr' | 'spike' | 'research' | 'note';
export const DOC_KINDS: DocKind[] = ['design', 'adr', 'spike', 'research', 'note'];

/** One lifecycle enum for every doc kind: ADRs walk draft→accepted→superseded;
 *  research/notes default straight to `active` (see docs/02-data-model.md). */
export type DocStatus = 'draft' | 'active' | 'accepted' | 'rejected' | 'superseded';
export const DOC_STATUSES: DocStatus[] = ['draft', 'active', 'accepted', 'rejected', 'superseded'];

export interface Task {
  id: string; // T-n
  title: string;
  description: string | null;
  summary: string | null;
  summary_source: SummarySource | null;
  summary_updated_at: string | null;
  description_updated_at: string | null;
  status: WorkflowStatus;
  priority: Priority;
  position: number | null;
  assignee: string | null;
  /** Claim-lease expiry (ISO). Null = indefinite claim. Past-due leases are
   *  auto-released by the server sweep (`task.released` with `expired: true`)
   *  so a dead agent never wedges a task. */
  claim_expires_at: string | null;
  /** Parent task id (`T-n`) when this is a subtask; null at the top level. */
  parent_id: string | null;
  /** Resume pointer — one per task, latest wins ("did X, next Y, watch Z").
   *  Rendered first in show/context so a cold session reads it before anything
   *  else. Null when never set (or cleared). */
  checkpoint: string | null;
  checkpoint_at: string | null;
  /** Agent identity that wrote the checkpoint (x-agent / KANBAN_AGENT). */
  checkpoint_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Dependency {
  from_task: string;
  to_task: string;
  type: DepType;
}

export interface Comment {
  id: string; // C-n
  task_id: string;
  body: string;
  author_type: AuthorType;
  author_name: string;
  created_at: string;
}

export interface InputRequest {
  id: string; // Q-n
  task_id: string;
  /** The decision to make, or — for a `watch` — the event to wait for. */
  question: string;
  /** `question` (blocks) or `watch` (does not). Boards predating this default to
   *  `question`, which is what every pre-existing row was. */
  kind: InputKind;
  options: string[] | null;
  answer_freeform: boolean;
  status: InputStatus;
  answer: string | null;
  /**
   * Why that answer — the part a reader in six months actually needs. The
   * choice alone (`lift-it`) records the decision and loses the reasoning, and
   * answers end up quoted in code comments where the reasoning is the point.
   * Optional: a note is worth prompting for, never worth blocking on.
   */
  answer_note: string | null;
  answered_by: string | null;
  created_at: string;
  answered_at: string | null;
  expires_at: string | null;
  /** Auto-answer applied at expiry (`ask --default`, requires `expires_at`).
   *  A defaulted resolution is `answered` with `answered_by: 'system:default'`
   *  and an `input.answered` event flagged `defaulted: true` — never silent. */
  default_answer: string | null;
}

export interface AcceptanceCriterion {
  id: string; // AC-n
  task_id: string;
  text: string;
  checked: boolean;
  checked_at: string | null;
  position: number;
  /**
   * Only the human can settle this one (a playtest, "does it read right?").
   * It stays in the denominator — it is still work — but `doctor` names it
   * apart from work the *agent* is failing to finish. Without it an agent
   * raises one `Q-n` per such criterion: six of one session's ten questions
   * existed only to route criteria the board could not.
   */
  human: boolean;
  /**
   * Set when the criterion turned out to be **wrong**, not merely undone. With
   * two states a mis-specified criterion can only be ticked falsely, left
   * unchecked forever, or escalated; retiring one makes a planning error
   * self-correcting. A retired criterion leaves BOTH sides of the count and
   * never reads as unfinished work.
   */
  retired_at: string | null;
  /** Why it was retired — required, and the point of the whole state. */
  retire_reason: string | null;
  /** The task that carries the work instead, when there is one. */
  successor_task_id: string | null;
}

export interface Artifact {
  id: string; // A-n
  task_id: string;
  kind: ArtifactKind;
  title: string;
  uri: string;
  created_at: string;
}

export interface Label {
  name: string;
  color: string | null;
}

/**
 * A board-native knowledge document: design doc, ADR, spike write-up, research
 * finding, or free note. Unlike artifacts (references only, ADR 0005), a doc's
 * markdown `body` IS stored on the board — durable, searchable, token-budgeted
 * (ADR 0007). Linked to tasks many-to-many via `doc_link`.
 */
export interface Doc {
  id: string; // D-n
  kind: DocKind;
  title: string;
  /** Markdown content, capped server-side (see repo.ts MAX_DOC_BODY_BYTES). */
  body: string | null;
  /** Short abstract — what list/context tiers render; body needs `doc show`. */
  summary: string | null;
  status: DocStatus;
  /** Doc id (D-n) that replaces this one, when status is `superseded`. */
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface DocLink {
  doc_id: string;
  task_id: string;
}

export type BrainstormStatus = 'open' | 'closed';
export type IdeaStatus = 'open' | 'promoted' | 'discarded';

/**
 * A structured ideation session: capture ideas fast, then cluster, score, and
 * promote the winners to real tasks. Optionally anchored to the task that
 * prompted it.
 */
export interface BrainstormSession {
  id: string; // B-n
  topic: string;
  status: BrainstormStatus;
  /** The task this session explores, if any (surfaced in that task's context). */
  task_id: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface Idea {
  id: string; // I-n
  session_id: string;
  text: string;
  /** Free-form cluster name for grouping related ideas; null = unclustered. */
  cluster: string | null;
  /** 0–10; null = unscored. */
  score: number | null;
  status: IdeaStatus;
  /** The task this idea became, when status is `promoted`. */
  promoted_task_id: string | null;
  created_at: string;
}

/** Reusable task blueprint (`kanban template save/apply`) — criteria set,
 *  labels, priority, and a one-level subtask skeleton. Stored as JSON in the
 *  `template` table; the title always comes from `apply`. */
export interface TemplateBlueprint {
  description?: string;
  priority?: Priority;
  labels: string[];
  criteria: string[];
  subtasks: { title: string; criteria: string[] }[];
}

export interface TaskTemplate {
  name: string;
  blueprint: TemplateBlueprint;
  created_at: string;
  updated_at: string;
}

/** One board-wide search hit (tasks, docs, comments, ideas). See docs/07 §Search. */
export interface SearchResult {
  type: 'task' | 'doc' | 'comment' | 'idea';
  /** Public id of the hit: T-n / D-n / C-n. */
  id: string;
  title: string;
  /** Matched-text excerpt (FTS5 snippet; whole-text prefix under LIKE fallback). */
  snippet: string;
  /** The owning task for comment hits (and the hit itself for task hits). */
  task_id: string | null;
  /** Doc kind/status for doc hits. */
  kind: DocKind | null;
  status: string | null;
}

/** A search result set plus how it was obtained. See docs/07 §Search. */
export interface SearchOutcome {
  hits: SearchResult[];
  /**
   * True when the all-terms query found nothing and these came from an
   * OR-ranked retry — approximate matches, and every read that shows them says
   * so rather than passing them off as hits.
   */
  loose: boolean;
}

/** Canonical event types — see docs/02-data-model.md §3 and 07-api-reference.md. */
export type EventType =
  | 'task.created'
  | 'task.updated'
  | 'task.moved'
  | 'task.archived'
  | 'task.claimed'
  | 'task.released'
  | 'task.reparented'
  | 'task.checkpointed'
  | 'dep.added'
  | 'dep.removed'
  | 'comment.added'
  | 'criterion.added'
  | 'criterion.checked'
  | 'criterion.retired'
  | 'criterion.amended'
  | 'criterion.unchecked'
  | 'label.added'
  | 'label.removed'
  | 'artifact.added'
  | 'input.requested'
  | 'input.answered'
  | 'input.cancelled'
  | 'input.expired'
  | 'doc.created'
  | 'doc.updated'
  | 'doc.linked'
  | 'doc.unlinked'
  | 'template.saved'
  | 'template.deleted'
  | 'template.applied'
  | 'brainstorm.started'
  | 'brainstorm.closed'
  | 'idea.added'
  | 'idea.updated'
  | 'idea.promoted';

export interface BoardEvent {
  seq: number;
  ts: string;
  type: EventType;
  task_id: string | null;
  actor_type: ActorType;
  payload: Record<string, unknown>;
}

/** Derived, never-stored flags. See docs/02-data-model.md §5. */
export interface DerivedState {
  blocked_by_deps: boolean;
  needs_input: boolean;
  /** Has at least one non-archived child task that is not yet Done. */
  blocked_by_children: boolean;
  ready: boolean;
}

/** External-nudge auto-resume transport config (docs/04-human-in-the-loop §3C,
 *  docs/adr/0006). Both transports are optional and off by default. */
export interface NudgeConfig {
  /** Webhook URL; the server POSTs the `input.answered` event here. */
  url?: string;
  /** Extra headers sent with the webhook POST (e.g. an auth token). */
  headers?: Record<string, string>;
  /** Local command to spawn; event fields are passed via KANBAN_* env vars. */
  cmd?: string;
}

/** Persisted per-board metadata in `.kanban/board.json`. */
export interface BoardMeta {
  name?: string;
  created_at?: string;
  nudge?: NudgeConfig;
  /** Auto-archive policy: archive Done tasks untouched for this many days
   *  (server sweep; `kanban board autoarchive`). Absent/0 = off. */
  auto_archive_days?: number;
  /**
   * Affect hints (`kanban board affect`). Off unless `enabled` — the board
   * emits `eb consult …` command TEXT at moments it knows are decisions and
   * nothing else: it never runs `eb`, reads the brain, or stores a stance
   * (ADR 0009). `map` turns board labels into `eb` cue keys; unmapped labels
   * fall back to `activity:<label>`.
   */
  affect?: { enabled?: boolean; map?: Record<string, string> };
}
