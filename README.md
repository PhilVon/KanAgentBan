# KanAgentBan

An **agent-first kanban board**. Unlike a normal board built for humans, the
**primary user is an AI agent** (Claude Code), with a human in the loop. The board
is the agent's external task memory and the agent↔human coordination surface; a
human watches and decides through a realtime web UI.

The flagship design goal: **deliver task context to the agent token-efficiently.**

## What it does

- The agent **creates and tracks tasks** through a thin `kanban` CLI wrapped by a
  Claude Code skill.
- The human **views the board in realtime** in a browser (WebSocket).
- The agent can **request user input on a task and pause it** until the human
  answers — a durable, async request the agent yields on, resumable across sessions.
- Featureful: dependency DAG, comments (agent + user), labels, artifacts,
  acceptance criteria.

## Architecture (one line)

`Claude Code → kanban skill → kanban CLI → (HTTP 127.0.0.1 + token) → Node+TS
single sole-writer server (REST + WebSocket + static UI + SQLite/WAL) → WebSocket → browser UI`

## Status

**Scaffold + working vertical slice.** The full design lives in [`docs/`](docs/);
a runnable Node + TypeScript implementation of the core is in [`src/`](src/),
[`web/`](web/), and [`skill/`](skill/).

### Run it

```bash
npm install
npm run build

# initialize a board in the current project, then drive it (server auto-starts)
node dist/cli/kanban.js board init
node dist/cli/kanban.js add "Wire up OAuth callback" --prio P1 --status "In Progress"
node dist/cli/kanban.js next
node dist/cli/kanban.js open      # prints the web UI URL (with token) for the human
```

Dev mode without building: `npm run cli -- <args>` and `npm run dev:server`.

### Test

```bash
npm test          # vitest: 77 tests across 6 suites
```

- `tests/repo.test.ts` — data layer: ids, DAG (self/dup/cycle rejection), the
  two-flag derived state, event log + `seq`, scoped `watch`, HITL answer
  validation, inbox, optimistic concurrency, summary drift.
- `tests/recommend.test.ts` — `next` ranking, blocked-summary reasons, sticky bias.
- `tests/render.test.ts` — output contract: section order, criteria progress,
  direct-deps-only, never-silent truncation footers, token budgeting, stale summary.
- `tests/server.test.ts` — HTTP/WS integration: auth (401) + Origin (403) + Host
  (403, DNS-rebinding) + foreign-Origin WS (4403), task lifecycle, 409 on stale
  write, the long-poll `await` race (parked → woken) for single/`--task`/`--any`
  scopes, 204 on timeout, `--json` structured reads, `export` snapshot, WebSocket
  replay + live stream, bad-token rejection.

### What's implemented

- **Data layer** (`src/server/`): SQLite/WAL schema, per-board counters, append-only
  event log with `seq`, two-flag derived state (`blocked_by_deps` / `needs_input` /
  `ready`), dependency DAG with cycle rejection.
- **Server**: REST API + WebSocket broadcast + long-poll `await` + static UI host;
  localhost-only with per-board bearer token and Origin checks; auto port/pid files.
- **CLI** (`src/cli/`): the `kanban` command surface, board resolution, server
  auto-start, terse plaintext output + semantic exit codes.
- **Multi-agent claiming** (post-v1): `kanban claim` / `release` (`--force` to
  steal) reserve a task via `assignee` so it drops out of other agents' `next`;
  identity via `KANBAN_AGENT` / `--as`. See [docs/09 §9](docs/09-concurrency.md).
- **Token-efficiency renderers** (`src/server/render.ts`): `next`, `list`, `show`,
  `context` with deterministic, never-silent truncation; recommendation engine.
- **Web UI** (`web/`): realtime board, "Needs your input" inbox, card drawer.
- **Skill** (`skill/SKILL.md`): the Claude Code skill wrapping the CLI.

Verified end-to-end (create → dep → next → ask → answer/await → done → recompute)
plus auth rejection and the pending-await exit code.

### Deferred (see [docs/11-roadmap](docs/11-roadmap.md))

MCP interface, external-nudge auto-resume, event-log compaction, first-class
subtasks, schema migrations beyond v1. (Basic `kanban export` ships now;
multi-agent `claim` shipped post-v1 — see above.)

## Documentation

Start with **[docs/00-overview.md](docs/00-overview.md)**, then read in order:

| Doc | Description |
|-----|-------------|
| [00-overview](docs/00-overview.md) | Problem, goals, personas, architecture, glossary, traceability |
| [01-architecture](docs/01-architecture.md) | Process model, components, flows, deployment |
| [02-data-model](docs/02-data-model.md) | Entities, IDs, event spine, derived state, schema |
| [03-token-efficiency](docs/03-token-efficiency.md) | **Flagship** — tiered reads, working-set spec, truncation contract |
| [04-human-in-the-loop](docs/04-human-in-the-loop.md) | **Flagship** — durable input requests, pause/resume across sessions |
| [05-cli-reference](docs/05-cli-reference.md) | The `kanban` CLI: commands, flags, output contract, exit codes |
| [06-skill](docs/06-skill.md) | The Claude Code `SKILL.md`: when/how the agent uses the CLI |
| [07-api-reference](docs/07-api-reference.md) | REST + WebSocket endpoints |
| [08-web-ui](docs/08-web-ui.md) | The human's realtime browser board |
| [09-concurrency](docs/09-concurrency.md) | Sole-writer model, transactions, `seq`, replay |
| [10-security-lifecycle](docs/10-security-lifecycle.md) | Local token auth, board resolution, lifecycle |
| [11-roadmap](docs/11-roadmap.md) | Phased build plan; v1 vs deferred (v2+) |
| [adr/](docs/adr/README.md) | Architecture Decision Records |
