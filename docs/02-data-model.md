# 02 — Data Model

> **Summary:** The board's state lives in a single SQLite database per board (WAL
> mode). Tasks form a dependency DAG; an append-only `event` log with a monotonic
> `seq` is the spine for realtime, delta sync, and audit. Task "blocked" state is
> *derived* from two independent flags, never stored as a column.
>
> **Decisions:** Soft-delete only (events reference rows forever). `seq` is
> allocated inside the same transaction as the mutation it records. Acceptance
> criteria and dependencies are first-class rows, not freetext. Artifacts hold
> *references*, never blobs.
>
> **Locked:** **One SQLite DB file per project**, at `.kanban/board.db` under the
> project root (not a centralized DB keyed by path). See
> [10-security-lifecycle](10-security-lifecycle.md).

Related: [03-token-efficiency](03-token-efficiency.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md) ·
[07-api-reference](07-api-reference.md) · [09-concurrency](09-concurrency.md)

---

## 1. Identifiers

| Entity | Public ID | Internal PK | Notes |
|--------|-----------|-------------|-------|
| Board | `board_id` (slug) | rowid | One per project path |
| Task | `T-<n>` | rowid | `n` is per-board, monotonic, never reused |
| Input request | `Q-<n>` | rowid | per-board monotonic |
| Comment | `C-<n>` | rowid | per-board monotonic |
| Acceptance criterion | `AC-<n>` | rowid | per-board monotonic |
| Artifact | `A-<n>` | rowid | per-board monotonic |
| Label | name (string) | rowid | unique per board |
| Event | `seq` (integer) | seq | per-board monotonic, gap-free |

Short, prefixed IDs are a token-efficiency choice — `T-12` costs far fewer tokens
than a UUID and is human-readable in the UI. A per-board `counters` table issues
each sequence under the write transaction.

---

## 2. Entities

### board
| Field | Type | Notes |
|-------|------|-------|
| `board_id` | TEXT PK | slug derived from project dir name |
| `project_path` | TEXT UNIQUE | absolute path; the lookup key |
| `name` | TEXT | display name |
| `columns` | JSON | ordered column config (see §4) |
| `schema_version` | INTEGER | for migrations |
| `created_at` | TEXT (ISO-8601) | |

### task
| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT (`T-n`) | public id |
| `title` | TEXT | required |
| `description` | TEXT | long form, markdown |
| `summary` | TEXT | short, token-cheap; default in tiered views |
| `summary_source` | TEXT | `human` \| `agent` \| `auto` |
| `summary_updated_at` | TEXT | drift detection |
| `description_updated_at` | TEXT | drift detection |
| `status` | TEXT | one of board columns (see §4) — the *workflow* state |
| `priority` | TEXT | `P0`..`P3` (P0 highest) |
| `position` | REAL | manual ordering within a column |
| `assignee` | TEXT NULL | agent identity holding the task (`kanban claim`/`release`, [09 §9](09-concurrency.md)) |
| `version` | INTEGER | optimistic-concurrency token, bumped per mutation |
| `created_at` / `updated_at` | TEXT | |
| `archived_at` | TEXT NULL | soft delete; non-null = archived |

> **`status` vs "Blocked":** `status` is the column the human/agent put the task
> in (e.g. `In Progress`). Being *blocked* is **derived** (§5) and shown as a
> projection — it is never written to `status` by the engine. A task can be
> `In Progress` *and* `needs_input`; the UI surfaces it in the Blocked column
> while the underlying workflow status is preserved for when it unblocks.

### dependency
| Field | Type | Notes |
|-------|------|-------|
| `from_task` | TEXT | the dependent task |
| `to_task` | TEXT | the prerequisite |
| `type` | TEXT | `blocks` (default); `relates`/`duplicates` reserved |

Semantics: `from_task` is blocked by `to_task` until `to_task` is Done.
**Insert rejects:** self-dependency, duplicate edge, and any edge that would create
a cycle (DFS reachability check on `blocks` edges within the write txn).

### comment
| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT (`C-n`) | |
| `task_id` | TEXT | |
| `body` | TEXT | markdown |
| `author_type` | TEXT | `agent` \| `user` \| `system` |
| `author_name` | TEXT | e.g. `claude`, `phil`, `system` |
| `created_at` | TEXT | |

`system` comments are audit lines (moves, status changes). Tiered context views
prioritize `user`/`agent` comments and collapse `system` ones to a count.

### input_request
| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT (`Q-n`) | |
| `task_id` | TEXT | |
| `question` | TEXT | |
| `options` | JSON NULL | constrained choices; null = free-form |
| `answer_freeform` | INTEGER (bool) | allow free text even when options given |
| `status` | TEXT | `open` \| `answered` \| `cancelled` \| `expired` |
| `answer` | TEXT NULL | validated ∈ options when constrained |
| `answered_by` | TEXT NULL | |
| `created_at` / `answered_at` | TEXT | |
| `expires_at` | TEXT NULL | optional auto-cancel / default-answer time |

Lifecycle and state diagram: see [04-human-in-the-loop](04-human-in-the-loop.md).

### acceptance_criterion
| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT (`AC-n`) | |
| `task_id` | TEXT | |
| `text` | TEXT | |
| `checked` | INTEGER (bool) | |
| `checked_at` | TEXT NULL | |
| `position` | REAL | ordering |

Rows (not freetext) so progress renders as a cheap `3/5` and the agent can tick
items individually via the CLI.

### artifact
| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT (`A-n`) | |
| `task_id` | TEXT | |
| `kind` | TEXT | `link` \| `file` \| `pr` \| `output` |
| `title` | TEXT | |
| `uri` | TEXT | path, URL, or PR ref — **reference only, never contents** |
| `created_at` | TEXT | |

### label / task_label
`label(name, color)` unique per board; `task_label(task_id, label_name)` join.

### event (the spine)
| Field | Type | Notes |
|-------|------|-------|
| `seq` | INTEGER PK | per-board monotonic, gap-free, = commit order |
| `ts` | TEXT | |
| `type` | TEXT | see §3 |
| `task_id` | TEXT NULL | the affected task, if any |
| `actor_type` | TEXT | `agent` \| `user` \| `system` |
| `payload` | JSON | type-specific delta |

Append-only. Powers WebSocket broadcast, `changes --since`, `watch --since`, and
`inbox` — see [09-concurrency](09-concurrency.md) for the single replay path.

---

## 3. Event types (canonical)

Every mutation appends exactly one event. This list is the shared contract for
[07-api-reference](07-api-reference.md) and the UI.

```
task.created      task.updated      task.moved        task.archived
task.claimed      task.released
dep.added         dep.removed
comment.added
criterion.added   criterion.checked criterion.unchecked
label.added       label.removed
artifact.added
input.requested   input.answered    input.cancelled   input.expired
```

`task.claimed` / `task.released` carry the multi-agent `assignee` change; their
payloads are `{assignee, stolen_from?}` and `{released_from}` respectively — see
[09-concurrency §9](09-concurrency.md).

`input.answered` is also what unblocks a parked `await` long-poll and what
`inbox` reports — see [04-human-in-the-loop](04-human-in-the-loop.md).

---

## 4. Columns / statuses (default)

Ordered, board-configurable (`board.columns`):

```
Backlog → Ready → In Progress → Blocked → Review → Done
```

`Blocked` is special: it is a **projection** the UI renders for any task where
`blocked_by_deps OR needs_input` (§5). The engine does not move tasks into
`Blocked`; it preserves their real workflow status and overlays the blocked state.

---

## 5. Derived state — the two-flag model

Two independent, separately-computed booleans (so the recommendation engine can
explain *why* a task is not actionable):

```
blocked_by_deps = EXISTS dep d WHERE d.from_task = task
                                 AND d.type = 'blocks'
                                 AND d.to_task.status != 'Done'
                                 AND d.to_task.archived_at IS NULL

needs_input     = EXISTS input_request q WHERE q.task_id = task
                                          AND q.status = 'open'

ready           = NOT blocked_by_deps
                  AND NOT needs_input
                  AND status IN ('Ready','In Progress')
                  AND archived_at IS NULL
```

- `next` (recommendation engine, [03-token-efficiency](03-token-efficiency.md))
  considers only `ready` tasks.
- Completing a task emits `task.updated`/`task.moved` and triggers readiness
  **recomputation for its dependents** (each emits no extra event unless its
  derived state is surfaced; recomputation is on-read to stay cheap).

---

## 6. Edge cases (documented behavior)

- **Reopen a Done task with Done dependents:** allowed; dependents simply remain
  ready (their blocker was satisfied earlier). Reopening a *prerequisite*
  re-blocks its dependents on next read — expected.
- **Editing an answered question:** disallowed. Ask a new `Q-n` instead; history
  stays immutable.
- **Free-form vs constrained answers:** if `options` set and `answer_freeform`
  false, the answer must be one of `options` (validated at write).
- **Cycles / self-deps / duplicates:** rejected at insert (§dependency).
- **Subtasks:** deferred from v1 — model nesting with `blocks` deps + a label
  instead, to keep the DAG flat and the queries simple
  ([11-roadmap](11-roadmap.md)).
- **Deletion:** there is none — only `archived_at`. Keeps the event log's
  references valid forever.

---

## 7. Minimal schema sketch (SQLite)

```sql
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE task (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  summary TEXT, summary_source TEXT, summary_updated_at TEXT,
  description_updated_at TEXT, status TEXT NOT NULL, priority TEXT DEFAULT 'P2',
  position REAL, assignee TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);

CREATE TABLE dependency (
  from_task TEXT NOT NULL, to_task TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (from_task, to_task, type)
);

CREATE TABLE input_request (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT, answer_freeform INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', answer TEXT, answered_by TEXT,
  created_at TEXT NOT NULL, answered_at TEXT, expires_at TEXT
);

CREATE TABLE event (
  seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL,
  task_id TEXT, actor_type TEXT NOT NULL, payload TEXT NOT NULL
);
-- comment, acceptance_criterion, artifact, label, task_label: analogous.

CREATE INDEX idx_event_seq ON event(seq);
CREATE INDEX idx_ir_status ON input_request(status);
CREATE INDEX idx_task_status ON task(status) WHERE archived_at IS NULL;
```

Single-process server is the **sole writer**; WAL allows the UI's concurrent
reads. Transaction boundaries and `seq` allocation: see
[09-concurrency](09-concurrency.md).
