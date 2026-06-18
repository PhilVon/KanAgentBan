# 03 — Token Efficiency (Flagship)

> **Summary:** The board exists so an agent can offload task state and reload only
> the *relevant slice* cheaply. Every read is tiered (cheap → rich), output is a
> stable parseable contract, payloads are budgeted in **tokens** with deterministic
> truncation that is **never silent**, and mid-task refresh is a scoped delta over
> an event log. The server does zero LLM work — all curation is structural.
>
> **Decisions:** Progressive disclosure with a one-shot cold-start (`next
> --context`); counts-over-contents by default; deterministic truncation + always
> a footer; direct deps only (no transitive expansion); model-free server.
>
> **Resolved:** the context tier now budgets by **default** (`2000` tokens; opt
> out with `--full` / `--max-tokens 0`), and every `--json` read carries an
> `est_tokens` meter (`chars/4`). Format-version `2`.

Related: [02-data-model](02-data-model.md) · [05-cli-reference](05-cli-reference.md) ·
[04-human-in-the-loop](04-human-in-the-loop.md)

---

## 1. Why this is the whole point

A naive "dump the board as JSON" can be thousands of tokens and grows with the
project. An agent rarely needs the whole board — it needs *the next thing to do*
and *the working set of the task it's on*. The design optimizes for those two
flows and makes everything else opt-in.

| Flow | Command | Rough budget |
|------|---------|--------------|
| "What should I do?" | `kanban next` | ~40–80 tokens |
| Cold start on a task | `kanban next --context` / `kanban context T-12` | a few hundred |
| "What changed since I looked?" | `kanban watch T-12 --since <seq>` | tens |
| Scan the board | `kanban list` | ~15 tokens/task |
| Whole-board dump (avoided) | `kanban list --json --limit 0` | thousands |

The skill ([06-skill](06-skill.md)) steers the agent to the narrowest command
that answers its question.

---

## 2. Tiered / progressive disclosure

```
next         → 1 ready task, ~5 lines, + one-clause "why"
next --context → that task + full working set (ONE call — cold start)
list         → compact one-line-per-task
show <id>    → medium: summary + counts + last 3 comments
context <id> → full curated working set (the flagship payload)
```

Each tier is a strict superset of detail. The agent climbs only as far as it needs.

---

## 3. The `context <id>` working-set spec

Fixed section order, fixed headers (a parseable contract), each section
**independently truncatable** with its own footer. Order reflects what an agent
needs first:

1. **Task line** — id, title, status, priority, summary
2. **Acceptance criteria** — checklist with checked state (`3/5`)
3. **Direct deps only** — blockers (id+title+status) and tasks blocked-by-this.
   Transitive blockers shown as a **count**, never expanded (a token bomb).
4. **Open input requests** — `Q-n` + question (+ options)
5. **Comments** — last N (default 3–5), newest first, author-tagged
6. **Artifacts** — title + URI only (**never inline contents**)
7. **Labels**

### Sample output (plaintext, format-version 1)

```
T-12 [P1] In Progress  "Wire up OAuth callback"
summary: exchange code for token, persist session, redirect to /app

criteria 1/3:
  [x] AC-31 redirect URL registered
  [ ] AC-32 token exchange handles error responses
  [ ] AC-33 session cookie set with SameSite=Lax

blockers (1): T-08 Refactor token store [In Progress]
blocks (2): T-15, T-16
transitive blockers: 1 more upstream

open input (1):
  Q-7 "Which auth provider?"  options: Auth0 | Cognito

comments (last 3 of 9, newest first):
  user/phil  2h   "use the existing http client, don't add axios"
  agent/claude 2h "scaffolded the callback route"
  system     3h   "moved Backlog → In Progress"
  [+6 older comments — context T-12 --full]

artifacts (2):
  pr   "auth callback PR"  https://github.com/acme/app/pull/42
  file "callback route"    src/auth/callback.ts

labels: auth, backend
```

The trailing bracketed lines are **truncation footers** — see §4.

---

## 4. Token budgeting & the truncation contract

- Budget is in **tokens**, not bytes: `--max-tokens N` (`chars/4` heuristic, the
  same `estimateTokens` the `--json` meter reports — §5). The context tier applies
  a **default ceiling of `2000` tokens** when `--max-tokens` is omitted, so a
  cold-start read is bounded even for a token-bomb task; opt out with `--full` or
  `--max-tokens 0`. `--max-tokens` (and `--full`) are honoured on **every read
  tier** — `list`, `next`, `show`, and `context`; only `context` carries the
  default ceiling, so `list`/`next`/`show` stay unbudgeted unless asked.
- Truncation degrades **gracefully** in a fixed precedence per tier, re-estimating
  after each rung and stopping as soon as it's under budget:
  - **context**: (1) shed oldest comments (floor: newest 1), (2) collapse criteria
    to a count, (3) trim the summary, then (4) drop whole trailing sections,
    lowest-priority first.
  - **show**: shed recent comments → drop open-input detail → trim the summary
    (the header + counts line is never dropped).
  - **list** / **next**: drop whole trailing rows / candidates (already
    rank-ordered, so the tail is lowest value); `next`'s usage hint is never dropped.
  Deterministic, so output is stable.
- Truncation is **never silent**. Every rung emits a footer naming what was
  hidden and how to get it:
  ```
  [+6 older comments — context T-12 --full]
  [criteria collapsed — context T-12 --full]
  [summary trimmed — context T-12 --full]
  [2 section(s) hidden for token budget — context T-12 --full]
  [recent comments hidden — show T-12 --full]
  [+4 tasks hidden for token budget — kanban list --full]
  [+2 candidates hidden for token budget — kanban next --full]
  ```
  Silent dropping is the cardinal sin: an agent that can't see what it's missing
  makes confident decisions on missing context.
- **Counts over contents** everywhere by default: `criteria 1/3`, `blockers (1)`,
  `comments (last 3 of 9)`. Numbers are nearly free; expansion is opt-in.
- A **token meter** rides every `--json` read (`est_tokens`, the `chars/4`
  estimate of the plaintext-equivalent render) so an agent can budget across reads.

---

## 5. Output is a contract

- Terse plaintext default; `--json` opt-in for machine parsing.
- Stable field order, stable section headers, no decorative noise.
- No ANSI colour when stdout is not a TTY.
- Versioned: `--format-version` (current `3`); changes bump the version so a
  pinned agent/skill never silently breaks. **v2** added the `est_tokens` field to
  `--json` reads and the context-tier graceful-degradation truncation footers (§4);
  **v3** extended `--max-tokens` budgeting (and its never-silent footers) to the
  `list`, `next`, and `show` tiers.

This lets the skill and the agent regex specific fields without re-reading prose.

---

## 6. The recommendation engine (`next`)

```
candidates = tasks WHERE ready            (see 02-data-model §5)
rank by:   priority desc
        →  created_at asc
        →  fewest remaining blocker deps
tiebreak:  sticky bias to the most-recently-touched still-ready task
```

- The **sticky bias** stops `next` from yanking focus between equal-rank tasks
  mid-work.
- `next` always surfaces a one-clause **why** (`highest priority ready task; you
  touched it last`) — agents act better with the rationale.
- **Empty result explains itself** (never blank):
  ```
  no ready tasks. 3 blocked: T-4 needs input (Q-7), T-7 waits on T-2, T-9 waits on T-2
  ```

---

## 7. Cold start vs mid-task refresh

**Cold start (new turn/session, no context):**
```
kanban next --context      # one call: the task to do + its full working set
```
Avoids the round-trip of `next` then `context`, and avoids the agent
re-deriving what it just asked for.

**Mid-task refresh (already loaded, want only the delta):**
```
kanban watch T-12 --since <seq>     # only events touching T-12 + its direct deps
```
Returns the new high-water `seq` to use next time. Reserve the board-wide
`kanban changes --since <seq>` for "what changed anywhere". Most refreshes are
single-task, so the cheap path is the scoped one.

---

## 8. Failure modes & how they're handled

| Failure | Handling |
|---------|----------|
| **Stale/expired cursor** | server returns `{reset:true, snapshot_cursor}`; agent does a full re-list. Never a silent partial window. |
| **Cursor portability** | `seq` is per-board; documented as non-portable. |
| **Summary drift** | store `summary_updated_at` + `description_updated_at`; when description is newer, render `[summary may be stale]`. Manual refresh via `kanban summarize`. Server **never** auto-summarizes. |
| **Recommendation thrash** | deterministic tiebreak + sticky bias (§6). |
| **Comment-thread bloat** | default last-N + count; full only on `--full`. |
| **Transitive-dep explosion** | direct deps only; transitive shown as a count. |

---

## 9. Invariant: the server stays model-free

No summarization, ranking-by-LLM, or any model call happens server-side. Every
token optimization here is **structural** — tiers, counts, scoped deltas,
deterministic truncation. This keeps the board fast, deterministic, testable, and
free to run, and keeps all model spend on the agent side where it's visible and
controllable.
