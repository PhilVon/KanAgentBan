# 04 — Human-in-the-Loop: Pause & Resume (Flagship)

> **Summary:** When an agent needs a human decision, it creates a **durable** input
> request and, by default, **yields its turn** rather than holding a connection
> open. The request persists in SQLite, surfaces in the UI, and is picked back up
> via `kanban inbox` — even in a later Claude Code session. A short blocking
> `await` exists for fast gates only. The agent **never** asks in chat only: a
> chat-only question is invisible to the board and lost at the session boundary, so
> every human decision is raised with `kanban ask`.
>
> **Decisions:** Default = durable-async (ask → yield → inbox → resume). `await`
> long-poll is opt-in for short waits and returns *pending* (not an error) on
> timeout. Lost-wakeup race is closed by checking committed state before parking.
> Multiple open questions allowed per task/board. External-nudge auto-resume
> (strategy C) is now shipped over both a webhook and a local command
> ([adr/0006](adr/0006-external-nudge-transport.md)).

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

### Two jobs, two kinds: `ask` vs `expect`

`ask` is the mechanism for a **decision** — something with an answer to choose,
which rightly parks the task `needs_input` until it is chosen. The *other* thing
an agent needs from a human is a **watch**: *tell me when X happens*. There is
nothing to decide; there is an event to wait for.

Before `expect`, a watch had no mechanism, so it got written as an `ask` and
behaved badly. It set `needs_input`, the UI derived **Blocked** from that, and it
sat for days looking like a question the human had failed to answer. The tell is
that **every remedy `doctor` offered was wrong for it**: *nudge the human* (there
is nothing to nudge — he knows), *re-ask* (resets a clock, changes no fact),
*cancel* (throws away the trigger). It survived three sessions, each writing a
*this is deliberate* note on the task rather than noticing the mechanism was
wrong for the job.

```
agent: kanban expect T-88 "the producer's seventeen files land in public/audio/"
        → input_request Q-14 created (status=open, kind=watch)
        → task T-88 does NOT become needs_input — it is parked, not Blocked
        → event input.requested (payload kind=watch) broadcast

human:  clicks "It happened" in the UI  (or kanban answer Q-14 "all seventeen arrived")
        → status = answered; that resolution is what starts the work
```

Same row, one column (`kind`), and the difference is the whole point: it stops the
**Blocked** projection meaning two different things. A watch is not counted as
question traffic in `standup`, gets its own `inbox` heading, is tagged `[watch]`
in `show`/`context`, and `doctor` never ages it as an `ancient-ask` — only as a
`stale-watch`, at 14 days, in a finding that says outright it **cannot see whether
the event happened**. Answer-shaping flags (`--options`/`--freeform`) are rejected
on a watch rather than ignored: if there is something to choose, you wanted `ask`.

### input_request state diagram

```
        ask
   ─────────────▶  open ───────────────▶ answered   (human/CLI answers)
                    │  ▲
   cancel │         │  │ (re-ask creates a NEW Q-n; answered is immutable)
          ▼         │
      cancelled     └────────▶ expired   (optional --expires-at elapses)
```

All three exits are terminal and immutable — editing an answer means asking a new
`Q-n` ([02-data-model §6](02-data-model.md)). `cancelled` is reached by `kanban
cancel Q-n` (the agent withdrawing a question it no longer needs); `expired` by a
low-frequency server sweep once an `ask --expires-at` deadline passes. Each clears
the task's `needs_input`, resolves any parked `await` (with that status), and shows
up in `inbox`'s `resolved` bucket so the resolution is never silent to a resuming
agent.

**Default-on-expiry.** `ask --default X --expires-at ISO` changes the expiry exit:
instead of dead-ending as `expired`, the sweep resolves the request as **answered**
with the default — the agent stays unblocked when the human is away. Never silent:
`answered_by` is `system:default`, the `input.answered` event carries
`defaulted: true` (actor `system`), and every surface flags it — `await` prints
`answered (defaulted)`, `inbox` shows `answered (defaulted)`, and the open request
renders `[default on expiry: X]` in `context` so the human can see what will happen
if they don't respond. A default requires `--expires-at` (it only applies at
expiry) and, for closed option sets, must be one of the options. A human answer
before the deadline always wins — the default never overwrites it.

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

### (C) External nudge — **shipped (post-v1)**
On `input.answered` the server fires an outbound nudge that a wrapper uses to
re-invoke Claude Code automatically — so the human answering a question resumes the
agent without anyone running `inbox` by hand. Two opt-in transports, both
fire-and-forget and off by default ([adr/0006](adr/0006-external-nudge-transport.md)):

- **Webhook** — POSTs the `input.answered` event (the WS frame shape,
  [07-api-reference](07-api-reference.md)) to a configured URL.
- **Local command** — spawns a shell command with the event in `KANBAN_*` env
  vars; covers desktop-notify and re-invoke scripts.

Configure per board (env overrides `board.json`):

```
kanban board nudge --url https://hooks.example.com/kanban --header x-auth=secret
kanban board nudge --cmd 'notify-send "kanban: $KANBAN_TASK_ID answered"'
# or, ad-hoc:  KANBAN_NUDGE_URL=… / KANBAN_NUDGE_CMD=…  in the server's env
```

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
  `--expires-at ISO` expires the request — or, with `--default X`, resolves it
  as a flagged `answered (defaulted)` instead (§2).
- **Multiple open questions** are allowed per board and per task. A task is
  `needs_input` if *any* open request targets it. Wait variants:
  - `kanban await Q-7` — one specific request
  - `kanban await --task T-12` — any request on that task
  - `kanban await --any` — the next answer anywhere on the board
- Each question is answered independently in the UI.
- **An answer records the choice; `--note` records the *why*.** `kanban answer Q-7
  "lift-it" --note "the press decides, not the page"` — optional, never required.
  The choice alone loses the reasoning, and answers get quoted in code comments
  where the reasoning is the part a reader in six months needs. The UI offers a
  quiet *why?* field beside every answer control, `inbox` prints it under the
  answer, and `show`/`context` carry a `decisions` block so the reason reaches the
  next session, not just the one that asked.
- **An answer given in chat is not an answer.** In a chat-plus-board setup the human
  usually replies in conversation; write it back with `kanban answer` **before**
  acting on it, or the durable record and the thing acted on are two different
  objects and the question sits open beside finished work. `doctor`'s
  `answered-elsewhere` check catches the residue.

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
