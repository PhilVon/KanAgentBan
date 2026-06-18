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
export type DepType = 'blocks' | 'relates' | 'duplicates';
export type ArtifactKind = 'link' | 'file' | 'pr' | 'output';
export type SummarySource = 'human' | 'agent' | 'auto';

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
  question: string;
  options: string[] | null;
  answer_freeform: boolean;
  status: InputStatus;
  answer: string | null;
  answered_by: string | null;
  created_at: string;
  answered_at: string | null;
  expires_at: string | null;
}

export interface AcceptanceCriterion {
  id: string; // AC-n
  task_id: string;
  text: string;
  checked: boolean;
  checked_at: string | null;
  position: number;
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

/** Canonical event types — see docs/02-data-model.md §3 and 07-api-reference.md. */
export type EventType =
  | 'task.created'
  | 'task.updated'
  | 'task.moved'
  | 'task.archived'
  | 'task.claimed'
  | 'task.released'
  | 'dep.added'
  | 'dep.removed'
  | 'comment.added'
  | 'criterion.added'
  | 'criterion.checked'
  | 'criterion.unchecked'
  | 'label.added'
  | 'label.removed'
  | 'artifact.added'
  | 'input.requested'
  | 'input.answered'
  | 'input.cancelled'
  | 'input.expired';

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
}
