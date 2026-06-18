# 07 — API & WebSocket Reference

> **Summary:** The server exposes one REST API shared by the CLI and the web UI,
> plus a WebSocket stream for realtime. Every CLI command in
> [05-cli-reference](05-cli-reference.md) maps to an endpoint here; every event
> type in [02-data-model §3](02-data-model.md) is produced by a mutation here and
> replayable over both transports.
>
> **Decisions:** REST for request/response, WebSocket for push, one shared replay
> query (`seq > cursor`) behind both `GET /api/changes` and WS reconnect. Bearer
> token on every request; Origin/Host validated.
>
> **Open questions:** REST vs a thin RPC envelope — current choice is plain REST
> for debuggability.

Related: [02-data-model](02-data-model.md) · [05-cli-reference](05-cli-reference.md) ·
[09-concurrency](09-concurrency.md) · [10-security-lifecycle](10-security-lifecycle.md)

---

## Conventions

- Base URL: `http://127.0.0.1:<port>` (localhost-only bind).
- Auth: `Authorization: Bearer <token>` on every request; WS passes `?token=`.
  Server validates `Origin`/`Host` (anti DNS-rebinding) — see [10](10-security-lifecycle.md).
- Content type: `application/json`.
- Errors: `{ "error": { "code": "<machine_code>", "message": "..." } }` with HTTP
  status mapping to CLI exit codes: `404`→3, `409`→4 (stale `version`), `401/503`→5.
- Most read endpoints accept `?max_tokens=N` and `?format_version=1`; truncation is
  explicit (mirrors the CLI, [03-token-efficiency](03-token-efficiency.md)).

---

## Board & health

| Method | Path | CLI | Notes |
|--------|------|-----|-------|
| `GET` | `/healthz` | (auto-start probe) | no auth; returns `{ok, board_id, seq}` |
| `GET` | `/api/board` | `board show` | columns config, board id, high-water `seq` |
| `POST` | `/api/board` | `board init` | create board + token |

## Tasks

| Method | Path | CLI |
|--------|------|-----|
| `GET` | `/api/tasks?status=&label=&limit=` | `list` |
| `GET` | `/api/tasks/:id?view=show\|context&max_tokens=` | `show` / `context` |
| `GET` | `/api/next?context=&n=` | `next` |
| `POST` | `/api/tasks` | `add` |
| `PATCH` | `/api/tasks/:id` (header `If-Match: <version>`) | `update` |
| `POST` | `/api/tasks/:id/move` | `move` / `done` |
| `POST` | `/api/tasks/:id/archive` | `archive` |

`view=context` returns the curated working-set object (sections + truncation
footers) defined in [03-token-efficiency](03-token-efficiency.md). `PATCH` with a
stale `If-Match` returns `409` → exit `4`.

## Dependencies, comments, criteria, labels, artifacts

| Method | Path | CLI |
|--------|------|-----|
| `POST` / `DELETE` | `/api/tasks/:id/deps` | `dep add` / `dep rm` |
| `POST` | `/api/tasks/:id/comments` | `comment` |
| `POST` | `/api/tasks/:id/criteria` | `criterion add` |
| `PATCH` | `/api/criteria/:acid` | `criterion check` |
| `POST` / `DELETE` | `/api/tasks/:id/labels` | `label --add/--rm` |
| `POST` | `/api/tasks/:id/artifacts` | `artifact` |
| `POST` | `/api/tasks/:id/summary` | `summarize` |

`POST /api/tasks/:id/deps` rejects cycles/self/duplicate with `409`/`400`.

## Human-in-the-loop

| Method | Path | CLI | Notes |
|--------|------|-----|-------|
| `POST` | `/api/tasks/:id/input-requests` | `ask` | returns `Q-n`, non-blocking |
| `POST` | `/api/input-requests/:qid/answer` | `answer` / UI | also used by the UI |
| `GET` | `/api/input-requests/:qid/await?timeout=S` | `await` | **long-poll**; checks committed state before parking; `204` on timeout → exit `2` |
| `GET` | `/api/await?task=&any=&timeout=S` | `await --task/--any` | long-poll variants |
| `GET` | `/api/inbox?since=<reqseq>` | `inbox` | answered/open since cursor |

Long-poll semantics, races, and the state diagram: [04-human-in-the-loop](04-human-in-the-loop.md).

## Delta sync

| Method | Path | CLI | Notes |
|--------|------|-----|-------|
| `GET` | `/api/changes?since=<seq>` | `changes` | board-wide; `{reset:true,snapshot_cursor}` if cursor stale |
| `GET` | `/api/tasks/:id/watch?since=<seq>` | `watch` | scoped to task + direct deps |

---

## WebSocket protocol

`GET ws://127.0.0.1:<port>/ws?since=<seq>&token=<t>`

**Handshake / replay (the no-gap reconnect):**
1. Client connects with its last-seen `since`.
2. Server **subscribes first**, captures the current high-water `seq`, then
   replays `event` rows where `seq > since` up to that high-water mark.
3. Buffered live events drain next; client **dedupes by `seq`**.

This is the *same* replay query as `GET /api/changes` — one code path, two
transports (see [09-concurrency](09-concurrency.md)).

**Message frames (server → client):**
```json
{ "seq": 142, "type": "input.answered", "task_id": "T-12",
  "actor_type": "user", "ts": "2026-06-18T10:03:00Z",
  "payload": { "request_id": "Q-7", "answer": "Auth0" } }
```

**Reset frame** (cursor below the retained floor — v2 with log compaction):
```json
{ "reset": true, "snapshot_cursor": 90 }
```

Event `type` values are exactly the canonical list in
[02-data-model §3](02-data-model.md). The UI re-renders affected cards;
parked `await` long-polls resolve off the same in-process emitter that feeds this
stream, guaranteeing ordering consistency between push, delta sync, and HITL wakeups.
