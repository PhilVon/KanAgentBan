# 09 — Concurrency, Ordering & Replay

> **Summary:** One Node process per board is the **sole writer**; with
> synchronous `better-sqlite3`, writes serialize by construction, so most
> multi-writer hazards simply cannot occur. Each mutation runs in one
> transaction that *also* appends exactly one `event` and allocates its `seq`,
> making **event order == commit order == broadcast order**, gap-free. One
> replay query (`seq > cursor`) backs both WebSocket reconnect and
> `changes`/`watch`. WAL mode lets the UI and CLI read concurrently while writes
> serialize.
>
> **Decisions:** Single-writer invariant is the foundational consistency lever.
> `seq` allocated inside the write txn from a per-board counter. Subscribe-first-
> then-replay closes the going-live gap. Optimistic concurrency (`version` +
> `If-Match`) turns racing edits into `409`s, never silent clobbers. HITL wakeups
> are emitter-driven, never DB polling.
>
> **Open questions:** Log compaction / retained-floor policy for very old cursors
> (drives the `reset` frame) — deferred to v2.

Related: [02-data-model](02-data-model.md) · [04-human-in-the-loop](04-human-in-the-loop.md) ·
[07-api-reference](07-api-reference.md) · [10-security-lifecycle](10-security-lifecycle.md) ·
[11-roadmap](11-roadmap.md)

---

## 1. The single-writer invariant

The foundational consistency lever: **exactly one Node process per board is the
sole writer.** `better-sqlite3` is synchronous, so a write runs to completion
before the next begins — there is no interleaving of in-flight writes within the
process, and no second process competes for the write lock. This eliminates most
multi-writer hazards *by construction* rather than by careful locking.

WAL mode (see [02-data-model](02-data-model.md)) complements this: readers never
block the writer and the writer never blocks readers, so the web UI and any
`kanban` read commands (`list`, `show`, `context`, `next`) observe a consistent
snapshot while writes serialize behind them. Reads are concurrent; writes are
serial. Everything below builds on this single fact.

---

## 2. Transaction boundaries — the core guarantee

Each mutation runs in **one transaction** that does three things atomically:

1. apply the row change(s),
2. allocate the next `seq`, and
3. append **exactly one** `event` row (canonical types,
   [02-data-model §3](02-data-model.md)).

```
BEGIN;
  -- mutate task / dep / comment / criterion / input_request / ...
  UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value;  -- new seq
  INSERT INTO event (seq, ts, type, task_id, actor_type, payload) VALUES (...);
COMMIT;
```

Because the `event` and its `seq` are committed in the same transaction as the
change they record, the order in which transactions commit *is* the order of
`seq`, *is* the order events are broadcast over the WebSocket and returned by
delta sync:

```
event order  ==  commit order  ==  WS broadcast order  ==  changes/watch order
```

This single invariant is what makes every consumer (UI, CLI `watch`, `inbox`,
parked `await`) agree on what happened and in what order — gap-free.

---

## 3. `seq` allocation

`seq` is issued from a per-board counter row in the `counters` table
([02-data-model §1, §7](02-data-model.md)) — or equivalently an `AUTOINCREMENT`
PK — **incremented inside the write transaction**. Properties:

- **Monotonic:** strictly increasing, never reused.
- **Gap-free:** because allocation and the `event` insert share one txn, a rolled-
  back mutation consumes no `seq` (counter increment rolls back with it).
- **Commit-ordered:** serialized writes mean `seq` reflects true commit order.

A gap-free monotonic cursor is what lets every replay reduce to a simple
`seq > cursor` range scan with no "did I miss one?" ambiguity.

---

## 4. One replay path, two transports

Both realtime transports resolve to the same idea: *"all events where
`seq > cursor`, then go live."* They share one query
([07-api-reference](07-api-reference.md)):

- **WebSocket reconnect** — `GET /ws?since=<seq>` replays `seq > since`, then
  streams live frames.
- **Delta sync** — `GET /api/changes?since=<seq>` (board-wide) and
  `GET /api/tasks/:id/watch?since=<seq>` (scoped to a task + its direct deps)
  return the same `seq > since` rows.

There is **one** replay code path behind all three; the transports differ only in
framing and in whether they then hold the connection open. No endpoint or event
type beyond those in [07-api-reference](07-api-reference.md) and
[02-data-model §3](02-data-model.md) is introduced here.

---

## 5. The subscribe-then-replay race (and the fix)

The hazard: if a client runs the replay query *first* and only afterward
subscribes to the live emitter, any event committed in the window between the
query and the subscription is lost — it is past the query's high-water mark but
arrived before the subscription was active.

The fix (as specified for WS in [07-api-reference](07-api-reference.md)):

1. **Subscribe to the live emitter first.** Buffer everything it pushes.
2. **Capture the current high-water `seq`** at that moment.
3. **Replay** `event` rows where `seq > cursor` up to that high-water mark.
4. **Drain the buffered live events**, then continue live.
5. **Dedupe by `seq`** — events that appear in both the replay range and the live
   buffer (overlap at the boundary) are collapsed to one.

Because the subscription is established before the high-water mark is read,
nothing can fall into the gap; the dedupe absorbs the harmless overlap. Result:
**no missed events and no duplicates** across the replay-to-live handover.

---

## 6. Long-poll resolution races (HITL)

`await` is a long-poll, so it is exposed to a classic lost-wakeup race: a human
could answer in the window between `ask` and `await`. The resolution mirrors the
subscribe-first pattern of §5 and is specified in
[04-human-in-the-loop §6](04-human-in-the-loop.md):

1. **Check committed state before parking.** If the request is already
   `answered`/`cancelled`/`expired`, return immediately — no parking.
2. **Park on the in-process event emitter** — the *same* emitter that feeds the
   WebSocket — only while the request is still `open`. Wakeups are driven off
   `input.answered` (et al.), **never** by polling the database.
3. **Check-then-park happens under a lock,** with a max timer for the
   `--timeout`. On expiry the call returns `pending` (`204` → exit `2`), not an
   error.

Driving wakeups off the emitter rather than DB polling keeps `await` resolution
order consistent with `seq` order, so push, delta sync, and HITL wakeups all
agree (§2).

---

## 7. Optimistic concurrency on edits

Field-level mutations carry the row's `version`
([02-data-model](02-data-model.md) `task.version`) as a precondition:

- HTTP: `PATCH /api/tasks/:id` with header `If-Match: <version>`.
- CLI: `kanban update ... --expect-version <n>`.

The write transaction bumps `version` on success. A precondition that no longer
matches the committed `version` is a **stale write**, rejected with `409` → CLI
exit `4` ([07-api-reference](07-api-reference.md) error mapping). So when an agent
and a human both edit a task's `description` / `summary` / criteria text, the
late writer is told its base was stale instead of silently overwriting the other
— **no lost updates.**

---

## 8. Agent and user editing concurrently

The two writers do not race at the storage layer — they serialize through the
single process (§1). What surfaces to them is therefore a **version conflict, not
a lost update**: whoever commits second on the *same field* of the *same row*
gets a `409` and re-reads.

Append-style and independent mutations don't conflict at all:

- **Comments** are appends (`C-n`) — each is a new row.
- **Acceptance criteria** are independent rows (`AC-n`); checking one
  (`criterion.checked`) doesn't contend with editing another.
- **Input requests** are appends (`Q-n`); answers target distinct rows.

Conflicts are confined to genuine same-field edits, exactly where a human should
be asked to reconcile.

---

## 9. Multi-agent future (v2)

The model is already concurrency-safe for multiple agents:

- `event.actor_type` (`agent` | `user` | `system`) distinguishes writers in the
  log.
- Per-row `version` (§7) means two agents editing the same task conflict via
  `409` rather than clobbering.

The one missing piece is **coordination on recommendations**: two agents calling
`next` could both pick the same task. The planned fix is an explicit
`kanban claim T-1` (assigning `task.assignee`, reserved today in
[02-data-model](02-data-model.md)) so a claimed task drops out of the other
agent's `next`. Tracked in [11-roadmap](11-roadmap.md).

---

## 10. Failure & recovery

- **Stale cursor.** If a client's `since` is below the retained floor (v2 log
  compaction), `GET /api/changes` returns `{ reset: true, snapshot_cursor }` and
  the WS sends a reset frame ([07-api-reference](07-api-reference.md)); the client
  does a full re-list and resumes from `snapshot_cursor`.
- **WebSocket disconnect.** Client reconnects with its last-seen `seq`; the §5
  subscribe-first replay restores it to live with no gap and no duplicates.
- **Server crash mid-write.** SQLite WAL recovers the database to the last
  **committed** transaction on next open; a partially-applied mutation (and its
  unallocated `seq`) is rolled back, preserving the gap-free invariant (§3).
- **Stale process / lock.** A single-writer board uses a pidfile/lockfile so a
  new server detects and recovers from a crashed predecessor before taking the
  write role; the detailed lifecycle is in
  [10-security-lifecycle](10-security-lifecycle.md).
