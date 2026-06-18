# 01 — Architecture

> **Summary:** KanAgentBan is an agent-first, local-first kanban board. A Claude
> Code agent drives it through a **kanban skill** that calls a thin **kanban CLI**,
> which speaks HTTP (localhost + bearer token) to a single **Node + TypeScript
> server**. The server is the **sole writer** to a per-board **SQLite** file
> (better-sqlite3, WAL), also hosts the static web UI, and pushes a WebSocket
> stream to the browser. The server does **zero LLM work** — all token curation is
> structural.
>
> **Decisions:** One Node process per board = the only writer (the core
> consistency lever). better-sqlite3 (synchronous) for writes; WAL for concurrent
> UI reads. One DB file per board under `.kanban/`. CLI is a stateless HTTP client
> emitting terse plaintext. Durable-async human-in-the-loop is the default.
>
> **Open questions:** REST vs thin RPC envelope (see
> [07-api-reference](07-api-reference.md)); single central DB vs one-file-per-board
> (current default: per-board, see [02-data-model](02-data-model.md)).

Related: [02-data-model](02-data-model.md) ·
[03-token-efficiency](03-token-efficiency.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md) ·
[07-api-reference](07-api-reference.md) ·
[09-concurrency](09-concurrency.md) ·
[10-security-lifecycle](10-security-lifecycle.md)

---

## 1. Component overview

```
┌─────────────────────┐
│  Claude Code agent  │   reasons; decides what to do next
└──────────┬──────────┘
           │ invokes
┌──────────▼──────────┐
│    kanban skill     │   teaches WHEN/HOW to use the board (06-skill)
└──────────┬──────────┘
           │ shells out
┌──────────▼──────────┐
│     kanban CLI      │   thin client; terse plaintext out (03, 05)
└──────────┬──────────┘
           │ HTTP  127.0.0.1:<port>  +  Authorization: Bearer <token>
┌──────────▼────────────────────────────────────────────────┐
│             Node + TypeScript server (per board)           │
│                                                            │
│   REST (Express/Fastify)      WebSocket (ws)               │
│   state · events · replay     push stream → browser        │
│   long-poll resolution        static web UI hosting        │
│                  MODEL-FREE — no LLM calls                 │
└──────────┬──────────────────────────────┬─────────────────┘
           │ better-sqlite3 (sync)         │ WS frames (seq-ordered)
┌──────────▼──────────┐          ┌─────────▼──────────┐
│   SQLite (WAL)      │          │   Web UI (browser) │
│  .kanban/<board>.db │          │  human view + input│
│  sole writer        │          │  request answers   │
└─────────────────────┘          └────────────────────┘
```

Three clients, one server, one file. The agent never touches SQLite directly —
every read and write goes through the HTTP API ([07-api-reference](07-api-reference.md)),
which is the *same* API the web UI uses.

---

## 2. Process model (the consistency lever)

- **One Node process per board, and it is the SOLE WRITER.** All mutations funnel
  through a single process, so there is no multi-writer contention and event `seq`
  allocation is trivially gap-free and total-ordered ([02-data-model §1](02-data-model.md),
  [09-concurrency](09-concurrency.md)).
- **better-sqlite3 is synchronous.** Each mutation is a synchronous transaction:
  apply the row change *and* append its `event` (allocating `seq`) atomically.
  No async write interleaving, no ORM write queue to reason about.
- **WAL mode enables concurrent reads.** The browser/UI and any read-only CLI
  calls read consistent snapshots while the single writer commits, with no reader
  blocking the writer or vice versa.
- **One DB file per board** under the project's `.kanban/` directory, keyed by
  `project_path`. Boards are isolated; there is no cross-board transaction.

This single-writer model is the key architectural choice that makes the event log
the authoritative, deterministic spine for realtime, delta sync, and audit.

---

## 3. Tech stack & rationale

| Layer | Choice | Why |
|-------|--------|-----|
| Server runtime | **Node + TypeScript** | Aligns with the Claude Code / skills ecosystem; one language across server, CLI, and UI; types pin the API/event contracts. |
| Storage | **better-sqlite3** | Synchronous, fast, embedded, file-based — ideal for a local single-writer with simple, deterministic transactions. WAL gives concurrent UI reads. |
| REST | **Express / Fastify** | Plain, debuggable request/response for the shared API ([07](07-api-reference.md)). |
| Realtime | **`ws`** | Lightweight WebSocket push to the browser; replay handshake is the same `seq > cursor` query as delta sync. |
| Web UI | **small static bundle** | Human view of the board + answering input requests; served by the same process. |
| CLI | **thin HTTP client** | Holds no state; emits terse, parseable plaintext budgeted in tokens ([03-token-efficiency](03-token-efficiency.md), [05-cli-reference](05-cli-reference.md)). |

The CLI deliberately contains no business logic beyond board resolution and
auto-start — all rules (readiness, ranking, truncation, validation) live in the
server so the contract is single-sourced.

---

## 4. Local-first rationale

- **No cloud dependency.** The whole system runs on the dev machine; nothing to
  provision, no account, free to run.
- **Data stays local & private.** Task state, comments, and artifacts (references
  only — never blobs, [02-data-model](02-data-model.md)) never leave the machine.
- **Instant & deterministic.** Localhost HTTP + synchronous SQLite means
  sub-millisecond reads and reproducible output — exactly what token-efficient,
  regex-parseable agent contracts need.
- **The trade-off:** no built-in multi-user or remote access. v1 buys
  **simplicity and deterministic, token-efficient behavior** by deferring remote
  access. Multiple **local** agents are supported post-v1 via `kanban claim` over
  the `assignee` field ([09 §9](09-concurrency.md)).

---

## 5. Responsibilities split

| Component | Owns | Explicitly does NOT |
|-----------|------|---------------------|
| **Server** | Authoritative state, the append-only event log, replay (`seq > cursor`), long-poll (`await`) resolution, static UI hosting | Any LLM/model work — it is **model-free** ([03 §9](03-token-efficiency.md)) |
| **CLI** | Thin HTTP client, board resolution (by `project_path`), server auto-start, terse plaintext output | Business logic, persistence, ranking |
| **Skill** | Teaches the agent *when* and *how* to use the board (decision trees for `next`, ask/await/yield) | Holding state |
| **Web UI** | Human view of columns/cards; answering open input requests; live re-render off WS | Writing outside the shared REST API |

The server being model-free is an invariant: every token optimization is
structural (tiers, counts, scoped deltas, deterministic truncation), keeping the
board fast, testable, and free while all model spend stays agent-side.

---

## 6. Sequence diagrams

Event types and endpoints below are defined canonically in
[02-data-model §3](02-data-model.md) and [07-api-reference](07-api-reference.md) —
referenced here, not redefined.

### 6.1 Create task

```
agent        CLI            server                 SQLite       UI (WS)
  │  kanban add │               │                     │            │
  ├────────────▶│ POST /api/tasks                     │            │
  │             ├──────────────▶│ txn: insert task    │            │
  │             │               ├── allocate T-n ─────▶│            │
  │             │               ├── append event ─────▶│            │
  │             │               │   (task.created, seq)│            │
  │             │               │◀── commit ──────────┤            │
  │             │◀──────────────┤ 201 {T-n}            │            │
  │◀────────────┤ "T-7"         ├── WS broadcast ─────────────────▶│
  │             │               │   {seq,type,task_id} │   renders  │
```

### 6.2 Request input → pause → resume (durable-async DEFAULT)

Default flow per [04-human-in-the-loop §3 (B)](04-human-in-the-loop.md): ask →
yield → resume from `inbox`. No connection is held across the human's wait.

```
agent             server              UI / human          (later) agent
  │ kanban ask T-12  │                    │                      │
  ├─────────────────▶│ POST input-requests│                      │
  │                  ├ create Q-7 (open)   │                      │
  │                  ├ T-12 → needs_input  │                      │
  │                  ├ append input.requested (seq)               │
  │◀─ "Q-7" (now) ───┤── WS broadcast ────▶│ shows "Needs input" │
  │                  │                    │                      │
  │ yields turn /    │                    │ human answers Q-7    │
  │ picks other work │                    │ (UI or kanban answer)│
  │                  │◀─ POST answer ──────┤                      │
  │                  ├ Q-7 → answered      │                      │
  │                  ├ T-12 needs_input clears → ready            │
  │                  ├ append input.answered (seq)                │
  │                  ├── WS broadcast ────▶│ card updates         │
  │                  │                    │                      │
  │                  │   kanban inbox  ◀───────────────────────── ┤
  │                  ├─ "Q-7 answered: Auth0; T-12 ready" ───────▶│
  │                  │   kanban context T-12 → resume work ◀───── ┤
```

A short blocking `await` (long-poll, [04 §3 (A)](04-human-in-the-loop.md)) is an
opt-in fast-gate alternative; on timeout it returns `pending` (exit 2), and the
skill falls back to this durable-async path.

### 6.3 Realtime update (any mutation)

Every mutation — move, comment, criterion check, answer, etc. — follows one shape:

```
any client ──▶ server: mutate
                  │ txn: row change + append event(type, seq)
                  │ commit
                  ├──▶ WS broadcast {seq, type, task_id, payload}
                  ▼
              browser dedupes by seq, re-renders affected card(s)
```

One in-process emitter feeds the WebSocket *and* resolves parked `await`
long-polls, so push, delta sync, and HITL wakeups share one `seq` ordering
([07 WebSocket protocol](07-api-reference.md)).

### 6.4 Delta sync / mid-task refresh

Mid-task, the agent wants only the scoped delta, not a full reload
([03 §7](03-token-efficiency.md)):

```
agent: kanban watch T-12 --since <seq>
   └──▶ GET /api/tasks/:id/watch?since=<seq>
          server: SELECT events WHERE seq > cursor
                  AND scope ∈ {T-12, its DIRECT deps}     (no transitive)
          ◀── events + new high-water seq
   agent stores new seq for the next watch

If the cursor is below the retained compaction floor:
   ◀── { reset: true, floor, cursor }     → agent does a full re-list
                                             (never a silent partial window)
```

Reserve board-wide `kanban changes --since <seq>` for "what changed anywhere";
most refreshes are single-task, so the cheap scoped path is the default.

---

## 7. Deployment & runtime

The server is invisible operationally — the skill/CLI manage its lifecycle. Detail
is deferred to [10-security-lifecycle](10-security-lifecycle.md); summary:

- **Auto-start:** the CLI/skill probes `GET /healthz`; if no server is up for the
  board, it starts one transparently before the first command.
- **Pidfile / port file:** the running process records its PID and chosen port so
  later CLI invocations discover the live endpoint.
- **One instance per board:** a lockfile guarantees a single server (hence single
  writer) per board, even across concurrent CLI calls or sessions.
- **Multi-board registry:** `~/.kanban/registry.json`, keyed by `project_path`,
  maps each project to its board, port, and bearer token so the CLI resolves the
  right server from any working directory.

See [10-security-lifecycle](10-security-lifecycle.md) for token issuance,
Origin/Host validation, lockfile semantics, and shutdown/cleanup.
