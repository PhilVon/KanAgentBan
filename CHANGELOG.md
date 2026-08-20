# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
No versions are tagged or published yet: everything since the initial commit
lives under **Unreleased**. Convention: every PR appends one bullet to the
Unreleased section describing its change.

## [Unreleased]

### Added
- **Affect hints (opt-in, off by default) — `kanban board affect --on`.** The board
  emits a labelled `affect: eb consult …` line at the moments it knows a choice is
  being made (`brainstorm start`; `next` with 2+ ready candidates, capped at the
  four-option limit `eb` enforces; `claim`), and `context` prints a `cues:` line from
  the task's labels. **Text and nothing else** — the board never executes `eb`, never
  reads the brain, never stores a stance, never renders affect to the human (ADR 0009;
  EmotionalBrain ADR 0008 forbids the linkage form and leaves this door open). The
  point is the *writes*: labels become cue keys (`--map port=activity:port`, else
  `activity:<label>`), so the cue vocabulary is inherited rather than reinvented each
  session — cue sprawl is how a brain becomes useless. A task with no labels emits no
  cues, and `proj:` is refused (`eb` derives it from the cwd). Guard rails: always its
  own line, never folded into `why:`; never emitted by `ask` (framing the options was
  the decision) and never on `doctor`; sheds first under `--max-tokens`, never
  silently. Config is read per request, so `--on` needs no restart.
  FORMAT_VERSION 23→24 (T-103, 2026-08-20)
- **Answer notes: record *why*, not only *what*.** `answer` was a single TEXT field,
  so a decision came back as `lift-it` and the reasoning was lost — and answers get
  quoted in code comments, where the reasoning is the half a reader in six months
  actually needs. `kanban answer <Q-n> "<choice>" --note "<why>"` stores it (optional;
  blank is stored as none), the web inbox offers a quiet **why?** field beside every
  answer control, and it rides `input.answered` only when present. It renders wherever
  the answer does: under the answer in `inbox`, and in a new `decisions (n):` block in
  `show` (last 2) and `context` (last 3) — `Q-7 "…" → Postgres` with `why: …` beneath.
  A task with nothing answered renders exactly as before, and under a tight budget the
  block sheds with the open-input rung leaving a never-silent footer.
  SCHEMA_VERSION 12→13; FORMAT_VERSION 22→23 (T-102, 2026-08-20)
- **Criterion states: `retire`, `--human`, `amend`.** A criterion had exactly two
  states, so one that turned out to be *wrong* could only be ticked falsely, left
  unchecked forever, or escalated as a question the agent raised about its own
  planning error.
  - `kanban criterion retire <AC-n> --because "<why>" [--successor T-n]` — the third
    state. `--because` is **required** (the reason is the record). A retired criterion
    leaves **both** sides of the count, cannot be ticked, never blocks `done`, and is
    excluded from a `template save` blueprint. This is the exit for a **hypothesis**
    criterion the code disproves.
  - `kanban criterion add … --human` — only the person can settle it (a playtest,
    "does it read right?"). It stays in the denominator, but `doctor` names it apart
    from work the *agent* is failing to finish and the UI marks it *for you* — so an
    agent stops raising one `Q-n` per such criterion (six of one session's ten
    questions existed only to route these).
  - `kanban criterion amend <AC-n> "<text>"` — the text was write-once, so a badly
    typed criterion read that way permanently. Retire is for *wrong*, amend for
    *mistyped*.
  - Counting lives in one place (`derive.countCriteria`), and the count line grows its
    `· N retired` / `· N for the human` tails **only when non-zero** — an ordinary task
    still reads exactly `criteria 5/6`. `context` renders `[~] AC-n … — retired: <why>
    (→ T-n)` and `[human]`; the web drawer strikes a retired row through (no checkbox)
    and tags a human one. MCP `criterion` gains `op=retire|amend` and `human` on add.
  - SCHEMA_VERSION 11→12 (four defaulted/nullable columns — every existing criterion
    stays live, unretired and agent-checkable); FORMAT_VERSION 21→22 (T-100, 2026-08-20)
- **`kanban expect` — an event to wait for is not a question to answer.** `ask` had
  one shape and two jobs: a *question* is a decision with an answer to choose, and a
  *watch* ("tell me when the files land") has none. Written as an ask, a watch set
  `needs_input`, the UI derived **Blocked** from it, and it sat for days looking like
  something the human had failed to do — with every remedy `doctor` offered wrong for
  it (nudge: he knows; re-ask: resets a clock, changes no fact; cancel: throws away
  the trigger). `input_request` now carries a `kind` (`question` | `watch`):
  - a watch **does not set `needs_input`**, so the task is parked rather than Blocked
  - `inbox` lists watches under their own heading; `show`/`context` tag them `[watch]`
    and say they are not blocking; `standup` counts `watching` / `watch resolutions`
    apart from question traffic; the web inbox offers **It happened** / **Drop watch**
  - `doctor` never ages a watch as `ancient-ask`; the new `stale-watch` check fires
    only past 14 days and names its blind spot (it cannot see whether the event
    happened). `answered-elsewhere` stays about questions.
  - `answer` resolves a watch, `cancel` withdraws it, `--expires-at` drops it;
    `--options`/`--freeform` are **rejected** on a watch rather than ignored
  - MCP gains an `expect` tool (curated cap 30→31) so an MCP client is not left
    writing watches as questions
  - SCHEMA_VERSION 10→11 (one column with a DEFAULT — every existing row becomes a
    `question`, which is what it was); FORMAT_VERSION 20→21 (T-101, 2026-08-20)
- Three small ones (T-104, 2026-08-20):
  - **Loose search retry.** Bare terms are AND-ed, so a three-word guess returned
    nothing — expensive, because search is the first thing an agent runs on a cold
    board. When an all-terms query finds nothing, `search` retries OR-ranked and the
    result leads with `[loose: nothing matched every term of "…" — these match at
    least one, best first]`; `?json` carries `loose`. Never silent, and never
    applied to a single term or to a query carrying its own FTS syntax (quotes,
    `AND`/`OR`/`NOT`/`NEAR`, `*`, `^`, `:`, parens) — spelling the conjunction out is
    how you ask for strict. The LIKE fallback loosens too, ranked by terms matched.
    FORMAT_VERSION 19→20
  - `--description` as an alias of `--desc` on `add` and `update`. The description is
    the field worth rewriting once a symptom's cause is known, and the long spelling
    used to be `error: unknown option`.
  - `git link` now **notes** any commit whose subject names more than one task (five,
    then a count). Task and commit boundaries drift and nothing else reported it; it
    is a note about shape, never a refusal.
- `doctor` findings state **what their own check cannot see**: each line now carries
  a trailing `[cannot see: …]` clause (`blind_spot` under `--json`, a required field
  so a new check cannot forget it) and phrases its pre-written command
  conditionally. `done-eligible-parent` counts how many of the parent's *own*
  criteria are unchecked and reads "close only if those are met or retired" instead
  of the bare "close it:" that nearly closed a task whose criteria were unmet. New
  `answered-elsewhere` check flags an open `Q-n` on a task that is now Done or in
  Review — an answer given in chat and acted on but never written back leaves
  finished work reading as still waiting on the human; on a `Review` task the clause
  admits it cannot tell that from a legitimate sign-off gate. FORMAT_VERSION 18→19
  (T-99, 2026-08-20)
- `npm run install-skill`: sync `skill/` + `docs/` into
  `<CLAUDE_CONFIG_DIR>/skills/kanban/` (default `~/.claude`), removing files no
  longer in source and naming every removal. `-- --check` exits **2** on drift and
  **0** when the installed copy matches, so divergence is something you can check for instead
  of discover by losing work. Ships with the backport it made safe: two sections
  written straight into the installed `SKILL.md` on 19 Aug — *when a criterion is
  knowable* (promises vs hypotheses) and `--options`/`--freeform` as **companions,
  not alternatives** — existed only there, and are now in `skill/SKILL.md` and
  mirrored in `docs/06-skill.md` (T-97, 2026-08-20)
- Pace/age-aware analytics: `stats` time-series (burndown / throughput / CFD) now
  **auto-scale their bucket width** to the board's age (ladder `5m…7d`, ≤~32 points)
  so a hours-old board renders a readable multi-point series instead of one daily
  dot; `--window <days>` becomes an upper bound. Per-day rates normalize by the
  fractional span and render per-hour when brisk (`fmtRate`); the drain forecast
  gains hour-precision ETA; aging thresholds (fresh/stale) derive from the board's
  own completion tempo and are shared across `stats`/`doctor`/`standup` via
  `boardPace()` (never-silent — every aging line names the threshold and tags
  `(pace)`). New pure `src/server/pace.ts`; FORMAT_VERSION 17→18 (T-87, 2026-07-10)
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
- Checkpoint resume pointer: `kanban checkpoint T-n "did X, next Y, watch Z"`
  — one slot per task, latest wins, rendered first in `show`/`context` and
  flagged on `next`; never shed under token budget; `task.checkpointed` events;
  REST `/api/tasks/:id/checkpoint`, MCP `checkpoint` tool
  (SCHEMA_VERSION 6→7, FORMAT_VERSION 12→13) (#22)
- Claim leases: `kanban claim --ttl <seconds>` takes an auto-expiring lease;
  the server sweep (and lazy takeover at claim time) releases past-due leases
  with `task.released {expired:true}`, so a dead agent never wedges a task;
  holder re-claim = heartbeat renewal (no event); lease state on `context`'s
  assignee line (SCHEMA_VERSION 7→8, FORMAT_VERSION 13→14) (#23)
- Board doctor: `kanban doctor` — one read-only hygiene report (stale claims,
  criteria-less WIP, aging WIP, ancient open questions, stale summaries,
  Done-eligible parents), each finding naming its fix; exit 2 signals findings
  for session-start automation; REST `/api/doctor`, MCP `doctor` tool
  (FORMAT_VERSION 14→15) (#24)
- Default-on-expiry answers: `kanban ask --default X --expires-at ISO`
  resolves as `answered` at expiry (`answered_by: system:default`,
  `input.answered {defaulted:true}`, actor `system`) instead of dead-ending —
  agent stays unblocked when the human is away; flagged in `inbox`, `await`,
  and `context`'s open-input lines; human answer before the deadline wins
  (SCHEMA_VERSION 8→9, FORMAT_VERSION 15→16) (#25)
- First-class review gate: `kanban review approve/reject T-n --reason` +
  approve/reject buttons on the web UI's Review cards; reject requires a
  reason, recorded on the `task.moved` event (`{review, reason}`) and as a
  task comment; feeds existing kickback stats unchanged; REST
  `/api/tasks/:id/review`, MCP `review` tool (#26)
- Standup digest: `kanban standup [--since seq|--days N]` — narrative board
  diff (completed incl. review approvals, kickbacks with reasons, net moves,
  new tasks, question traffic incl. defaulted answers, aging list) for
  cold-start orientation; floor-clamped never-silently; REST `/api/standup`,
  MCP `standup` tool (FORMAT_VERSION 16→17) (#27)
- Bulk ops: `kanban move/done/archive/label` accept `T-1,T-2,…` — one
  server-side transaction, one event per task, all-or-nothing rollback on any
  bad id or guard failure; REST `POST /api/tasks/bulk`; MCP move/archive
  accept comma lists (#28)
- Auto-archive policy: `kanban board autoarchive --days N` — Done tasks
  untouched for N days archive on the server sweep (no restart; env override
  `KANBAN_AUTO_ARCHIVE_DAYS`); bottom-up subtree collapse, `task.archived`
  flagged `{auto:true}` (actor `system`) (#29)
- Task templates: `kanban template save <name> --from T-n / apply / list /
  show / delete` — reusable blueprints (priority, labels, criteria, subtask
  skeleton) applied atomically with `template.applied` provenance; REST
  `/api/templates`, grouped MCP `template` tool (SCHEMA_VERSION 9→10) (#30)

### Changed
- Docs swept to the end of the model-defect batch. The standing drift is that per-PR
  docs updates land while the *user-facing* set lags a batch, and this sweep found it
  in the obvious place: the pinned format version was quoted as `11` in `docs/03`, `8`
  in `docs/05` and `4` in `docs/07` — three different wrong numbers for one contract,
  all now `24`. `docs/11-roadmap` gains a §2.1 recording the batch finding-by-finding
  with its canon (SCHEMA 13, FORMAT 24, 470 tests / 38 suites, MCP 31 tools);
  `docs/04` gains answer notes and the answer-given-in-chat rule; `README` points at
  `npm run install-skill` instead of two hand-rolled copy recipes and shows `expect`,
  `--human`/`retire` and `answer --note` in the worked example (T-105, 2026-08-20)
- Skill: two agent-side failure modes written down where the board can enforce them.
  **An answer given in chat is not an answer** — when the human replies in
  conversation rather than on the card (most of the time, in a chat-plus-board
  setup), write it back with `kanban answer <qid> "…"` *before* acting on it, or the
  durable record and the thing acted on are two different objects and a question sits
  open beside finished, merged work. **Measure the numbers in an `ask`, or mark them
  as estimates** — a request renders every sentence with the same authority to a
  reader who cannot see where any of it came from, so an unmeasured figure reads as a
  fact; unmeasured ones carry *roughly* / *I estimate* in the sentence. Both in
  `skill/SKILL.md` and `docs/06-skill.md` (T-98, 2026-08-20)
- **Breaking (analytics response shape):** `stats` JSON time-series points are keyed
  by `t` (ISO 8601 UTC bucket start) instead of `date` (`YYYY-MM-DD`); `forecast.eta`
  is now a full ISO timestamp (with new `ms_to_drain`); `window` gains `span_ms`,
  `bucket_ms`, `bucket`, `buckets`, `clamped`; the `standup` report's aging entries
  carry `age_ms` instead of `age_days` and add a `pace` block. `doctor`'s `aging-wip`
  check is now pace-scaled, so fast boards that were "healthy" may newly exit `2` on
  it — the finding prints the (pace-based) threshold it used (T-87, 2026-07-10)

### Fixed
- `pace.test.ts` failed on 2 calendar days in every 14: the 365d fall-through
  assertion hard-coded `<= 53`, but `bucketRange` floors *both* edges over a span
  that is 365/7 = 52.14 weekly steps wide, so the count is 53 **or** 54 depending on
  where `now` sits inside the week. The bound is now derived (`ceil(span/step) + 1`)
  and swept across 14 consecutive day offsets, so it covers every phase of the week
  rather than whichever one the suite happens to run on. `pace.ts` is unchanged —
  the top rung is documented as bounded-but-over-target and behaved correctly
  (T-106, 2026-08-20)
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
