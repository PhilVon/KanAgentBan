# Getting Started — KanAgentBan

A practical guide to installing the `kanban` CLI, wiring up the Claude Code skill,
and getting Claude to actually use the board well.

KanAgentBan is an **agent-first** kanban board. The primary user is Claude — it
creates tasks, tracks progress across turns and sessions, records decisions, and
asks you questions through a durable input request. **You** watch a realtime web
UI and answer those questions. The board is Claude's external memory; the skill is
the layer that teaches Claude *when* and *how* to use it.

There are three pieces:

1. The **`kanban` CLI** — the surface Claude drives.
2. The **local server** — auto-starts on first command; owns the SQLite database
   and hosts the web UI.
3. The **Claude Code skill** (`SKILL.md`) — behavioural guidance that makes Claude
   reach for the board at the right moments.

---

## 1. Prerequisites

- **Node.js 20 or newer** (`node --version`).
- **Claude Code** installed and working.
- A terminal. Examples below give both PowerShell (Windows) and bash (macOS/Linux).

---

## 2. Build and install the CLI

From the project root:

```bash
npm install
npm run build      # compiles TypeScript to dist/
```

This produces two binaries declared in `package.json`:

- `kanban` → `dist/cli/kanban.js` (the agent CLI)
- `kanban-mcp` → `dist/mcp/server.js` (the optional MCP server, see §8)

Put `kanban` on your PATH so Claude can shell out to it from any directory:

```bash
npm link           # symlinks the `kanban` command globally
```

`npm link` is reversible (`npm unlink -g kanagentban`) and ideal while iterating.
For a one-off global install instead, run `npm install -g .` from the project root.

Verify:

```bash
kanban --help
```

On Windows, `npm link` creates a `kanban.cmd` shim on PATH — the same command works
in PowerShell.

---

## 3. Install the Claude Code skill

Claude Code loads skills from a `skills/` directory. Each skill is a folder
containing a `SKILL.md`. Copy this project's `skill/SKILL.md` into a folder named
`kanban` under your Claude config.

**Personal skill (available in every project):**

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

**Project-scoped skill (this repo only):** put it under the project's
`.claude/skills/kanban/SKILL.md` instead. Use this when you only want the board in
one codebase, or want to commit the skill alongside the project.

The skill's frontmatter `name` is `kanban`, so once it's in place Claude can also
be nudged explicitly with `/kanban`-style references, but the point of the skill is
that Claude reaches for it on its own (see §6).

Restart Claude Code (or start a new session) so it picks up the new skill.

---

## 4. Initialize a board (once per project)

In each project where you want a board, run:

```bash
kanban board init --name "My Project"
```

This creates a `.kanban/` directory holding the SQLite database and a per-board
auth token. Any subsequent `kanban` command auto-starts the local server if it
isn't already running — you never start it manually.

Confirm and open the human view:

```bash
kanban board show     # board id, port, db path
kanban open           # prints/opens the realtime web UI URL
```

The CLI finds the board by walking up from your current directory to the nearest
`.kanban/` marker, so commands work from any subfolder.

> **Tip:** add `.kanban/` to your `.gitignore`. It's local state and contains the
> board's auth token.

---

## 5. The two surfaces: who does what

| You (the human) | Claude (the agent) |
|---|---|
| Watch the realtime web UI (`kanban open`) | Creates and tracks tasks via the CLI |
| Answer Claude's questions in the UI | Raises durable questions, then yields the turn |
| Reprioritize, comment, review | Records decisions, criteria, and artifacts |

The server is **localhost-only** and bound to `127.0.0.1` with a per-board token —
nothing is exposed to the network.

---

## 6. Getting Claude to use the board well

The skill triggers on multi-step or stateful work. You rarely need to manage it by
hand, but knowing the triggers and the good-usage shape helps you steer.

### Trigger it

The skill activates when work is **multi-step, dependency-laden, or spans turns** —
or when you say things like:

- "track this" / "use the board" / "plan this out"
- "break this down into tasks"
- "ask me and continue" / "what should I do next?"

It deliberately **skips** trivial one-shot requests (a single edit, a quick
lookup). Forcing the board onto atomic work is pure token overhead. If Claude
isn't using the board when you want it to, just ask it to "plan this on the board
first."

### What good usage looks like

A healthy session looks roughly like this — you'll see it reflected live in the UI:

```
kanban next --context          # Claude loads one task + its working set in a single call
kanban move T-12 "In Progress" # status goes current on pickup
kanban criterion add T-12 "handles error responses"
kanban comment T-12 "chose Auth0 — Cognito needs a custom UI"
kanban artifact T-12 --kind pr --title "auth PR" --uri https://github.com/...
kanban done T-12               # completion recomputes what's now unblocked
```

Claude is coached to:

- **Read the narrowest thing** that answers its question (`next` before `context`,
  `watch --since` before a full re-read) — this is the whole token-efficiency point.
- **Keep status honest** — move to In Progress on pickup, `done` on completion.
  *Blocked* is derived automatically, never set by hand.
- **Decompose with subtasks** — `kanban add "step" --parent T-12`. A parent can't
  reach Done until its children do.
- **Record decisions, not chatter** — comments are for non-obvious choices, not a
  play-by-play.
- **Store artifacts as references** (links, PRs, paths) — never paste contents.

### When Claude needs a decision from you

This is the part worth understanding, because it changes how a session feels.
Claude does **not** freeze a turn waiting on you. Instead it:

1. Raises a durable question: `kanban ask T-12 "Which auth provider?" --options Auth0,Cognito`
   → this returns a `Q-7` immediately and parks the task as *needs input*.
2. Tries a short wait (`kanban await Q-7 --timeout 60`).
3. If you haven't answered in that window, Claude **yields the turn** — it picks up
   other ready work or ends cleanly with something like *"Paused T-12 on Q-7,
   awaiting your input."*

You answer at your leisure in the web UI (or with `kanban answer Q-7 "Auth0"`).
Answering flips the task back to *ready*. Next time Claude works the board —
even in a brand-new session — `kanban inbox` and `kanban next` surface it and it
resumes with your answer. Nothing is lost across sessions.

So: **a paused task is normal and healthy, not stuck.** Just answer the question
when you see it pop up in the UI.

#### Optional: enforce it with a Stop hook

In practice an agent will sometimes forget and just ask its question in the chat
reply — which is *not* durable and vanishes when the session ends. This repo ships
an opt-in [Claude Code Stop hook](https://docs.claude.com/en/docs/claude-code/hooks)
that catches it: when a turn ends with a question to you while a task is *In
Progress* and no input request is open, it nudges the agent to use `kanban ask`
instead. It fails open (never blocks you on error) and stays silent otherwise.

To enable it, copy the bundled hook into your project's Claude Code settings:

- Script: `.claude/hooks/board-hitl-stop.js`
- Registration: the `hooks.Stop` block in `.claude/settings.json`

Both live in this repo as a working reference — drop them into the project where you
run Claude Code (it needs `node` on `PATH`). Leave it out and the durable-async flow
still works; the hook only adds a backstop.

---

## 7. A first end-to-end walkthrough

Try this to see the whole loop:

1. In a project, run `kanban board init --name "Demo"` then `kanban open` and leave
   the UI open in a browser.
2. In Claude Code, ask: *"Plan a small feature on the board and start working it —
   ask me if you need a decision."*
3. Watch tasks appear in the UI in realtime as Claude creates and moves them.
4. When a question card appears, answer it in the UI.
5. Watch the task return to *ready* and Claude resume.

---

## 8. Optional: the MCP interface

If you drive the board from an agent that speaks **MCP** rather than Claude Code +
the skill (a computer-use agent, another framework), use the bundled `kanban-mcp`
stdio server. It's a thin client of the *same* local server — not a second writer —
so realtime UI and question wake-ups keep working.

The board must already be initialized (`kanban board init`). Example MCP client
config:

```json
{
  "mcpServers": {
    "kanban": {
      "command": "node",
      "args": ["dist/mcp/server.js", "--board", "/path/to/project"]
    }
  }
}
```

It exposes a curated ~21-tool subset of the CLI (the same read ladder, write
vocabulary, and ask → yield → inbox loop). Most users on Claude Code should use the
skill (§3) and can ignore this. Full detail: `docs/12-mcp.md`.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `kanban: command not found` | `npm run build` then `npm link` (§2); open a new shell. |
| Commands exit with code `5` (auth / server unreachable) | The board isn't initialized or the server can't start. Run `kanban board init`, confirm `.kanban/` exists. |
| Exit code `2` from `await` | **Not an error** — the question is still pending. This is the signal to yield and resume later from `inbox`. |
| Exit code `4` (conflict) | A stale write version. Re-read with `kanban context <id>` and retry. |
| Claude won't use the board | Confirm the skill is installed (§3) and you've restarted the session; for borderline tasks, explicitly ask it to "plan this on the board." |
| Several agents collide on one board | Give each a distinct identity via `KANBAN_AGENT` (or `--as <id>`); the default `agent` identity is shared. |
| Web UI won't load | Re-run `kanban open` to mint a fresh token URL; confirm the server is up with `kanban board show`. |

---

## 10. Where to go next

- `docs/05-cli-reference.md` — every CLI command, flag, and exit code.
- `docs/06-skill.md` — the full behavioural spec the skill encodes.
- `docs/04-human-in-the-loop.md` — the durable ask → yield → resume model in depth.
- `docs/03-token-efficiency.md` — why the read ladder is the way it is.
- `docs/00-overview.md` — architecture and design rationale.
