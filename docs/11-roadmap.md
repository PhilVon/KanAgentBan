# 11 — Roadmap

> **Summary:** A phased build plan from design → v1 → v2+. Phase 0 is this doc
> set; v1 (phases 1–5) ships the sole-writer server, the `kanban` CLI + skill, the
> realtime web UI, the token-efficiency contract, and hardening. Everything that
> would broaden the model — an MCP interface, log compaction, real subtasks, cloud
> sync, analytics — is deferred to v2+ so v1 stays small and correct.
> Multi-agent claiming, external-nudge auto-resume, first-class subtasks,
> event-log compaction, input-request cancel/expiry, and the **MCP server
> interface** have since shipped post-v1.
>
> **Decisions:** v1 = single agent, single local board, CLI-driven, sole writer.
> Model subtasks as deps + labels in v1. Build phases land in dependency order:
> data/event spine before CLI before UI before polish before hardening. The MCP
> interface shipped as a thin client of the same sole-writer server, not a second
> writer ([12-mcp](12-mcp.md)).
>
> **Open questions:** none outstanding for the agent interface — both CLI and MCP
> ship (MCP as the alternative for non-skill agents). Consolidated in §4. (Storage
> is **locked: one SQLite DB per project** at `.kanban/board.db`.)

Related: [00-overview](00-overview.md) · [03-token-efficiency](03-token-efficiency.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md) · [09-concurrency](09-concurrency.md)

---

## 1. Phases

### Phase 0 (now) — design

- Complete the design doc set (this set, `00`–`11`).
- Lock canonical terms: `T-n`, `Q-n`, `seq`, `ready` / `blocked_by_deps` /
  `needs_input`, working set, context tier ([00-overview §6](00-overview.md)).

### Phase 1 — core server + data model

- SQLite (WAL) schema: tasks, deps (DAG), comments, labels, artifacts,
  acceptance criteria, input_requests, events ([02-data-model](02-data-model.md)).
- Single-writer Node + TypeScript server over `better-sqlite3`; sole writer,
  concurrent UI reads ([01-architecture](01-architecture.md), [09-concurrency](09-concurrency.md)).
- Event log with gap-free monotonic `seq`, appended in the same transaction as
  every mutation.
- REST API for reads + writes ([07-api-reference](07-api-reference.md)).
- WebSocket broadcast off the event spine.

### Phase 2 — CLI + skill

- The `kanban` CLI: tiered read commands (`next`, `list`, `show`, `context`,
  `watch`/`changes`), write commands (add/move/comment/dep/label/artifact/criteria),
  and the input flow (`ask` / `await` / `inbox` / `answer`)
  ([05-cli-reference](05-cli-reference.md), [04-human-in-the-loop](04-human-in-the-loop.md)).
- Claude Code `SKILL.md`: when/how to climb context tiers and run the
  ask → await → yield → inbox loop ([06-skill](06-skill.md)).
- Auto-start the server on first CLI call + a board registry resolving the board
  for the current project path ([10-security-lifecycle](10-security-lifecycle.md)).

### Phase 3 — web UI

- Realtime board reflecting every event over WebSocket ([08-web-ui](08-web-ui.md)).
- Card drawer (criteria, deps, comments, artifacts, open `Q-n`).
- "Needs your input" inbox for answering open requests.
- Drag-drop status changes; in-browser notifications on new input requests.

### Phase 4 — token-efficiency polish

- Truncation contract: deterministic, never-silent, always a footer
  ([03-token-efficiency](03-token-efficiency.md)).
- ~~`--max-tokens` budgeting across tiers.~~ **Done** — honoured on `list` / `next`
  / `show` / `context`, each with never-silent footers (`FORMAT_VERSION 3`).
- Recommendation engine tuning for `next`, incl. sticky bias (prefer the
  in-progress task) to avoid context thrash.
- Summary-drift indicators flagging stale task summaries vs recent activity.

### Phase 5 — hardening

- Security: bind `127.0.0.1`, per-board token, `Origin` checks
  ([10-security-lifecycle](10-security-lifecycle.md)).
- Optimistic concurrency on writes (expected-`seq` / version guard).
- Schema migrations.
- Export / backup of a board.
- Test suite across server, CLI, and event replay.

---

## 2. v1 scope vs deferred

| Capability | v1 | v2+ |
|---|---|---|
| Sole-writer server + event spine (`seq`) | ✅ | |
| SQLite schema, REST, WebSocket | ✅ | |
| `kanban` CLI (tiered reads, writes, ask/await/inbox) | ✅ | |
| Claude Code `SKILL.md` | ✅ | |
| Realtime web UI + input inbox | ✅ | |
| Token budgeting + truncation contract | ✅ | |
| Local token auth, `Origin` checks, optimistic concurrency | ✅ | |
| Migrations, export/backup, tests | ✅ | |
| Dependency DAG + labels (subtask stand-in) | ✅ | |
| Answer-event hook designed (trigger not wired) | ✅ | |
| MCP server interface (alt. to CLI for other agents) | | ✅ (post-v1) |
| Multi-agent support + `kanban claim` | ✅ (post-v1) | |
| External-nudge auto-resume (webhook / local command) | ✅ (post-v1) | |
| Event-log compaction (retained floor `seq` + reset signal) | ✅ (post-v1) | |
| First-class subtasks (`parent_id` + rollup) | ✅ (post-v1) | |
| Input-request cancel + expiry (`input.cancelled` / `input.expired` fired) | ✅ (post-v1) | |
| Cloud sync / multi-machine | | ✅ |
| Per-task time tracking, burndown / analytics | | ✅ |

### Deferred to v2+ (detail)

- **MCP server interface** — ✅ **shipped post-v1.** `kanban-mcp` exposes the
  board over the Model Context Protocol (stdio) as an alternative to the CLI so
  non-Claude-Code agents can drive it. It is a **thin MCP client of the same
  sole-writer server** (reusing `connect()`/`api()`), never a second writer, with
  a curated ~21-tool subset of the CLI that preserves the token-efficiency and
  durable-async contracts ([12-mcp](12-mcp.md)).
- **Multi-agent support + `kanban claim`** — ✅ **shipped post-v1.** Atomic task
  claiming (`claim` / `release` / `claim --force`) so multiple agents share one
  board without stepping on each other; a claimed task drops out of other agents'
  `next`. Agent identity travels via `KANBAN_AGENT` / `--as`
  ([09-concurrency §9](09-concurrency.md)).
- **External-nudge auto-resume** — ✅ **shipped post-v1.** On `input.answered` the
  server fires an opt-in webhook and/or local command that a wrapper uses to
  re-invoke Claude Code — strategy (C) in
  [04-human-in-the-loop §3](04-human-in-the-loop.md). Transport decision:
  [adr/0006](adr/0006-external-nudge-transport.md).
- **Event-log compaction** — ✅ **shipped post-v1.** Bounds log growth by deleting
  events below a retained floor `seq` (kept in `meta.compaction_floor`), retaining
  the most recent `KANBAN_EVENT_RETENTION` events (default 50 000; a low-frequency
  server sweep + an explicit `kanban compact`). Safe because the server is
  model-free — state lives in the entity tables and is never rebuilt from events,
  so compaction loses only delta-replay history below the floor. A delta consumer
  whose cursor predates the floor gets a never-silent `{reset:true}` signal (REST)
  / `{type:'reset'}` WS frame and reseeds from current state instead of silently
  missing events ([07-api-reference](07-api-reference.md), [02-data-model §3](02-data-model.md)).
- **Subtasks** — ✅ **shipped post-v1.** True parent/child tasks via
  `task.parent_id` (single-parent tree, arbitrary depth, cycle-guarded), separate
  from the `blocks` DAG. Rollup semantics: a parent with open children is hidden
  from `next` and can't move to `Done` until they finish (`blocked_by_children`
  flag); archiving a parent with live children is refused. v1 had faked nesting
  with deps + a label ([00-overview §3](00-overview.md),
  [02-data-model §6](02-data-model.md)).
- **Cloud sync / multi-machine** — v1 is one local process on one machine.
- **Per-task time tracking, burndown / analytics** — reporting layer over the
  event log, out of v1.

---

## 3. Build order rationale

Phases land in dependency order: the data model + event spine (1) underpins the
CLI (2), which the skill and UI (3) both consume; token-efficiency polish (4)
tunes contracts the CLI already emits; hardening (5) layers security, concurrency
guards, and migrations once the surface is stable. Each phase is independently
demoable.

---

## 4. Open design questions

Consolidated from across the doc set; each blocks or shapes a later phase.

| Question | Raised in | Phase |
|---|---|---|
| ~~Default `--max-tokens` value~~ — **resolved: `2000` for the context tier** (opt out: `--full` / `--max-tokens 0`) | [03-token-efficiency](03-token-efficiency.md), [00-overview](00-overview.md) | 4 |
| ~~Ship a `--json` token meter~~ — **resolved: shipped** (`est_tokens`, format-version `2`) | [03-token-efficiency](03-token-efficiency.md) | 4 |
| ~~One DB per board vs a central DB~~ — **locked: one DB per project** (`.kanban/board.db`) | [02-data-model](02-data-model.md), [00-overview](00-overview.md) | 1 |
| ~~MCP vs CLI as the agent interface~~ — **resolved: both ship.** CLI is primary; MCP (`kanban-mcp`) is the alternative for non-skill agents, a thin client of the same server ([12-mcp](12-mcp.md)) | [00-overview](00-overview.md) | post-v1 |
| ~~External-nudge transport (webhook vs desktop notification)~~ — **resolved: both** (webhook + local command) | [04-human-in-the-loop](04-human-in-the-loop.md), [adr/0006](adr/0006-external-nudge-transport.md) | post-v1 |

---

## 5. Success criteria for v1

- [x] An agent can run a full task lifecycle through the CLI — create, set deps
      and criteria, move, comment, attach artifacts, complete. *(Validated
      end-to-end; `done` on a prerequisite correctly flips its dependent to `ready`.)*
- [x] The human sees every change in the web UI in realtime. *(Covered by the
      WebSocket broadcast/replay integration tests in `tests/server.test.ts`;
      eyeball with `kanban open`.)*
- [x] The ask → yield → `inbox` resume loop works **across sessions** — a
      question raised in one session is answered and picked up in a later one
      ([04-human-in-the-loop](04-human-in-the-loop.md)). *(`ask` → `await`
      timeout=pending/exit 2 → `answer` → fresh `inbox`/`next` resumes.)*
- [x] A cold-start context call (`kanban next --context` / `context T-n`) stays
      within a few hundred tokens ([03-token-efficiency](03-token-efficiency.md)).
      *(`est_tokens` 11–33 on a fresh task; default 2000 ceiling honoured.)*
