# 08 — Web UI (Human-Facing)

> **Summary:** A single-page web app that gives the human a **live** view of the
> board and a fast path to answer the agent's questions. It is a thin client over
> the REST + WebSocket contract in [07-api-reference](07-api-reference.md): all
> writes go through REST and reconcile from the broadcast event stream. The agent
> rarely touches this UI — it lives in the CLI — so the UI is optimized for *one*
> job: watch, and unblock.
>
> **Decisions:** REST for every mutation; never write to local state as the source
> of truth — the event stream is. `Blocked` is a *derived projection*
> ([02-data-model §4–5](02-data-model.md)), not a draggable target. The
> "Needs your input" inbox is a first-class, always-visible panel. Reconnect uses
> the no-gap replay (`?since=<seq>`, dedupe by `seq`) from
> [07](07-api-reference.md). One-time token URL minted by `kanban open`.
>
> **Open questions:** Whether to persist optimistic edits across a `{reset:true}`
> reload (current: discard and re-fetch). Multi-board switcher (deferred to v2).

Related: [02-data-model](02-data-model.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md) ·
[07-api-reference](07-api-reference.md) · [09-concurrency](09-concurrency.md) ·
[10-security-lifecycle](10-security-lifecycle.md)

---

## 1. Purpose & non-goals

The UI exists so a human can **watch the board update in realtime** and **answer
input requests without hunting** for the task that raised them. The agent works
through the CLI ([05-cli-reference](05-cli-reference.md)) and the skill
([06-skill](06-skill.md)); it is not expected to drive the UI. Accordingly:

- **In scope:** live board, the "Needs your input" inbox, card detail, drag-drop
  moves, comments, answering questions, ticking acceptance criteria.
- **Out of scope:** authoring complex tasks, bulk editing, board configuration,
  rendering artifact *contents* (we show references only —
  [02-data-model §artifact](02-data-model.md)).

---

## 2. Layout — the column board

A horizontal column board over the default statuses
([02-data-model §4](02-data-model.md)):

```
Backlog   Ready   In Progress   Blocked   Review   Done
```

`Blocked` is **special**: it is a *projection* the UI computes for any task where
`blocked_by_deps OR needs_input` ([02-data-model §5](02-data-model.md)). The
engine never sets `status = Blocked`; a card shown in Blocked still carries its
real workflow status (e.g. `In Progress`) underneath, and returns to that column
when it unblocks. Therefore **Blocked is not a valid drop target** (§6).

### Card

Each card is a compact summary keyed by its public id:

- **`T-n`** id + **title**.
- **Priority** chip: `P0`..`P3` (P0 highest — [02-data-model §task](02-data-model.md)).
- **Labels** (name + color).
- **Status flag icons** (right-aligned, only shown when set):
  - 🔒 **dep-blocked** — `blocked_by_deps` true (one or more `blocks`
    prerequisites not yet Done).
  - ❓ **needs-input** — `needs_input` true (≥1 `open` input request). **This is
    the important one** — it is what tells the human the agent is waiting, and it
    is mirrored in the inbox (§4). Visually emphasized over the others.
  - 💬 **unread comments** — count of comments newer than the human's last view
    of the card (badge with the number).
  - ⊞ **subtasks `d/t`** — on a parent: how many of its children are Done
    (`blocked_by_children` keeps it out of `next` until `d == t`).
  - ⤷`T-parent` **subtask-of** — on a child: a link/badge to its parent task
    ([02-data-model §6](02-data-model.md)).

Cards are ordered within a column by `position`
([02-data-model §task](02-data-model.md)).

---

## 3. "Needs your input" inbox

A prominent, always-visible panel (sidebar or pinned top bar) that lists **every
`open` input request across the whole board**, so the human can answer in one
place without opening each card. This is the UI half of the human-in-the-loop
flow in [04-human-in-the-loop](04-human-in-the-loop.md).

Each row shows:

- **`Q-n`** + the originating **`T-n`** (and task title).
- The **question** text.
- **Options** as buttons when `options` is set; a free-text field when `options`
  is null *or* `answer_freeform` is true
  ([02-data-model §input_request](02-data-model.md)).

**Answering** issues `POST /api/input-requests/:qid/answer`
([07-api-reference](07-api-reference.md)). On success the server records the
answer, flips the task's `needs_input` → ready, and broadcasts `input.answered`;
the UI removes the row when that event arrives (not optimistically — §6). Any
parked `kanban await` resolves off the same emitter
([04 §6](04-human-in-the-loop.md), [09-concurrency](09-concurrency.md)).

Constrained answers are validated server-side (answer ∈ `options`); the UI
mirrors the constraint by offering buttons, but the server is authoritative.

### Metrics / burndown panel

A **📊 Metrics** toggle in the header opens a panel backed by `GET /api/stats?json`
([13-analytics](13-analytics.md)): metric tiles (throughput, lead/cycle p50·p90,
WIP-per-column with aging) and an inline-SVG **burndown** chart (remaining vs done
vs created over the window — no external chart library). It refetches on each
WebSocket frame while open, and shows a bounded-history banner when
`partial_history` (some tasks predate the compaction floor).

---

## 4. Card detail drawer

Opening a card slides in a drawer backed by `GET /api/tasks/:id?view=show`
([07](07-api-reference.md)). Sections:

- **Description** — markdown, long form.
- **Summary** — the token-cheap `summary`. Show a **`[summary may be stale]`**
  indicator when `description_updated_at > summary_updated_at`
  ([02-data-model §task](02-data-model.md)) — the description changed after the
  summary was last written.
- **Acceptance criteria** — a checklist with a **`x/y` progress** count. Each
  item toggles via `PATCH /api/criteria/:acid` (`criterion.checked` /
  `criterion.unchecked`).
- **Parent** — when the task is a subtask, a `⤷ parent: T-p` link that opens the
  parent's drawer.
- **Subtasks** — a **`d/t`** count and the list of children (id, title, status);
  each row opens that child's drawer. A **+ Subtask** field creates a child via
  `POST /api/tasks {parent}`. A parent can't be dragged to `Done` until its
  children are Done ([02-data-model §6](02-data-model.md)).
- **Dependencies** — two lists with each entry's status:
  - **Blockers** (this task is blocked by →): the `to_task`s; flagged until each
    is `Done`.
  - **Blocked-by-this** (depends on this →): the `from_task`s that wait on it.
  - ([02-data-model §dependency/§5](02-data-model.md).)
- **Comments thread** — chronological; `agent` / `user` / `system` distinguished
  by `author_type`/`author_name`. The human can add a comment as **`user`** via
  `POST /api/tasks/:id/comments`. `system` lines (moves, status changes) may be
  collapsed to a count ([02-data-model §comment](02-data-model.md)).
- **Open input requests** — answerable **inline** (same `answer` endpoint as the
  inbox), so the human can act in context as well as from the global panel.
- **Artifacts** — **title + link only** (`kind`, `title`, `uri`). Never fetch or
  inline contents ([02-data-model §artifact](02-data-model.md)).

---

## 5. Realtime behavior

The UI holds an open WebSocket:

```
ws://127.0.0.1:<port>/ws?since=<seq>&token=<t>
```

- On first load it connects with `since=0` (or the board high-water `seq` from
  `GET /api/board`) and renders frames by `type` — the canonical event list in
  [02-data-model §3](02-data-model.md). Each frame mutates exactly the affected
  card / drawer / inbox row.
- **No-gap reconnect:** on drop, it reconnects with `since=<last-seen seq>`. The
  server subscribes first, captures high-water, replays `seq > since`, then drains
  live; the **client dedupes by `seq`** so a replayed-then-live overlap is
  idempotent ([07 WebSocket protocol](07-api-reference.md),
  [09-concurrency](09-concurrency.md)).
- **`{type:'reset'}` frame** (cursor below the retained compaction floor): the
  UI treats it as a hard refresh — discard local state, **full reload** from the
  board view, and jump `lastSeq` to the frame's `cursor` so reconnects don't
  reset-loop ([07](07-api-reference.md)).

Rendering is keyed off `seq` ordering, which is consistent across push, delta
sync, and HITL wakeups ([09-concurrency](09-concurrency.md)).

### Event → UI mapping (representative)

| Event type | UI effect |
|------------|-----------|
| `task.created` / `task.updated` | upsert card; refresh open drawer |
| `task.moved` | relocate card to its column / position; recompute parent's `blocked_by_children` |
| `task.archived` | remove card |
| `task.reparented` | update child's parent badge + both tasks' subtask counts |
| `dep.added` / `dep.removed` | recompute dep-blocked flag + Blocked projection |
| `comment.added` | append to thread; bump unread badge |
| `criterion.*` | re-render checklist + `x/y` |
| `input.requested` | add inbox row; set needs-input flag; **notify** (§7) |
| `input.answered` / `input.cancelled` / `input.expired` | drop inbox row; clear needs-input if none remain |
| `label.*` / `artifact.*` | update card / drawer section |

---

## 6. Interactions (all writes via REST)

Every mutation is a REST call from [07](07-api-reference.md); the resulting
broadcast event is the source of truth. **Optimistic UI is optional** — if used,
the optimistic patch must be **reconciled** (and rolled back on error or replaced)
when the matching event arrives.

- **Drag-drop** a card between columns → `POST /api/tasks/:id/move`. Dropping in
  `Done` is the `done` shortcut. **Blocked is not a drop target** (§2) — it is
  derived. A `409` (stale `version`) surfaces as a conflict toast and the card
  reconciles from the stream.
- **Add comment** → `POST /api/tasks/:id/comments` (`author_type = user`).
- **Answer input** → `POST /api/input-requests/:qid/answer` (inbox or drawer).
- **Cancel input** → `POST /api/input-requests/:qid/cancel` (inbox or drawer).
- **Check / uncheck acceptance criteria** → `PATCH /api/criteria/:acid`;
  **add criterion** → `POST /api/tasks/:id/criteria`.
- **Add / remove label** → `POST` / `DELETE /api/tasks/:id/labels`.
- **Add / remove blocker dependency** → `POST` / `DELETE /api/tasks/:id/deps`.
- **Claim / release / archive** → `POST /api/tasks/:id/{claim,release,archive}`.

No write path bypasses REST; the UI never writes SQLite directly (the server is
the sole writer — [02-data-model §7](02-data-model.md),
[09-concurrency](09-concurrency.md)).

---

## 7. Notifications

When an **`input.requested`** event arrives over the WebSocket, the UI raises a
**browser/desktop notification** ("T-12 needs your input: Which auth provider?")
so the human knows the agent is waiting even if the tab is backgrounded. Clicking
it focuses the app and opens the relevant inbox row / card. This is the UI-side
analogue of the v2 external-nudge transport in
[04 §3(C)](04-human-in-the-loop.md). Notifications require user permission; if
denied, the in-app inbox flag (§3) is the fallback signal.

---

## 8. Auth & access

- The UI is opened via a **one-time token URL minted by `kanban open`**
  (e.g. `http://127.0.0.1:<port>/#token=<t>`).
- The token is consumed from the URL and **stored for the session** (the address
  bar is cleaned so the token is not left in history).
- **Every** REST call carries `Authorization: Bearer <token>`; the WebSocket
  passes `?token=<t>` ([07 Conventions](07-api-reference.md)). The server
  validates `Origin`/`Host` (anti DNS-rebinding) and binds localhost-only.
- Token lifecycle, rotation, and revocation are owned by
  [10-security-lifecycle](10-security-lifecycle.md); a `401/503` surfaces as a
  re-open prompt (exit-code mapping `401/503`→5, [07](07-api-reference.md)).

---

## 9. Accessibility & performance (brief)

- **Keyboard navigation for answering inputs:** the inbox is fully operable
  without a mouse — focus moves through `Q-n` rows, option buttons are reachable
  by `Tab`/arrows, `Enter` submits. Drawer sections are landmarked.
- **Render only visible columns** and lazily mount the drawer.
- **Virtualize long columns** (e.g. a large Backlog/Done) so DOM size stays
  bounded regardless of task count.
- Respect `prefers-reduced-motion` for card-move animations.

---

## 10. Component inventory

| Component | Responsibility |
|-----------|----------------|
| **BoardView** | top-level layout; owns the WebSocket + `seq` cursor; routes events |
| **Column** | one status column; virtualizes its card list; drop target (except Blocked) |
| **Card** | compact `T-n` summary: title, priority, labels, status-flag icons |
| **CardDrawer** | full detail: description, summary (+ stale indicator), criteria, deps, comments, inputs, artifacts |
| **InputInbox** | board-wide list of `open` input requests; answer via REST |
| **CommentThread** | renders + posts comments (`user`) |
| **CriteriaList** | acceptance-criteria checklist with `x/y` progress |
| **DependencyList** | blockers + blocked-by, each with status |
| **ConnectionStatus** | live/reconnecting/replaying indicator; surfaces `{reset:true}` reload |
