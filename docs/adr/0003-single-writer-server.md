# 0003 — Single-Writer Server per Board

## Status

Accepted

## Context

The board's state lives in a single SQLite database per board, with an
append-only `event` log whose monotonic `seq` is the spine for realtime
broadcast, delta sync, and audit ([02-data-model](../02-data-model.md)). Correct
delta sync requires that commit order, `seq` order, and broadcast order all
agree. Multiple concurrent writers would introduce ordering hazards and
non-deterministic interleaving.

## Decision

A **single Node process per board is the sole writer**. It uses `better-sqlite3`
synchronously, allocating each `seq` inside the same write transaction as the
mutation it records. SQLite runs in **WAL mode** so the UI and other readers can
read concurrently without blocking the writer. See
[09-concurrency](../09-concurrency.md).

## Consequences

- `event.seq` equals commit order equals broadcast order — one replay path,
  trivially consistent cursors for `changes --since` / `watch --since`.
- Consistency logic stays simple: no multi-writer locking or conflict resolution.
- Concurrent reads are cheap (WAL); writes are serialized through one process.
- **Horizontal scaling is not supported** — there is exactly one writer per
  board. This is an accepted trade-off for a local-first, per-project tool.
