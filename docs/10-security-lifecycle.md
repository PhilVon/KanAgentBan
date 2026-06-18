# 10 — Security & Lifecycle

> **Summary:** KanAgentBan is a **local-first, single-user** server. It binds
> `127.0.0.1` only, but localhost is *not* a trust boundary: other local processes
> and any webpage in the user's browser can reach the loopback port. Defense is a
> per-board **bearer token** ([07-api-reference](07-api-reference.md)) plus
> **Origin/Host validation** (anti DNS-rebinding). Lifecycle is auto-managed:
> detect-via-`/healthz`, spawn detached, pidfile + lockfile, and a per-path
> **registry** so the right board resolves from any CWD.
>
> **Decisions:** Bind loopback only (never `0.0.0.0`). Token required on every REST
> + WS call; minted at `board init`, `0600`. UI gets it via a one-time URL from
> `kanban open`. Origin **and** token are both required (either alone is
> insufficient). One DB file per project under `.kanban/`; boards keyed by
> `project_path` in `~/.kanban/registry.json`. Single instance per board via
> lockfile; stale pidfiles are reclaimed. Artifacts store references, never
> contents ([02-data-model](02-data-model.md), [03-token-efficiency](03-token-efficiency.md)).
>
> **Open questions:** Whether to rotate the per-board token on demand (`board
> rotate-token`) in v1 or v2. Whether the registry should be lock-protected for
> concurrent `board init` across projects (currently last-writer-wins per key).

Related: [02-data-model](02-data-model.md) · [03-token-efficiency](03-token-efficiency.md) ·
[05-cli-reference](05-cli-reference.md) · [07-api-reference](07-api-reference.md) ·
[09-concurrency](09-concurrency.md)

---

## 1. Threat model

The server runs on a developer's local machine and is used by one human plus their
agent. That sounds safe; it is not, for two reasons:

- **Other local processes** running as the same user can open a socket to
  `127.0.0.1:<port>` exactly like the CLI can. Loopback grants no per-process
  isolation.
- **Any webpage** the user visits can issue `fetch`/`XMLHttpRequest`/WebSocket
  requests to `http://127.0.0.1:<port>` from the user's browser. A malicious page
  can therefore *attempt* board reads/writes, and via **DNS rebinding** can make a
  same-origin-looking request resolve to loopback.

So localhost is **not automatically safe**. The two countermeasures below are
designed to be effective *together*:

| Attacker | Blocked by |
|----------|-----------|
| Random local process (no token) | Bearer token (§3) |
| Malicious webpage (no token, hostile Origin) | Origin/Host check (§4) **and** token (§3) |
| DNS-rebinding (forged Host) | Host allowlist (§4) |

Out of scope for v1: multi-user authz, network exposure, at-rest encryption of the
SQLite file (it inherits filesystem permissions of the user's home/project dir).

---

## 2. Network binding

The server **binds `127.0.0.1` only — never `0.0.0.0`** and never a LAN/public
interface. This is stated explicitly because binding all interfaces is the single
most common way a "local" dev tool becomes remotely exploitable.

- Base URL is always `http://127.0.0.1:<port>` ([07 Conventions](07-api-reference.md)).
- The WebSocket endpoint `ws://127.0.0.1:<port>/ws` inherits the same bind.
- There is no TLS: traffic never leaves the loopback interface, and a per-board
  token over loopback is the trust mechanism (§3).

---

## 3. Authentication — per-board bearer token

Each board has one secret bearer token.

- **Generation:** created at `kanban board init` (cryptographically random, ≥256
  bits). Recorded in the registry (§7) and written to a token file inside the
  board's `.kanban/` directory with mode **`0600`** (owner read/write only).
- **CLI use:** the CLI reads the token from `.kanban/` (or the registry) after
  resolving the board (§7) and sends it on **every** call as
  `Authorization: Bearer <token>` ([07 Conventions](07-api-reference.md)).
- **WebSocket:** the token is passed as the `?token=` query parameter on the
  `/ws` handshake ([07 WebSocket protocol](07-api-reference.md)).
- **Coverage:** every REST endpoint **and** the WS stream require the token. The
  sole exception is `GET /healthz`, which is **unauthenticated** by design so the
  auto-start probe (§6) can check liveness without holding the token yet — it
  returns only `{ok, board_id, seq}` and performs no mutation and leaks no task
  data.
- **Auth failures** map to HTTP `401` → CLI exit `5` (auth / server unreachable),
  consistent with [05 exit codes](05-cli-reference.md) and
  [07 Conventions](07-api-reference.md).

### Web UI token handoff

The browser must never be handed the long-lived token on a plain URL that could
land in history or referer logs carelessly. Instead:

- `kanban open` mints a **one-time URL** (a short-lived, single-use handoff token)
  and opens it in the browser ([05 Lifecycle commands](05-cli-reference.md)).
- The UI redeems that one-time URL for the board token, **stores it for the
  session** (in memory / session storage), and uses it as the bearer on all
  subsequent REST + WS calls.
- The one-time handoff is consumed on first use; a leaked/replayed URL is inert.

---

## 4. CSRF / DNS-rebinding defense — Origin & Host validation

A token alone is not enough against the browser: a hostile page cannot read the
token (it lives in the CLI/`.kanban/` and in the legitimate UI's session storage),
but the server must still refuse cross-origin requests so that bugs, future
cookie-based flows, or a partially-leaked token cannot be abused from a webpage.

The server validates two headers on every authenticated request (REST and the WS
handshake):

- **`Origin`** must be absent (non-browser clients like the CLI) **or** be a
  loopback origin (`http://127.0.0.1:<port>` / `http://localhost:<port>`). Any
  other Origin → reject (`403`).
- **`Host`** must match the expected loopback host:port. This blocks **DNS
  rebinding**, where an attacker's domain is re-pointed at `127.0.0.1`: the forged
  `Host` header won't be on the allowlist, so the request is dropped.

Token check and Origin/Host check are **both** enforced — neither is sufficient
alone (see the threat table in §1).

---

## 5. Secrets hygiene

- **No secrets in content.** The board token, API keys, and any credentials must
  never be written into task descriptions, comments, or `system` audit lines.
- **Artifacts are references, not contents.** An `artifact` row stores a `uri`
  (path, URL, or PR ref) and **never the bytes** of the thing it points to
  ([02-data-model §artifact](02-data-model.md)). This is simultaneously:
  - a **security** rule — secrets in files/outputs stay out of the DB and out of
    the event log, which is append-only and never deleted
    ([02-data-model §6](02-data-model.md)); and
  - a **token-efficiency** rule — context views ship cheap references the agent
    can dereference on demand rather than inlining large blobs
    ([03-token-efficiency](03-token-efficiency.md)).
- The token file and DB inherit `0600` / user-only filesystem permissions; backups
  produced by `kanban export` (§8) contain board *data* only, not the token.

### External-nudge egress

External-nudge auto-resume ([04-human-in-the-loop §3C](04-human-in-the-loop.md),
[adr/0006](adr/0006-external-nudge-transport.md)) is the one path that sends data
**off the loopback interface**, so it is **off by default** and entirely
user-configured:

- The **webhook** POSTs the `input.answered` event — which includes the **answer
  text** — to a user-chosen URL. Point it only at endpoints you trust; put any
  endpoint auth in the `nudge.headers` (or a secret-bearing `KANBAN_NUDGE_URL`),
  not in board content.
- The **command** runs with the **server's privileges**. Only configure a command
  you control; the answer arrives via `KANBAN_*` env vars (never interpolated into
  a shell string by the server).
- Both are fire-and-forget and failures are swallowed, so a hostile or dead
  endpoint cannot break answering or wedge the sole-writer server.

---

## 6. Server lifecycle & auto-start

Every CLI command is self-healing: it ensures a healthy server for the resolved
board before proceeding ([05 Global conventions](05-cli-reference.md)).

1. **Resolve the board** (§7) → determine its expected port.
2. **Liveness probe:** `GET /healthz` on that port. A correct `{ok, board_id,
   seq}` for *this* board means reuse the running server.
3. **If down, spawn detached:** start `kanban serve --port <port>` as a detached
   background process (survives the invoking CLI's exit).
4. **Record runtime state** in `.kanban/`:
   - a **pidfile** (`.kanban/server.pid`) with the server PID, and
   - a **port file** (`.kanban/server.port`) with the bound port.
5. **Health-check before use:** poll `/healthz` until ready (bounded), then issue
   the real request. Failure to come up → exit `5`.

### Port-in-use

If the chosen port is taken (by an unrelated process), the server **picks the next
free port**, binds it, and **records the new port** in the port file and the
registry (§7). Subsequent CLI invocations read the recorded port, so resolution
stays correct.

### Single instance per board

A **lockfile** (`.kanban/server.lock`, advisory/exclusive) guarantees **one server
per board**. A second `serve` for the same board fails to acquire the lock and
defers to the running instance (discovered via `/healthz`).

### Stale pidfile recovery

If a pidfile exists but the named process is **gone** (crash, reboot) the entry is
**stale**: the CLI verifies the PID is not alive (and `/healthz` does not respond),
then **reclaims** — removes the stale pidfile/lock and starts a fresh detached
server. This prevents a dead pidfile from wedging the board.

---

## 7. Multi-board registry & resolution

Boards are keyed by **project path**.

- **Registry:** `~/.kanban/registry.json` maps each `project_path` to its runtime
  facts:

  ```json
  {
    "/home/phil/work/acme-api": {
      "port": 7421,
      "token": "kab_…",
      "db_path": "/home/phil/work/acme-api/.kanban/board.db"
    }
  }
  ```

  `project_path` is the unique lookup key, matching `board.project_path`
  ([02-data-model §2](02-data-model.md)).

- **Resolution:** the CLI **walks up from CWD** until it finds a `.kanban/` marker
  directory and uses that project as the board ([05 Global conventions](05-cli-reference.md)).
  `--board <path>` overrides resolution to disambiguate (e.g. from outside any
  project, or nested projects).

- **Per-project storage:** the SQLite database lives at `.kanban/board.db` — **one
  DB file per project** (the resolved default in [02-data-model open
  questions](02-data-model.md)). In WAL mode SQLite keeps two **sidecar files**
  alongside it — `board.db-wal` and `board.db-shm` — which must be backed up /
  moved / deleted together with `board.db`; copying `board.db` alone can lose
  committed-but-uncheckpointed writes.

- **Consistency:** the registry is the cache; the authoritative port is also in the
  per-board port file (§6). On mismatch (e.g. server moved to a free port), the
  port file / live `/healthz` wins and the registry is rewritten.

---

## 8. Data location, backup & migrations

- **Location:** all board state is **local** under the project's `.kanban/`
  directory (`board.db` + WAL sidecars, token file, pid/port/lock files). Nothing
  is sent off-machine.
- **Backup:** `kanban export [--out FILE]` dumps the board to JSON for backup /
  diffing / hand-off ([05 Lifecycle commands](05-cli-reference.md)). This is the
  portable, sidecar-free backup format; the raw DB+WAL is the live store.
- **Migrations:** the `board.schema_version` field
  ([02-data-model §board](02-data-model.md)) drives migrations. On server start the
  server compares the on-disk `schema_version` to the binary's expected version and
  applies forward migrations (in a transaction) before serving traffic — so the
  single-writer server is always operating on an up-to-date schema.

---

## 9. Operational checklist

| Control | Requirement |
|---------|-------------|
| Bind localhost | `127.0.0.1` only, never `0.0.0.0` (§2) |
| Token required | Bearer on every REST + WS call; `0600` token file; `/healthz` exempt (§3) |
| Origin validated | Reject non-loopback `Origin`; `Host` allowlist vs DNS-rebinding (§4) |
| Pidfile + lockfile | Detached server, single instance per board, stale pidfile reclaimed (§6) |
| Registry consistent | `~/.kanban/registry.json` keyed by `project_path`; port file / `/healthz` wins on mismatch (§7) |
| Export available | `kanban export` JSON backup; back up WAL sidecars with the DB (§7, §8) |
| Schema migrated | `schema_version` checked & migrated on server start (§8) |
| Nudge egress controlled | External nudge off by default; webhook URL/command user-configured & trusted (§5) |
