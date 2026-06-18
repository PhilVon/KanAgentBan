# 04 — Human-in-the-Loop: Pause & Resume (Flagship)

> **Summary:** When an agent needs a human decision, it creates a **durable** input
> request and, by default, **yields its turn** rather than holding a connection
> open. The request persists in SQLite, surfaces in the UI, and is picked back up
> via `kanban inbox` — even in a later Claude Code session. A short blocking
> `await` exists for fast gates only.
>
> **Decisions:** Default = durable-async (ask → yield → inbox → resume). `await`
> long-poll is opt-in for short waits and returns *pending* (not an error) on
> timeout. Lost-wakeup race is closed by checking committed state before parking.
> Multiple open questions allowed per task/board.
>
> **Open questions:** External-nudge transport (webhook vs desktop notification)
> for v2 auto-resume.

Related: [02-data-model](02-data-model.md) · [05-cli-reference](05-cli-reference.md) ·
[07-api-reference](07-api-reference.md) · [06-skill](06-skill.md)

---

## 1. Why blocking is the wrong default

A human answers on human timescales — minutes, or tomorrow morning. Holding a
tool call / turn open that long is fragile (harness timeouts), wastes the turn,
and conflates "ask" with "block" so the agent can't do other useful work while
waiting. So the **request is durable and the agent yields**; blocking is a special
case for fast gates only.

---

## 2. Lifecycle

```
agent: kanban ask T-12 "Which auth provider?" --options Auth0,Cognito
        → input_request Q-7 created (status=open)
        → task T-12 now needs_input  (UI shows it in Blocked, "Needs your input")
        → event input.requested broadcast
        → returns "Q-7" IMMEDIATELY (non-blocking)

human:  answers Q-7 in the web UI  (or kanban answer Q-7 "Auth0")
        → input_request.status = answered, answer recorded
        → task T-12 needs_input clears → becomes ready again
        → event input.answered broadcast; any parked await resolves

agent:  kanban inbox   → sees Q-7 answered: Auth0 → resumes T-12
```

### input_request state diagram

```
        ask
   ─────────────▶  open ───────────────▶ answered   (human/CLI answers)
                    │  ▲
   cancel │         │  │ (re-ask creates a NEW Q-n; answered is immutable)
          ▼         │
      cancelled     └────────▶ expired   (optional --expires-at elapses)
```

`answered` is terminal and immutable — editing an answer means asking a new `Q-n`
([02-data-model §6](02-data-model.md)).

---

## 3. Three resume strategies

The skill carries this as a decision tree ([06-skill](06-skill.md)).

### (A) Short bounded wait — *fast gates only*
```
kanban ask T-12 "Use existing http client?" --options yes,no
kanban await Q-7 --timeout 60
```
Long-polls. On answer → prints answer, exit `0`. On timeout → prints `pending`,
**exit `2` (not an error)** — the skill then falls back to strategy (B).

### (B) Yield + resume later — **DEFAULT for real human-in-the-loop**
```
kanban ask T-12 "Which auth provider?" --options Auth0,Cognito
# then EITHER pick up other unblocked work:
kanban next
# OR end the turn cleanly: "Paused T-12 on Q-7, awaiting your input."
```
A later session resumes from board state:
```
kanban inbox          # Q-7 answered: Auth0
kanban context T-12    # reload working set, continue
```
This is the token- and reliability-optimal path: no held connection, survives
session boundaries, and lets the agent stay productive on other tasks.

### (C) External nudge — *v2*
On `input.answered` the server fires a webhook / desktop notification that a
wrapper uses to re-invoke Claude Code automatically. The answer-event hook is
designed now ([07-api-reference](07-api-reference.md)); the trigger ships later
([11-roadmap](11-roadmap.md)).

---

## 4. Cross-session resumption (first-class)

Because the request is durable, nothing is lost when a turn or session ends.

- `kanban inbox` is the **resume entry point**: input requests answered (or still
  open) since the agent last checked. Backed by a persisted "last seen request
  seq" so it's a cheap delta, not a full scan.
- An answered request flips its task `needs_input` → ready, so plain `kanban next`
  *also* surfaces it automatically — `inbox` is the explicit path, `next` the
  implicit one.

---

## 5. Timeouts, exit codes, multiple questions

- **`await` timeout** returns `pending`, never throws. Exit codes let the skill
  branch without parsing: `0`=answered, `2`=timeout-pending, `1`=error
  ([05-cli-reference](05-cli-reference.md)).
- **No hard request expiry by default** (humans are slow). Optional
  `--expires-at ISO` auto-cancels or applies a default answer.
- **Multiple open questions** are allowed per board and per task. A task is
  `needs_input` if *any* open request targets it. Wait variants:
  - `kanban await Q-7` — one specific request
  - `kanban await --task T-12` — any request on that task
  - `kanban await --any` — the next answer anywhere on the board
- Each question is answered independently in the UI.

---

## 6. The lost-wakeup race (and the fix)

If the human answers in the window *between* `ask` and `await`, a naive long-poll
that only listens for future events would hang forever. Fix:

1. `await` **checks committed state first** — if the request is already answered,
   return immediately.
2. Only if still `open` does it **park**, registering on the in-process event
   emitter (the same one feeding the WebSocket — [07](07-api-reference.md)).
3. Check-then-park happens under a lock, with a max timer for the timeout.

Wakeups are driven off the emitter, **not** DB polling, so resolution order is
consistent with the event `seq` order ([09-concurrency](09-concurrency.md)).

---

## 7. Worked end-to-end example

```
$ kanban context T-12
... (agent realizes it needs a decision) ...

$ kanban ask T-12 "Which auth provider?" --options Auth0,Cognito
Q-7  created on T-12 (task now needs input)

$ kanban await Q-7 --timeout 60
pending                               # exit 2 — human hasn't answered in 60s

# agent yields the turn: "Paused T-12 on Q-7 (auth provider). Picking up T-08."
$ kanban next
T-08 [P2] In Progress  Refactor token store
... agent works T-08 ...

# --- later, new session ---
$ kanban inbox
Q-7  answered: Auth0   (task T-12 ready)

$ kanban context T-12                  # reload, continue building the callback
```

This is the canonical flow the skill teaches: **ask, try a short await, else
yield, resume from `inbox`.**
