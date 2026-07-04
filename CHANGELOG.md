# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
No versions are tagged or published yet: everything since the initial commit
lives under **Unreleased**. Convention: every PR appends one bullet to the
Unreleased section describing its change.

## [Unreleased]

### Added
- Multi-agent task claiming: `kanban claim` / `release`, claimed tasks hidden
  from other agents' `next` (`8e2b93a`, 2026-06-18)
- External-nudge auto-resume: webhook or local command fired on
  `input.answered` (`a6ca8b5`, 2026-06-18)
- Token-efficiency budgeting: graceful truncation, `est_tokens` meter, default
  `context` budget; `--max-tokens` extended to `list`/`next`/`show`
  (FORMAT_VERSION 2→3) (`9450b95`, `5d149c6`, 2026-06-18)
- First-class subtasks: `parent_id` nesting + parent rollup (`cc65738`,
  2026-06-18)
- Event-log compaction: retained floor + never-silent reset for stale cursors
  (`262b544`, 2026-06-18)
- Input-request cancel + expiry: `input.cancelled` / `input.expired`, 60s
  sweep, inbox `resolved` bucket (FORMAT_VERSION 4) (`2dc4b36`, 2026-06-18)
- MCP server interface: `kanban-mcp` stdio server as a thin client of the
  sole-writer server, ~21 curated tools (`24b6b05`, 2026-06-18)
- User comments as a protected inbound directive channel: shed-last under
  token budgets, `next`/`list` callouts (FORMAT_VERSION 5→6) (`6fd4461`,
  2026-06-19)
- Analytics: per-task timing + board stats wired into CLI, REST, and the web
  metrics panel (FORMAT_VERSION 5), then Tier 1+2+3 expansion — flow
  efficiency, input wait, net flow, aging, rework, by-priority/label/agent,
  forecast, CFD (FORMAT_VERSION 7) (`319a3ad`, `cd9a20e`, 2026-06-19)
- Web UI: event-routed realtime + drawer write surfaces (`ae5448c`),
  dark-theme polish (`eb03d89`), per-board project identity (`ce7138c`),
  archive-all on Done + vendored Font Awesome (`4360b9a`) (2026-06-19)
- HITL enforcement: skill + Stop-hook backstop steering agents to
  `kanban ask` instead of chat-only questions (`08def89`, 2026-06-19); valid
  workflow columns enforced server-side + skill reinforced (`11c5407`,
  2026-06-25)

- GitHub Actions CI: build + test on ubuntu (node 20/22) and windows
  (node 20) (#9)
- Per-status dwell/bottleneck + velocity trend in `stats` (FORMAT_VERSION 8)
  (#11)
- `stats` MCP tool: board analytics + per-task timing in the read ladder (#12)
- Web activity-log panel: paged `/api/ui/activity`, live prepend,
  compaction-floor banner (#13)
- Web dependency-graph panel: layered SVG over `/api/ui/graph` (#14)
- Web filter token grammar: `status:`/`p0`–`p3`/`label:`/`@`/`is:` +
  description/summary search (#15)
- `kanban completion bash|zsh|pwsh`: static scripts introspected from the live
  CLI (#16)
- `kanban watch/changes --follow`: NDJSON streaming over the WebSocket with
  reconnect + never-silent reset passthrough (#17)
- Board-native docs: `doc` entity (design/adr/spike/research/note, D-n) with
  markdown bodies stored on the board (ADR 0007; 64 KB cap), many-to-many task
  links, lifecycle statuses incl. supersession; `kanban doc`/`docs` CLI, REST
  `/api/docs`, grouped MCP `doc` tool, `context` docs section, web Docs panel
  (SCHEMA_VERSION 3→4, FORMAT_VERSION 8→9) (#18)
- Board-wide search: FTS5 index over tasks/docs/comments kept in sync by SQL
  triggers with one-time backfill and a guarded LIKE fallback
  (`meta.fts_enabled`); bm25-ranked snippets via `kanban search`, REST
  `/api/search`, MCP `search` tool, and a web Search panel
  (SCHEMA_VERSION 4→5, FORMAT_VERSION 9→10) (#19)
- Brainstorm sessions: capture ideas (B-n/I-n) with free-form clusters and 0–10
  scores, promote winners to tasks atomically (provenance recorded), one-way
  discard; `kanban brainstorm`/`idea` CLI, REST `/api/brainstorms` +
  `/api/ideas`, grouped MCP `brainstorm` tool, `context` open-session anchor,
  web Brainstorm panel with human scoring/promote; ideas join board search
  (SCHEMA_VERSION 5→6, FORMAT_VERSION 10→11) (#20)
- Git linkage (ADR 0008 — all git/gh execution CLI-side, server never shells
  out): artifact kinds `commit`/`branch` with `git:<sha>`/`branch:<name>` URIs
  and idempotent `addArtifact` on (task, kind, uri); `kanban git link`
  (T-n mention scanner), `git branch` (conventional `T-n-slug`), `git status`
  (live PR/CI via `gh` on demand, never stored), `git install-hooks`
  (prepare-commit-msg + fire-and-forget post-commit); no schema change
  (FORMAT_VERSION 11→12) (#21)

### Fixed
- Repeated `--label`/`--depends` on `kanban add` and `--options` on
  `kanban ask` now accumulate instead of silently keeping only the last
  value (#8)
- Flaky `ui.test.ts` teardown race (unhandled ECONNRESET rejection) (#9)
- Archived tasks no longer resurrect in the Done column (`256dee3`,
  2026-06-19)
- Stats window clamped to project age; task description rendered (`79f8d06`,
  2026-06-19)

## [0.1.0] - 2026-06-18

### Added
- Initial agent-first kanban board: `kanban` CLI, sole-writer server (REST +
  WebSocket + SQLite event log), token-efficient tiered reads, durable
  human-in-the-loop input requests, dependency DAG, acceptance criteria,
  labels, artifacts, and realtime web UI (`d5817c4`)
