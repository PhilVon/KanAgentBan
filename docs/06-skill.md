# 06 — Claude Code Skill (SKILL.md)

> **Summary:** KanAgentBan ships a Claude Code **skill** that wraps the `kanban`
> CLI. It does not add capability — it teaches the agent *when* the board earns
> its keep, *which* narrow command answers a given question, and *how* to behave
> at a human gate. The skill encodes three discipline tables: the token-tiered
> read ladder ([03](03-token-efficiency.md)), the ask → await → yield → inbox
> decision tree ([04](04-human-in-the-loop.md)), and exit-code branching
> ([05](05-cli-reference.md)). The server auto-starts; the skill just drives it.
>
> **Decisions:** Default human-in-the-loop = **durable-async** (ask, short
> `await`, else yield, resume from `inbox`) — never block a turn for human
> timescales. Always reach for the narrowest read first (`next` before `context`,
> `watch --since` before `changes`). Branch on semantic exit codes, not parsed
> prose. The skill bundles the CLI + server + static UI (or an installer).
>
> **Open questions:** Whether the skill should auto-run `board init` on first use
> or require an explicit setup step; whether trigger phrases should include
> generic "track this work" or stay scoped to multi-step decomposition.

Related: [03-token-efficiency](03-token-efficiency.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md) ·
[05-cli-reference](05-cli-reference.md)

---

## 1. Purpose & scope

The skill is a thin behavioural layer over `kanban`. The CLI already exposes the
full surface ([05](05-cli-reference.md)); the skill's job is **judgement**:

- Decide whether a request warrants the board at all.
- Pick the cheapest read that answers the current question.
- Keep board state honest as work progresses (statuses, criteria, comments,
  artifacts).
- Handle a human decision the durable-async way instead of stalling a turn.

The skill invents **no commands** — everything it does is a documented `kanban`
invocation. If a behaviour isn't expressible in [05](05-cli-reference.md), the
skill doesn't do it.

---

## 2. When to use the board (and when not)

**Use it when** the work is stateful or multi-step:

- The request decomposes into more than one task → create tasks with deps.
- Progress spans tool calls/turns and must survive a cold start.
- Decisions or artifacts (PRs, files, outputs) are worth recording as references.
- A decision needs the human → surface it as a durable `Q-n`.

**Skip it when** the request is a trivial one-shot — a single answer, a one-line
edit, a quick lookup. Spinning up tasks for atomic work is pure overhead and
adds tokens with no payoff. The board is for *carrying state*, not for narrating
work that fits in one turn.

---

## 3. Token discipline — the read ladder

The skill always reaches for the **narrowest read that answers the question**
([03-token-efficiency](03-token-efficiency.md)). Climbing the tiers is opt-in;
the agent stops as soon as it has enough.

| Question the agent has | Command | Why it's cheapest |
|------------------------|---------|-------------------|
| "What should I do next?" | `kanban next` | ~1 task, ~5 lines, + a *why* |
| "I'm cold — give me a task and its working set" | `kanban next --context` | one call, no re-derive |
| "Reload just this task" | `kanban context T-12` | flagship working set, truncated |
| "What changed since I looked?" | `kanban watch T-12 --since <seq>` | scoped delta, tens of tokens |
| "Scan the board" | `kanban list` | ~15 tokens/task |

Rules the skill enforces:

- **Never dump the whole board.** `kanban list --json --limit 0` is a token bomb;
  use `next`/`context` instead.
- **Trust the truncation footers.** Counts (`comments (last 3 of 9)`,
  `blockers (1)`, `criteria 1/3`) are nearly free; only expand with `--full` when
  a specific hidden item is actually needed.
- **Refresh with the scoped delta.** Prefer `watch <id> --since <seq>` over the
  board-wide `changes --since <seq>`; carry the returned high-water `seq`.

---

## 4. Workflow guidance at task start

When the agent picks up a task, the skill steers it through:

1. **Load context once.** Cold start → `kanban next --context`. Already chose a
   task → `kanban context T-12`. Don't run `next` then `context` separately.
2. **Keep status current.** `kanban move T-12 "In Progress"` on pickup;
   `kanban done T-12` on completion (which recomputes dependents' readiness).
   Being *blocked* is derived — never moved to.
3. **Make acceptance criteria explicit and tick them.**
   `kanban criterion add T-12 "token exchange handles errors"`, then
   `kanban criterion check AC-32` as each lands. Criteria are the agent's own
   definition-of-done contract.
4. **Comment meaningfully, not chattily.** `kanban comment T-12 "..."` for
   decisions and non-obvious choices — not a play-by-play. Comment threads are
   default-truncated, so signal beats volume.
5. **Record artifacts as references, never contents.**
   `kanban artifact T-12 --kind pr --title "auth callback PR" --uri <url>`.
   The board stores the pointer; the contents live where they live.

---

## 5. Human-in-the-loop decision tree

The skill's default for any human decision is **durable-async** — it does *not*
hold a turn open on human timescales ([04-human-in-the-loop](04-human-in-the-loop.md)).

```
need a human decision?
        │
        ▼
 kanban ask T-12 "Which auth provider?" --options Auth0,Cognito
        │   → returns Q-7 immediately (non-blocking); task now needs_input
        ▼
 kanban await Q-7 --timeout 60      (fast gate ONLY — short, bounded)
        │
   exit 0 ─────────────▶ answered: use the answer, continue T-12
        │
   exit 2 (pending) ───▶ YIELD THE TURN:
        │                  • pick up other work:  kanban next
        │                  • or end cleanly:  "Paused T-12 on Q-7, awaiting input."
        ▼
 --- later / new session ---
 kanban inbox          → Q-7 answered: Auth0  (task T-12 ready again)
 kanban context T-12   → reload working set, resume
```

Key points the skill carries:

- **`await` is for short gates only.** Its exit `2` is *pending*, **not an
  error** — that's the signal to fall back to yield-and-resume.
- **Yielding is the optimal path**, not a fallback compromise: no held
  connection, survives session boundaries, keeps the agent productive on other
  ready tasks.
- **`inbox` is the resume entry point.** An answered request also flips its task
  back to `ready`, so plain `next` surfaces it implicitly; `inbox` is the
  explicit check.
- **Multiple open questions** are fine. Wait on one (`await Q-7`), any on a task
  (`await --task T-12`), or anything (`await --any`).

---

## 6. Branching on exit codes

The skill branches on **semantic exit codes**, never on parsed prose
([05-cli-reference](05-cli-reference.md)):

| Code | Meaning | Skill's response |
|------|---------|------------------|
| `0` | success / answered | proceed |
| `1` | generic error | report; do not retry blindly |
| `2` | `await` timed out, request still **pending** | yield + resume from `inbox` (§5) |
| `3` | not found | the `T-n`/`Q-n` is wrong — re-`list`/`inbox` to re-derive |
| `4` | conflict (stale optimistic `version`) | re-read (`context`/`show`), then retry the write with the fresh `--expect-version` |
| `5` | auth / server unreachable | ensure the server is up (§7); check `.kanban/` board |

---

## 7. Server auto-start & showing the UI

- The CLI **auto-starts** the server: any command health-checks it and launches
  `kanban serve` detached if it's down, then proceeds. The skill relies on this —
  it does not manually manage the process under normal operation.
- A persistent exit `5` means the server is genuinely unreachable or the board
  isn't initialized; the skill then verifies `.kanban/` exists (`board init`,
  §8) or surfaces the failure.
- To bring the human into the loop visually, `kanban open` mints a one-time UI
  token URL and opens the web board — useful right after an `ask`, so the human
  can answer the `Q-n` in the UI.

---

## 8. Bundled assets & setup

The skill bundles the runnable system so the agent has a working board out of
the box:

- the `kanban` **CLI** (agent-facing surface),
- the local **server** (REST + WebSocket, model-free),
- the static **web UI** (where the human reads the board and answers questions),
- or, equivalently, an **installer** that provisions all three.

First-time setup per project:

```
kanban board init --name "KanAgentBan"   # creates .kanban/ + DB + token
kanban board show                        # confirm board id, port, db path
```

After init, the CLI resolves the board by walking up from CWD to the `.kanban/`
marker; `--board <path>` overrides.

---

## 9. Command cheat-sheet

Grouped to match [05-cli-reference](05-cli-reference.md). The skill steers to the
**narrowest** command in each group.

| Group | Command | Use |
|-------|---------|-----|
| **Read / context** | `kanban next [--context] [--n N]` | what to do next (cold start with `--context`) |
| | `kanban context <id> [--full] [--max-tokens N]` | flagship working set for one task |
| | `kanban show <id>` | medium detail |
| | `kanban list [--status S] [--label L] [--limit N]` | compact board scan |
| | `kanban watch <id> --since <seq>` | scoped mid-task refresh |
| | `kanban changes --since <seq>` | board-wide delta (reserve) |
| **Write / workflow** | `kanban add "<title>" [--depends T-3,T-4] [--ac "..."]` | create a task |
| | `kanban update <id> [...] [--expect-version N]` | edit fields (concurrency-safe) |
| | `kanban move <id> <column>` | set workflow status |
| | `kanban dep add\|rm <id> --on <id>` | manage blocking edges |
| | `kanban comment <id> "<body>"` | record a decision/note |
| | `kanban criterion add\|check <id\|AC-id> [--off]` | manage acceptance criteria |
| | `kanban label <id> --add\|--rm L` | labels |
| | `kanban artifact <id> --kind ... --title T --uri U` | record a reference |
| | `kanban summarize <id> "<summary>"` | manual summary refresh |
| **HITL** | `kanban ask <id> "<q>" [--options a,b]` | create durable `Q-n` (non-blocking) |
| | `kanban await <Q-id\|--task <id>\|--any> [--timeout S]` | short gate only (exit `2` = pending) |
| | `kanban answer <Q-id> "<text>"` | CLI answer (testing/automation) |
| | `kanban inbox` | resume entry point |
| **Lifecycle** | `kanban board init [--name N]` | provision `.kanban/` |
| | `kanban open` | show the human the UI |
| | `kanban done <id>` / `kanban archive <id>` | complete / soft-delete |
| | `kanban export [--out FILE]` | backup |

---

## 10. Recipes

**(a) Start a multi-step feature — tasks with deps.**
```
kanban add "Refactor token store" --prio P2
# → T-08
kanban add "Wire up OAuth callback" --prio P1 --depends T-08 \
  --ac "redirect URL registered" --ac "token exchange handles errors"
# → T-12  (blocked by T-08 until it's done)
```

**(b) Cold-start a session — one call.**
```
kanban next --context
# → T-12 + its full working set; begin immediately, no second round-trip
```

**(c) Hit a decision — ask, yield, resume from inbox.**
```
kanban ask T-12 "Which auth provider?" --options Auth0,Cognito   # → Q-7
kanban await Q-7 --timeout 60                                    # exit 2: pending
# yield: "Paused T-12 on Q-7 (auth provider). Picking up T-08."
kanban next
# --- later / new session ---
kanban inbox            # Q-7 answered: Auth0  (T-12 ready)
kanban context T-12     # reload, continue
```

**(d) Refresh mid-task — scoped delta.**
```
kanban watch T-12 --since 142
# → only events touching T-12 + its direct deps; returns the new high-water seq
```

---

## 11. SKILL.md frontmatter sketch

```yaml
---
name: kanagentban
description: >
  Agent-first kanban board for decomposing and tracking multi-step work.
  Wraps the `kanban` CLI. Use to create tasks with dependencies, keep
  statuses/criteria current, record decisions and artifacts, and surface
  decisions that need the human via durable input requests (ask → yield →
  inbox). Prefers the narrowest cheap read (`next`, `context`, `watch`).
when-to-use: >
  Trigger when the user asks to plan, decompose, or track multi-step work;
  "make a plan / break this down / track progress / what's next / pause for
  my decision / what changed". Do NOT trigger for trivial one-shot requests.
---
```

The body of `SKILL.md` is this document's operative guidance: the read ladder
(§3), the workflow checklist (§4), the human-in-the-loop decision tree (§5), the
exit-code branch table (§6), and the cheat-sheet (§9). Everything maps 1:1 to a
documented `kanban` command — no new surface.
