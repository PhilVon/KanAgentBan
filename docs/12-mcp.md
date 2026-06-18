# 12 — MCP Interface

> **Summary:** `kanban-mcp` exposes the board over the **Model Context Protocol**
> (stdio) so agents that aren't Claude-Code-with-the-skill — computer-use agents,
> other LLM frameworks, any MCP client — can drive it. It is a **thin MCP client of
> the existing sole-writer HTTP server**, reusing the same `connect()` + `api()`
> path as the `kanban` CLI; it never opens its own database. The tool surface is a
> **curated** subset of the CLI (~21 tools), not a 1:1 mirror, to keep an agent's
> tool-context cost low while preserving the token-efficiency and durable-async
> contracts.
>
> **Decisions:** Official `@modelcontextprotocol/sdk`. Thin client, not a second
> writer (ADR [0003](adr/0003-single-writer-server.md)). Verb-pairs consolidate
> behind an `op` argument. `await` is bounded and returns a never-silent "pending".
>
> **Open questions:** whether to also offer a Streamable-HTTP transport for remote
> clients (stdio only today).

Related: [05-cli-reference](05-cli-reference.md) · [06-skill](06-skill.md) ·
[07-api-reference](07-api-reference.md) · [03-token-efficiency](03-token-efficiency.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md) · [11-roadmap](11-roadmap.md)

---

## 1. Why an MCP interface

The `kanban` CLI + Claude Code skill is the primary agent surface. MCP is the
**alternative** surface for any agent that speaks MCP but isn't running the skill.
It deliberately offers the *same* model — the tiered read ladder, the write
vocabulary, and the ask → yield → inbox human-in-the-loop — so an agent's mental
model transfers between the two with no new concepts.

## 2. Architecture — a client, not a second writer

```
MCP client (any agent)
   │  stdio (JSON-RPC)
   ▼
kanban-mcp  ──connect()──▶ nearest .kanban/ board (auto-starts the server if down)
   │
   └─ every tool ──api() / HTTP 127.0.0.1 + bearer token──▶ the one sole-writer server
                                                              (REST + WS + SQLite/WAL)
```

`kanban-mcp` resolves the board and forwards every call to the running server via
the same helpers the CLI uses (`src/cli/board.ts`: `connect`, `api`). It does
**not** open a `Repo`/SQLite connection of its own.

This is the load-bearing decision. A second in-process writer would carry its own
event-`seq` counter and its own event `Bus`, so WebSocket clients and parked
`await` long-polls attached to the real server would silently miss the MCP
process's mutations — breaking realtime UI updates and HITL wake-ups. Routing
through the single server keeps one event spine, one broadcast, one source of
truth ([09-concurrency](09-concurrency.md)).

## 3. Running it

```bash
npm run build
# launched by an MCP client over stdio; --board overrides board discovery (defaults
# to the nearest .kanban/ above CWD), --as / KANBAN_AGENT sets the agent identity.
node dist/mcp/server.js --board /path/to/project --as agent-2
# dev mode: npm run mcp -- --board /path/to/project
```

Example MCP client config (`command` + `args`):

```json
{
  "mcpServers": {
    "kanban": { "command": "node", "args": ["dist/mcp/server.js", "--board", "/path/to/project"] }
  }
}
```

- **Discovery & auto-start:** identical to the CLI — walk up to the nearest
  `.kanban/`, read the token, health-check the port file, spawn the server
  detached if it's down ([10-security-lifecycle](10-security-lifecycle.md)). The
  board must already be initialised (`kanban board init`).
- **Auth:** shares the per-board bearer token in `.kanban/token`; every forwarded
  request carries it plus `x-actor: agent` and the `x-agent` identity.
- **stdout is the protocol channel.** All diagnostics go to **stderr** — the
  server never writes to stdout outside JSON-RPC.

## 4. Tool catalogue (~21, curated)

Each tool maps to the CLI command / REST endpoint of the same behaviour. Reads
ride through `?json=1` and append an `[est_tokens: N]` footer; `max_tokens` /
`full` honour the token-budget contract ([03-token-efficiency](03-token-efficiency.md)).

**Read ladder** (cheapest first): `next`, `list`, `show`, `context`, `watch`,
`changes`, `inbox`.

**Writes:** `add`, `update` (carries `summary`; `expect_version` → `If-Match`),
`move` (Done included), `claim` (`op: claim|release`, `force`), `archive`, `dep`
(`op: add|remove`), `parent` (`to` / `clear`), `comment`, `criterion`
(`op: add|check`), `label` (`op: add|remove`), `artifact`.

**Human-in-the-loop:** `ask`, `await` (bounded; `qid` / `task` / `any`), `cancel`.

### Consolidations vs the CLI

Six CLI verb-pairs collapse into one tool each via an `op`/flag argument:
`claim`+`release`, `dep add`+`dep rm`, `label --add`+`--rm`, `parent --to`+`--clear`,
`criterion add`+`check`, and `move`+`done`. `summarize` folds into `update`'s
`summary` field.

### Intentionally omitted

Operational / lifecycle commands that aren't part of an agent's task loop are left
to the CLI: `board init`, `board show`, `board nudge`, `compact`, `export`,
`serve`, `open`, and `answer` (answering is the **human's** job, done via the web
UI or CLI — the agent asks and resumes, it does not answer its own questions).

## 5. The durable-async `await` contract

MCP tools never block a turn indefinitely. `await` long-polls for a bounded
`timeout` (default 30s) and, on no resolution, returns a never-silent **pending**
message telling the agent to *yield this turn and resume later via `inbox`* — the
exact ask → yield → inbox loop the skill teaches ([04-human-in-the-loop](04-human-in-the-loop.md),
[06-skill](06-skill.md)). A resolved request returns the answer (or
`cancelled`/`expired`) immediately. Tool descriptions restate this so the
behaviour is discoverable from `tools/list` alone.

Errors map cleanly: a forwarded `CliError` (e.g. 404 not-found, 409 conflict)
becomes an MCP tool result with `isError: true` and `error (exit <code>): …`
text, rather than crashing the tool call.

## 6. Module compatibility (implementation note)

The project compiles as CommonJS with classic (`node`) module resolution, which
does not read a package's `exports` map. The SDK is ESM-first but ships a CJS
build. We import the SDK with ordinary **static imports** (emitted as `require`,
which Node resolves through the package's `require` export condition to the CJS
build) and supply a minimal ambient type shim (`src/mcp/sdk.d.ts`) for the handful
of SDK symbols used. This keeps the single `tsc` build and the rest of the tree
untouched (no switch to `nodenext` + `.js` extensions). Input schemas use `zod`
(already pulled in as an SDK dependency, and resolvable via its root `main`/`types`).

## 7. Files

- `src/mcp/server.ts` — stdio entry: `connect()` → `McpServer` → `registerTools`
  → `StdioServerTransport`.
- `src/mcp/tools.ts` — the tool table; handlers are decoupled from the SDK
  (`run(conn, args)`) so they unit-test directly, plus `runTool` (error mapping)
  and `registerTools`.
- `src/mcp/sdk.d.ts` — the ambient SDK type shim.
- `tests/mcp.test.ts` — drives the handlers against a real test server.
