# 00 — Overview

> **Summary:** KanAgentBan is a kanban board whose **primary user is an AI agent**
> (Claude Code), with a human in the loop. The board is the agent's external task
> memory and the agent↔human coordination surface. A single local Node+TypeScript
> server owns a SQLite (WAL) database and is the sole writer; the agent drives it
> through a thin `kanban` CLI wrapped by a Claude Code skill, while the human
> watches and decides through a realtime web UI. The flagship goal is delivering
> task context to the agent **token-efficiently**.
>
> **Decisions:** Agent-first, not human-first. One local sole-writer process per
> board. CLI is a thin client over a local REST + WebSocket server. Human input is
> a durable, async request the agent yields on — not a held connection. Everything
> the agent reads is tiered and budgeted in tokens. Subtasks and multi-agent
> claiming are out of v1.
>
> **Open questions:** Default `--max-tokens`; external-nudge transport for v2
> auto-resume (see [04-human-in-the-loop](04-human-in-the-loop.md)). (Storage is
> **locked: one SQLite DB per project** — see [02-data-model](02-data-model.md).)

Related: [01-architecture](01-architecture.md) · [02-data-model](02-data-model.md) ·
[03-token-efficiency](03-token-efficiency.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md) · [05-cli-reference](05-cli-reference.md)

---

## 1. The problem

Normal kanban boards assume a **human** is the primary user: they are built for
dragging cards with a mouse, scanning dense visual columns, and reading prose. An
AI coding agent is a different kind of user — it has no eyes on a screen, it pays
for every token it reads, it works in bounded turns, and it loses its working
memory between sessions.

KanAgentBan inverts the assumption. The **agent is the primary user** and the
board is its:

- **External task memory** — durable state the agent offloads to and reloads the
  *relevant slice* of cheaply, instead of carrying the whole project in context.
- **Coordination surface** — where the agent records progress, raises questions
  for the human, and picks up the human's answers, possibly in a later session.

The human is still essential, but as a **reviewer, decider, and viewer**, not as
the one doing data entry.

---

## 2. Goals

1. **Agent creates & tracks tasks** — the agent owns the board: it adds tasks,
   sets dependencies and acceptance criteria, moves cards, comments, and records
   artifacts, all via the CLI ([05-cli-reference](05-cli-reference.md)).
2. **Human views the board in realtime** — a browser UI reflects every change as
   it happens over WebSocket ([08-web-ui](08-web-ui.md)).
3. **Agent can request user input and pause** — the agent raises a durable input
   request on a task, which becomes `needs_input` until the human answers; the
   agent yields its turn rather than blocking ([04-human-in-the-loop](04-human-in-the-loop.md)).
4. **Featureful** — a dependency DAG, comments (agent + user), labels, artifacts,
   and acceptance criteria are all first-class ([02-data-model](02-data-model.md)).
5. **Claude Code skill over a CLI** — a `SKILL.md` teaches the agent when and how
   to use the thin `kanban` CLI ([06-skill](06-skill.md)).
6. **PRIMARY GOAL — token-efficient context delivery** — every read is tiered,
   counts-over-contents, scoped to a delta where possible, and budgeted in tokens
   with deterministic, never-silent truncation ([03-token-efficiency](03-token-efficiency.md)).

---

## 3. Non-goals (v1)

- **Multi-tenant / cloud** — single local process, single user's machine.
- **Auth beyond a local token** — a per-board token over `127.0.0.1`, nothing more
  ([10-security-lifecycle](10-security-lifecycle.md)).
- **Real-time collaboration cursors** — the UI broadcasts state, not presence.
- **Subtasks** — model nesting with dependencies + a label, keeping the DAG flat
  ([02-data-model §6](02-data-model.md)).
- **Mobile app** — desktop browser only.
- **Multi-agent claiming** — single agent in v1; the `assignee` field is reserved
  for v2 ([11-roadmap](11-roadmap.md)).

---

## 4. Personas

| Persona | Role | Primary surface |
|---------|------|-----------------|
| **The Agent** (Claude Code) | **Primary user.** Creates and tracks tasks, raises input requests, resumes from board state. | `kanban` CLI via the skill |
| **The Human** | Reviewer / decider / viewer. Watches progress, answers the agent's questions, comments, reprioritizes. | Web UI (browser) |

The agent optimizes for tokens and reliability; the human optimizes for glanceable
realtime state and low-friction decisions.

---

## 5. High-level architecture

```
  ┌──────────────┐
  │  Claude Code │   the agent (primary user)
  └──────┬───────┘
         │ invokes
         ▼
  ┌──────────────┐
  │ kanban skill │   SKILL.md — when/how to use the CLI (06-skill)
  └──────┬───────┘
         │ shells out
         ▼
  ┌──────────────┐
  │  kanban CLI  │   thin client; auto-starts the server (05-cli-reference)
  └──────┬───────┘
         │ HTTP, 127.0.0.1 + per-board token
         ▼
  ┌─────────────────────────────────────────────────────────┐
  │  Node + TypeScript server  (single, sole-writer process) │
  │                                                           │
  │   REST API  ─┐                                            │
  │   WebSocket ─┤── one event spine (seq) ──▶ broadcast      │
  │   static UI host                                          │
  │   better-sqlite3  ──▶  SQLite (WAL): sole writer,         │
  │                        concurrent UI reads                │
  └───────────────────────────────┬───────────────────────────┘
         WebSocket (push events)   │
                                   ▼
                          ┌──────────────┐
                          │   Web UI     │   browser — the human
                          └──────────────┘
```

Key properties (detailed in [01-architecture](01-architecture.md) and
[09-concurrency](09-concurrency.md)):

- **One process, sole writer.** The Node server is the only writer to the SQLite
  DB; WAL mode lets the UI's reads run concurrently.
- **One event spine.** Every mutation appends one event with a monotonic `seq`
  inside the same transaction; that log powers WebSocket broadcast, CLI deltas
  (`watch`/`changes`), and `inbox` ([02-data-model](02-data-model.md)).
- **Model-free server.** No LLM work happens server-side — all token curation is
  structural ([03-token-efficiency](03-token-efficiency.md)).
- **Local-only.** Server binds `127.0.0.1` and requires a per-board token
  ([10-security-lifecycle](10-security-lifecycle.md)).

---

## 6. Glossary

- **board** — one project's kanban state, one SQLite DB per project path.
- **task** — a unit of work (`T-n`); the central entity, carries status, priority,
  summary, criteria, deps, comments, artifacts.
- **dependency / DAG** — a `blocks` edge from a dependent task to its prerequisite;
  all dependencies form a directed acyclic graph (cycles rejected at insert).
- **blocked_by_deps** — derived flag: a task has an unfinished `blocks`
  prerequisite ([02-data-model §5](02-data-model.md)).
- **needs_input** — derived flag: a task has an open input request.
- **ready** — derived: not `blocked_by_deps`, not `needs_input`, in an actionable
  status; the only candidates the `next` engine considers.
- **input_request (`Q-n`)** — a durable question raised by the agent for the human;
  parks the task as `needs_input` until answered ([04-human-in-the-loop](04-human-in-the-loop.md)).
- **event / seq** — an append-only record of one mutation; `seq` is the per-board,
  gap-free, monotonic cursor that orders the whole system.
- **working set** — the curated slice of a task an agent needs to act on it
  (criteria, direct deps, open questions, recent comments, artifacts, labels).
- **context tier** — a read level from cheap to rich (`next` → `list` → `show` →
  `context`); the agent climbs only as far as it needs.
- **tier / progressive disclosure** — the principle that each tier is a strict
  superset of the previous, so detail is opt-in, not default
  ([03-token-efficiency](03-token-efficiency.md)).
- **artifact** — a *reference* (link, file path, PR, output) attached to a task;
  never the contents.
- **acceptance criterion (`AC-n`)** — a first-class checklist row on a task,
  rendered as a cheap `3/5` count.

---

## 7. Requirements traceability

Each of the six core requirements (§2) maps to the doc(s) that specify it.

| # | Requirement | Covered by |
|---|-------------|------------|
| 1 | Agent creates & tracks tasks | [02-data-model](02-data-model.md), [05-cli-reference](05-cli-reference.md), [06-skill](06-skill.md), [07-api-reference](07-api-reference.md) |
| 2 | Human views the board in realtime | [08-web-ui](08-web-ui.md), [01-architecture](01-architecture.md), [07-api-reference](07-api-reference.md) |
| 3 | Agent requests user input & pauses | [04-human-in-the-loop](04-human-in-the-loop.md), [02-data-model](02-data-model.md), [05-cli-reference](05-cli-reference.md) |
| 4 | Featureful (DAG, comments, labels, artifacts, criteria) | [02-data-model](02-data-model.md), [08-web-ui](08-web-ui.md) |
| 5 | Claude Code skill wrapping a CLI | [06-skill](06-skill.md), [05-cli-reference](05-cli-reference.md) |
| 6 | Token-efficient context delivery (primary) | [03-token-efficiency](03-token-efficiency.md), [05-cli-reference](05-cli-reference.md), [09-concurrency](09-concurrency.md) |

---

## 8. Document map

| Doc | Description |
|-----|-------------|
| [00-overview](00-overview.md) | Problem, goals, personas, architecture, glossary, traceability (this doc). |
| [01-architecture](01-architecture.md) | Process model, components, request/broadcast flow, deployment. |
| [02-data-model](02-data-model.md) | Entities, IDs, event spine, derived state, SQLite schema. |
| [03-token-efficiency](03-token-efficiency.md) | Tiered reads, working-set spec, token budgeting & truncation contract. |
| [04-human-in-the-loop](04-human-in-the-loop.md) | Durable input requests, pause/resume, cross-session resumption. |
| [05-cli-reference](05-cli-reference.md) | The `kanban` CLI: commands, flags, output contract, exit codes. |
| [06-skill](06-skill.md) | The Claude Code `SKILL.md`: when/how the agent uses the CLI. |
| [07-api-reference](07-api-reference.md) | REST + WebSocket endpoints the CLI and UI consume. |
| [08-web-ui](08-web-ui.md) | The human's realtime browser board and input-answering UX. |
| [09-concurrency](09-concurrency.md) | Sole-writer model, transactions, `seq` allocation, event replay. |
| [10-security-lifecycle](10-security-lifecycle.md) | Local token auth, board resolution, init/export lifecycle. |
| [11-roadmap](11-roadmap.md) | Deferred features: multi-agent, external nudge, subtasks, v2+. |
