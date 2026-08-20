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

- The request decomposes into more than one task → create tasks with deps, and
  nest fine-grained pieces as **subtasks** (`add --parent` / `parent --to`).
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
| "What happened while I was away?" | `kanban standup [--since <cursor>]` | one narrative diff instead of re-reading the board |
| "Is the board healthy?" | `kanban doctor` | findings only, each naming its fix **and what its check cannot see**; exit `2` = act |
| "What should I do next?" | `kanban next` | ~1 task, ~5 lines, + a *why* |
| "I'm cold — give me a task and its working set" | `kanban next --context` | one call, no re-derive |
| "Reload just this task" | `kanban context T-12` | flagship working set, truncated |
| "What changed since I looked?" | `kanban watch T-12 --since <seq>` | scoped delta, tens of tokens |
| "Scan the board" | `kanban list` | ~15 tokens/task |

At session start the skill runs `standup` (saving the printed cursor for next
time) and `doctor`, acting on any findings, before entering the work loop.

Rules the skill enforces:

- **Never dump the whole board.** `kanban list --json --limit 0` is a token bomb;
  use `next`/`context` instead.
- **Trust the truncation footers.** Counts (`agent notes (last 2 of 8)`,
  `blockers (1)`, `criteria 1/3`) are nearly free; only expand with `--full` when
  a specific hidden item is actually needed. (User comments are kept, not counted.)
- **Refresh with the scoped delta.** Prefer `watch <id> --since <seq>` over the
  board-wide `changes --since <seq>`; carry the returned high-water `seq`.

---

## 4. Workflow guidance at task start

When the agent picks up a task, the skill steers it through:

1. **Load context once.** Cold start → `kanban next --context`. Already chose a
   task → `kanban context T-12`. Don't run `next` then `context` separately.
2. **Move through the columns.** The five workflow statuses, in order, are
   **Backlog → Ready → In Progress → Review → Done** (plus a *derived* **Blocked**
   the UI shows for `needs_input` / dep-blocked / open-subtask tasks — never a
   `move` target). The keystone the skill carries: **`kanban next` only recommends
   `Ready` and `In Progress`** ([recommend.ts]/[derive.ts] `ready`), so a `Backlog`
   task is parked and invisible to the work loop until promoted — moving it to
   `Ready` is what *queues* it. On pickup move to `In Progress`; when work is done
   but needs a human/peer sign-off move to `Review` (the natural pairing with a
   sign-off `ask`, §5); `kanban done T-12` on acceptance (recomputes dependents'
   readiness). Only these five names are valid `move`/`--status` targets — an
   unknown column (e.g. `"To Do"`) is rejected with exit `1`.
3. **Make acceptance criteria explicit and tick them.**
   `kanban criterion add T-12 "token exchange handles errors"`, then
   `kanban criterion check AC-32` as each lands. Criteria are the agent's own
   definition-of-done contract.
4. **Read user comments as directives; comment back meaningfully.** Comments are a
   two-way channel. The human leaves `user` comments to steer the agent — read them
   before starting/resuming and treat them as instructions (`next` flags a waiting
   one, `show`/`context` print a protected **user comments** block, `list` marks the
   task `💬n*`). Then `kanban comment T-12 "..."` for the agent's own decisions and
   non-obvious choices — not a play-by-play. Agent notes are shed first under
   budget; **user comments are protected** (shed last), so a directive won't vanish.
5. **Record artifacts as references, never contents.**
   `kanban artifact T-12 --kind pr --title "auth callback PR" --uri <url>`.
   The board stores the pointer; the contents live where they live.
   For git work: start on a conventional branch (`kanban git branch T-12
   --checkout` → `T-12-slug`), mention `T-n` in commit subjects (or install the
   hooks once), run `kanban git link` after committing, and attach the PR URL as
   a `pr` artifact when you open one.
6. **Write knowledge worth keeping as a doc, not a comment.** Comments are notes
   *about one task*; a **doc** is durable knowledge that outlives it (the one
   place the board stores content — ADR 0007). Rules of thumb: a hard-to-reverse
   decision → `kanban doc add "…" --kind adr --link T-12`; reusable research
   findings → `--kind research`; a design that governs several tasks →
   `--kind design --link T-12,T-13`. Always set `--summary` — that's all the
   list/context tiers show; the body costs tokens only via `doc show D-n`.
   Linked docs surface in `context` as a `docs (n):` section — read the summary,
   pull the body only when you actually need it.

7. **Checkpoint before pausing.** Whenever the agent yields, ends a turn
   mid-task, or parks a task on an `ask`, it writes the one-slot resume pointer
   first: `kanban checkpoint T-12 "did X, next Y, watch Z"` (latest wins). It
   renders first in `show`/`context` and is flagged by `next`, so the next
   session resumes from it instead of re-deriving state from notes.

**When a criterion is knowable.** "Plan this on the board" is three different jobs,
separated by *what the agent already knows when it writes the criteria* — and getting
it wrong is the commonest way a board goes stale, because a criterion written before
its premise was checked can only be ticked falsely, left unchecked forever, or
escalated as a question the agent created for itself. **From a doc or spec:** the doc
is the source of truth, so write the full set up front (the case the rest of §4
assumes). **From a plan already made** (plan mode, or a design agreed in chat): this
is *transcription, not planning* — put the agreed plan on the board rather than
re-deriving it and quietly arriving somewhere else. **From a reported defect** (a
symptom, a screenshot, "this feels wrong"): the task is not writable yet and neither
is most of the criteria list — **diagnose first, then write the task**; filing it
after the investigation is correct, not sloppy.

Within all three, the skill separates two kinds of criterion and writes them at
different moments:

- **Promises** — what a person will be able to do or see. Stable under any
  implementation, so they can be written as early as the agent likes.
- **Hypotheses** — claims about *mechanism*, which embed assumptions about code the
  agent may not have read. Wait until it has. A hypothesis that turns out wrong is
  still useful — testing it is often how the real mechanism gets found — but when one
  falls, the skill says so in a `comment` naming what replaced it and files the
  successor, rather than leaving an unchecked box that reads as unfinished work.

**Review gate.** `Review` is a human/peer sign-off column, not more agent work.
The human resolves it with `kanban review approve T-12` / `review reject T-12
--reason "…"` (or the UI's card buttons); a rejection kicks the task back to
`In Progress` with the reason recorded as a comment — the skill reads it before
resuming.

**Claiming in a fleet.** With several agents on one board (distinct
`KANBAN_AGENT` each), `kanban claim T-12` reserves a task so peers' `next` skips
it. Prefer `claim --ttl 900` — a lease the server auto-releases past due
(re-claim to renew), so a crashed agent never wedges the task. `done` needs no
release; `release` returns an unfinished task to the pool.

**Templates.** For repeated task shapes (PR checklist, spike), `kanban template
save <name> --from T-n` snapshots criteria/labels/subtask skeleton and
`template apply <name> "<title>"` recreates the tree atomically — cheaper than
re-authoring the same criteria.

**Subtasks (decomposition).** When a task splits into pieces, nest children under
it — a single-parent tree, distinct from `blocks` deps: `kanban add "step"
--parent T-8`, or re-nest/detach an existing task with `kanban parent T-12 --to
T-8` / `--clear`. The one behaviour the agent must carry: **a parent with open
subtasks is hidden from `next` and cannot `move`/`done` to Done until its children
finish** (rejection = exit `1`); self-parenting and cycles are rejected.

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
   exit 0 ─────────────▶ resolved: answered → use the answer, continue T-12;
        │                            cancelled/expired → request is gone, drop or re-ask
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
  error** — that's the signal to fall back to yield-and-resume. Exit `0` means
  *resolved*: answered, **or** cancelled/expired (it prints `Q-n answered: …` /
  `Q-n cancelled` / `Q-n expired`) — a resolved-without-answer request is gone, so
  drop it or re-`ask`.
- **Withdraw and expiry.** `kanban cancel Q-7` retracts an open request the agent
  no longer needs (clears the task's needs-input); `kanban ask … --expires-at <ISO>`
  sets a TTL after which the request auto-expires. Both surface in `inbox` under
  **resolved**.
- **Default-on-expiry.** `ask … --default X --expires-at <ISO>` resolves as
  `answered (defaulted)` at expiry instead of dead-ending, keeping the agent
  unblocked when the human is away. Use it for reversible choices with a safe
  fallback — never for destructive ones.
- **Yielding is the optimal path**, not a fallback compromise: no held
  connection, survives session boundaries, keeps the agent productive on other
  ready tasks.
- **`inbox` is the resume entry point.** It buckets requests into **open /
  answered / resolved** (resolved = cancelled/expired), resolutions first as the
  resume signal. An answered request also flips its task back to `ready`, so plain
  `next` surfaces it implicitly; `inbox` is the explicit check.
- **Multiple open questions** are fine. Wait on one (`await Q-7`), any on a task
  (`await --task T-12`), or anything (`await --any`).
- **An answer given in chat is not an answer.** The skill is emphatic that a
  question goes *on* the board and was silent about the answer coming back *off*
  it — which, in a chat-plus-board setup, is most of the time. So when the human
  replies in conversation rather than on the card, the agent writes it back with
  `kanban answer <qid> "…"` **before** acting on it. Otherwise the durable record
  and the thing acted on are two different objects: the request sits open beside
  finished, merged work, reading as something the human still owes, and the agent
  reports a clean board that isn't. `doctor`'s `answered-elsewhere` catches the
  residue; writing it back is what stops it happening.
- **Measure the numbers in an `ask`, or mark them as estimates.** A request renders
  every sentence with the same authority, to a reader who cannot see where any of it
  came from — so an unmeasured figure reads as a fact. The skill says to state the
  tradeoff and said nothing about provenance, and measuring costs a turn, so the pull
  is toward the confident estimate. Unmeasured numbers carry *roughly* or *I estimate*
  in the sentence itself; the human is spending a decision and is entitled to know
  which parts are load-bearing.
- **A watch is not a question.** When the agent needs an *event* rather than a
  decision ("tell me when the files land"), it reaches for `kanban expect <id>
  "<event>"`, not `ask`. A watch does not set `needs_input`, so the task is parked
  instead of rendered Blocked and the human is not implicitly chased for an answer
  that does not exist; it resolves with `answer` when the event happens, or
  `cancel` to drop the trigger ([04 §2](04-human-in-the-loop.md)).
- **Write a well-formed `ask`.** The human answers from the board alone — they
  don't see the agent's chat or reasoning. So the question must be **self-contained
  and carry the tradeoff** (not `"Which one?"`), each `ask` raises **one** decision
  (separate `Q-n`s answer independently), and the answer is shaped with `--options
  a,b` (closed, mutually-exclusive set; short distinct labels) or `--freeform` (open
  answer — a value, path, or prose). The two flags are **companions, not
  alternatives**: pass *both* whenever the options are the agent's best guesses rather
  than an exhaustive set, so the human can pick one or say the thing the agent failed
  to imagine — a set of three the agent invented is a poor reason for someone to have
  to reach for "Other" to report something it needed to hear. If the `ask` is a
  **sign-off gate**, move the task to `Review` first so the board shows *why* it's
  parked.

---

## 6. Branching on exit codes

The skill branches on **semantic exit codes**, never on parsed prose
([05-cli-reference](05-cli-reference.md)):

| Code | Meaning | Skill's response |
|------|---------|------------------|
| `0` | success / resolved (answered, or cancelled/expired) | proceed; if `await` resolved without an answer, drop or re-`ask` |
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

### Installing the skill (and detecting drift)

`skill/SKILL.md` + `docs/` in the repo are the **source of truth**; the copy under
`<CLAUDE_CONFIG_DIR>/skills/kanban/` (default `~/.claude`) is *derived*:

```
npm run install-skill              # sync skill/ + docs/ -> <config>/skills/kanban/
npm run install-skill -- --check   # exit 2 on drift, 0 when the copy matches
```

A sync copies added/changed files and removes files no longer in source, printing
a per-file count (and naming every removal — never silent).

`--check` exists because the derived copy is **editable in place**, and an edit made
there lives nowhere else. That happened: two sections (§4 *when a criterion is
knowable* and the `--options`/`--freeform`-are-companions rule in §5) were written
straight into the installed `SKILL.md` and existed only there for a month — an
install run at any point in that window would have destroyed them. So the ordering
is a rule, not a preference: **on a `differs` finding, diff the installed file and
backport anything only it has before syncing.** `--check` is a *local* check by
design — a fresh CI checkout has no installed copy, so it would report every file
missing. Its home is the machine that has the copy: run it after a pull, and as a
release step, so drift is noticed on purpose rather than discovered by losing work.

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
| **Read / context** | `kanban standup [--since <cursor>\|--days N]` | session-start narrative catch-up |
| | `kanban doctor` | hygiene sweep; exit `2` = findings to act on |
| | `kanban next [--context] [--n N] [--mine]` | what to do next (cold start with `--context`) |
| | `kanban context <id> [--full] [--max-tokens N]` | flagship working set for one task |
| | `kanban show <id>` | medium detail |
| | `kanban list [--status S] [--label L] [--limit N]` | compact board scan |
| | `kanban watch <id> --since <seq>` | scoped mid-task refresh |
| | `kanban changes --since <seq>` | board-wide delta (reserve) |
| **Write / workflow** | `kanban add "<title>" [--parent T-1] [--depends T-3,T-4] [--ac "..."]` | create a task (or subtask with `--parent`) |
| | `kanban update <id> [...] [--expect-version N]` | edit fields (concurrency-safe) |
| | `kanban move <id> <column>` | set workflow status (`T-1,T-2,…` = one atomic bulk move) |
| | `kanban claim\|release <id> [--ttl S] [--force]` | reserve/return a task (lease auto-releases past due) |
| | `kanban checkpoint <id> "…"\|--clear` | one-slot resume pointer before pausing |
| | `kanban review approve\|reject <id> [--reason "…"]` | the human's Review sign-off gate |
| | `kanban dep add\|rm <id> --on <id>` | manage blocking edges |
| | `kanban parent <id> --to <pid>\|--clear` | nest as subtask / detach (single-parent tree) |
| | `kanban comment <id> "<body>"` | record a decision/note |
| | `kanban criterion add\|check <id\|AC-id> [--off]` | manage acceptance criteria |
| | `kanban label <id> --add\|--rm L` | labels |
| | `kanban artifact <id> --kind ... --title T --uri U` | record a reference (incl. commit/branch/pr) |
| **Git** | `kanban git branch T-n --checkout` | start work on the conventional `T-n-slug` branch |
| | `kanban git link [T-n]` | record commits/branches mentioning T-n as artifacts (idempotent) |
| | `kanban git status [T-n]` | board artifacts + live PR/CI state (gh, on demand) |
| | `kanban git install-hooks` | auto-tag commits `[T-n]` + auto-link after each commit |
| | `kanban summarize <id> "<summary>"` | manual summary refresh |
| **Docs** | `kanban doc add "<title>" --kind adr\|design\|spike\|research\|note [--link T-1]` | durable knowledge (ADR, design, research) |
| | `kanban doc show <D-id> [--full]` | one doc's body (budgeted) |
| | `kanban doc update <D-id> [--status S] [--superseded-by D-n]` | lifecycle: draft → accepted → superseded |
| | `kanban doc link\|unlink <D-id> <T-id>` | attach docs to tasks (many-to-many) |
| | `kanban docs [--kind K] [--task T-1]` | scan doc titles + summaries |
| | `kanban search "<q>" [--type task\|doc\|comment]` | find prior work before re-researching |
| **Brainstorm** | `kanban brainstorm start "<topic>" [--task T-1]` | open an ideation session (>3 candidate approaches) |
| | `kanban brainstorm add <B-id> "<idea>" [--cluster N]` | capture fast, judge later |
| | `kanban idea score\|cluster\|promote\|drop <I-id>` | shape the pool; promote winners to tasks atomically |
| | `kanban brainstorm show\|list\|close` | review (clustered, score-ranked) / wrap up |
| **Templates** | `kanban template save <name> --from T-n` | snapshot criteria/labels/subtask skeleton |
| | `kanban template apply <name> "<title>" [--prio\|--parent]` | atomic tree create from a blueprint |
| | `kanban template list\|show\|delete` | manage blueprints |
| **HITL** | `kanban ask <id> "<q>" [--options a,b] [--expires-at ISO] [--default X]` | create durable `Q-n` (non-blocking; `--default` resolves at expiry) |
| | `kanban await <Q-id\|--task <id>\|--any> [--timeout S]` | short gate only (exit `2` = pending, `0` = resolved) |
| | `kanban answer <Q-id> "<text>"` | CLI answer (testing/automation) |
| | `kanban cancel <Q-id>` | withdraw an open request (clears needs-input) |
| | `kanban inbox` | resume entry point (open / answered / resolved) |
| **Reporting** | `kanban stats [id]` | board analytics / per-task timing (read-only, off the work loop) |
| **Lifecycle** | `kanban board init [--name N]` | provision `.kanban/` |
| | `kanban open` | show the human the UI |
| | `kanban done <id>` / `kanban archive <id>` | complete / soft-delete (`archive` takes bulk ids; an auto-archive policy can sweep aged Done tasks) |
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
kanban add "register redirect URL" --parent T-12     # → T-15, a subtask of T-12
# T-12 now can't reach Done until T-15 does
```

**(b) Cold-start a session — one call.**
```
kanban next --context
# → T-12 + its full working set; begin immediately, no second round-trip
```

**(c) Hit a decision — ask, yield, resume from inbox.**
```
kanban ask T-12 "Auth provider — Auth0 (managed, $) or Cognito (in our AWS, more wiring)?" --options Auth0,Cognito   # → Q-7
kanban await Q-7 --timeout 60                                    # exit 2: pending
kanban checkpoint T-12 "callback wired; blocked on Q-7 (provider); next: token exchange"
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

**(e) Explore a wide solution space — brainstorm, score, promote.**
```
kanban brainstorm start "how to bound event-log growth" --task T-30   # → B-2
kanban brainstorm add B-2 "compact with retained floor" --cluster keep-seq
kanban brainstorm add B-2 "rebuild state from snapshots" --cluster rebuild
kanban brainstorm add B-2 "cap by age not count" --cluster keep-seq
kanban idea score I-5 9 ; kanban idea score I-6 3 ; kanban idea score I-7 6
kanban idea promote I-5 --prio P1        # → T-34, atomically; provenance recorded
kanban idea drop I-6
# distill the outcome into an ADR, then:
kanban brainstorm close B-2
```
When to bother: more than ~3 candidate approaches, or the human should weigh in
(they can score/promote/discard from the web UI's Brainstorm panel). For a
binary choice, just `kanban ask`.

**(f) Record a decision as an ADR linked to the work.**
```
kanban doc add "Use Auth0 over Cognito" --kind adr --link T-12 \
  --summary "Auth0: managed, faster to ship; Cognito revisit at scale" \
  --body-file decision.md
# → D-3 [adr/draft]; after the human signs off:
kanban doc update D-3 --status accepted
# later, superseded by a new decision:
kanban doc update D-3 --superseded-by D-9
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
