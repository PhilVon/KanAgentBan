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

Other agents can drive the same server over **MCP** (`kanban-mcp`, stdio) — a thin
client, not a second writer (see [docs/12-mcp.md](docs/12-mcp.md)).

## Status

**Scaffold + working vertical slice.** The full design lives in [`docs/`](docs/);
a runnable Node + TypeScript implementation of the core is in [`src/`](src/),
[`web/`](web/), and [`skill/`](skill/).

### Run it

The board's whole point is to run **inside your project directories** — the `kanban`
CLI walks up from the current folder to find the nearest `.kanban/` board. So the
command must be on your `PATH`, not invoked by file path. **`npm link` is integral
to how the board works**, not an optional convenience: it puts the `kanban` command
globally on `PATH` so Claude can shell out to it from any project.

```bash
# one-time, from the project root
npm install
npm run build      # compiles TypeScript to dist/
npm link           # puts the `kanban` command globally on PATH

kanban --help      # verify it resolves
```

`npm link` is reversible (`npm unlink -g kanagentban`) and ideal while iterating; for
a one-off global install instead, run `npm install -g .` from the project root. On
Windows, `npm link` creates a `kanban.cmd` shim on `PATH` that works the same in
PowerShell.

Then, **in any project where you want a board**:

```bash
# initialize a board in the current project, then drive it (server auto-starts)
kanban board init --name "My Project"
kanban add "Wire up OAuth callback" --prio P1 --status "In Progress"
kanban next
kanban open        # prints the web UI URL (with token) for the human
```

Dev mode without building (from the repo root): `npm run cli -- <args>` and
`npm run dev:server`.

For the full install/skill/walkthrough guide, see
**[GETTING-STARTED.md](GETTING-STARTED.md)**.

### Install the skill

The CLI is the surface; the **Claude Code skill** (`skill/SKILL.md`) is what makes
Claude reach for the board on its own — and asks the human through durable on-board
requests instead of vanishing chat-only questions. **Installing it is part of normal
setup, not optional.** Claude Code loads skills from a `skills/` directory where each
skill is a folder containing a `SKILL.md`; copy this repo's `skill/SKILL.md` into a
`kanban` folder under your Claude config.

**Personal skill** (available in every project):

PowerShell (Windows):

```powershell
$dest = "$env:USERPROFILE\.claude\skills\kanban"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item .\skill\SKILL.md $dest
```

bash (macOS/Linux):

```bash
mkdir -p ~/.claude/skills/kanban
cp skill/SKILL.md ~/.claude/skills/kanban/
```

**Project-scoped** (one repo only): put it at `.claude/skills/kanban/SKILL.md`
instead — use this to commit the skill alongside a project. Restart Claude Code (or
start a new session) so it picks up the skill.

### Driving the board with Claude

The skill triggers itself on **multi-step, dependency-laden, or cross-session** work
and deliberately **skips** trivial one-shot requests (forcing the board onto atomic
work is pure token overhead). You can also nudge it with phrases like *"track this"*,
*"plan this out"*, *"use the board"*, *"break this into tasks"*, or *"ask me and
continue."* If Claude isn't using it when you want, just say "plan this on the board
first."

Once it's running, Claude works the board itself — you mostly watch the realtime
[Web UI](#web-ui) (`kanban open`) and answer questions. A healthy session looks like:

```bash
kanban next --context              # load one task + its full working set in one call
kanban move T-12 "In Progress"     # status goes current on pickup
kanban criterion add T-12 "handles error responses"
kanban comment T-12 "chose Auth0 — Cognito needs a custom UI"   # records the decision
kanban done T-12                   # completion recomputes what's now unblocked
```

**The key behaviour to understand — Claude never freezes a turn waiting on you.**
When it needs a decision it raises a *durable* question and yields:

1. `kanban ask T-12 "Which auth provider?" --options Auth0,Cognito` → returns `Q-7`
   immediately and parks the task as *needs input*.
2. `kanban await Q-7 --timeout 60` → tries a short wait.
3. If you haven't answered, Claude **yields the turn** — picks up other ready work or
   ends cleanly ("Paused T-12 on Q-7, awaiting your input").

You answer at your leisure in the Web UI (or `kanban answer Q-7 "Auth0"`), which flips
the task back to *ready*. The next time Claude works the board — **even in a brand-new
session** — `kanban inbox` / `kanban next` surface it and it resumes with your answer.
So a paused task is normal and healthy, not stuck.

An opt-in [Stop hook](https://docs.claude.com/en/docs/claude-code/hooks) backstops
this: if a turn ends with a chat-only question while a task is *In Progress*, it nudges
Claude to use `kanban ask` instead. Wiring lives at `.claude/hooks/board-hitl-stop.js`
and the `hooks.Stop` block in `.claude/settings.json` (it fails open, never blocks you).

Full behavioural spec: [docs/06-skill.md](docs/06-skill.md). The skill's own
cheat-sheet is the canonical CLI quick reference (`skill/SKILL.md`).

### Icons (Font Awesome)

The web UI uses self-hosted Font Awesome, vendored into `web/vendor/` on install/build
(no CDN — works offline). **No Font Awesome account is required:** `npm install` pulls
**Font Awesome Free** from public npm by default and the UI uses only Free-available icons.

Have a **Pro** account and want the Pro set? Don't touch the committed `.npmrc` (it must
stay token-free). Copy [`.npmrc.pro.example`](.npmrc.pro.example) into your user-level
`~/.npmrc`, set `FONTAWESOME_PACKAGE_TOKEN`, and reinstall — the optional
`@fortawesome/fontawesome-pro` package is then preferred automatically. If neither resolves,
the UI degrades gracefully (labels/counts render, just without glyphs).

### Test

```bash
npm test          # vitest: 153 tests across 12 suites
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
- **Web UI** (`web/`): realtime board, "Needs your input" inbox, card drawer,
  analytics panel, and per-board project identity (see [Web UI](#web-ui) below).
- **Skill** (`skill/SKILL.md`): the Claude Code skill wrapping the CLI.
- **MCP server** (`src/mcp/`, post-v1): `kanban-mcp` exposes a curated ~21-tool
  subset over the Model Context Protocol (stdio) for non-skill agents — a thin
  client of the same sole-writer server. See [docs/12-mcp.md](docs/12-mcp.md).

Verified end-to-end (create → dep → next → ask → answer/await → done → recompute)
plus auth rejection and the pending-await exit code.

### Deferred (see [docs/11-roadmap](docs/11-roadmap.md))

Cloud sync / multi-machine, per-task time tracking and burndown/analytics.
(The MCP interface, external-nudge auto-resume, event-log compaction, first-class
subtasks, and input cancel/expiry have all shipped post-v1; basic `kanban export`
and multi-agent `claim` ship too — see above.)

## Web UI

The human's window into the board: a single-page, dark-themed app served by the
same sole-writer server at `http://127.0.0.1:<port>/` (open it with
`kanban open`, which prints the URL with the bearer token). It is
**read-mostly but write-capable** — all writes go through the REST API; the
WebSocket event stream is the source of truth and is event-routed to targeted DOM
updates (one card / inbox row / the open drawer per frame), so the board stays
live without polling.

- **Realtime board** — columns (`Backlog → Ready → In Progress → Review → Done`)
  plus a derived **Blocked** projection; drag-and-drop to move tasks between
  columns.
- **Card drawer** — full task detail with write surfaces: comments (agent + user),
  acceptance criteria, labels, artifacts, priority/assignee.
- **"Needs your input" inbox** — surfaces the agent's open input requests and lets
  the human answer them inline, resuming the paused task. Optional desktop
  notifications when the agent needs you.
- **Analytics panel** — throughput, WIP, flow efficiency, burndown, CFD and more
  (toggle with the 📊 button).
- **Create / filter** — add tasks from a modal; live filter by title, id,
  `@assignee`, or label.
- **Per-board project identity** — the board's name (from `.kanban/board.json`) is
  shown in the header and browser tab title, with a stable accent colour and a
  colour-coded favicon derived from the name, so several boards open at once are
  tellable apart at a glance.
- **Local + token-gated** — bound to `127.0.0.1` with a per-board bearer token
  (passed once via `?token=…`, then stashed in `localStorage` and stripped from
  the URL); Origin/Host checks block DNS-rebinding.

See [docs/08-web-ui.md](docs/08-web-ui.md) for the full spec.

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
| [12-mcp](docs/12-mcp.md) | The `kanban-mcp` MCP interface for non-skill agents |
| [adr/](docs/adr/README.md) | Architecture Decision Records |

## License

Licensed under the **Apache License, Version 2.0**. See [LICENSE](LICENSE) for the
full text. You may use, modify, and distribute this software under its terms,
including a grant of patent rights from contributors.
