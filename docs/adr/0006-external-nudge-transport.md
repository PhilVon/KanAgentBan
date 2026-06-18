# 0006 — External-Nudge Transport: Webhook + Local Command

## Status

Accepted

## Context

The human-in-the-loop design has three resume strategies
([04-human-in-the-loop §3](../04-human-in-the-loop.md)). Strategies (A) short
`await` and (B) yield + resume-from-`inbox` shipped in v1. Strategy (C) —
*external nudge* — was deferred: on `input.answered`, the server should fire an
outbound signal that a wrapper uses to re-invoke Claude Code automatically, so a
human answering a question can resume the agent without anyone manually running
`kanban inbox`. The answer-event hook (the `input.answered` event on the
in-process bus) was built in v1; only the trigger was outstanding.

The open question recorded in [04](../04-human-in-the-loop.md) and
[11-roadmap §4](../11-roadmap.md) was the **transport**: a webhook vs a desktop
notification. These are not really competing — a webhook re-invokes a remote/CI
wrapper; a desktop notification (or any local re-invoke script) is just a local
command. Picking one would force the other camp to wrap awkwardly.

## Decision

Support **both transports, fired on `input.answered`, opt-in and off by default**:

- **Webhook** — `POST <url>` with the answered event in the existing WebSocket
  frame shape ([07-api-reference](../07-api-reference.md)) plus `board_root`.
  Optional custom headers carry an auth token. 5s timeout.
- **Local command** — spawn a shell command, detached, with the event exposed as
  `KANBAN_EVENT_TYPE` / `KANBAN_TASK_ID` / `KANBAN_REQUEST_ID` / `KANBAN_ANSWER` /
  `KANBAN_BOARD_ROOT` env vars. This subsumes "desktop notification" (e.g.
  `notify-send`, `terminal-notifier`) and "re-invoke Claude Code" without baking
  any OS-specific dependency into the server.

Both are **fire-and-forget**: failures are logged and swallowed so a misconfigured
or down endpoint can never break answering or crash the sole-writer server. Config
lives in `.kanban/board.json` under a `nudge` block (durable, survives the detached
auto-start) with `KANBAN_NUDGE_URL` / `KANBAN_NUDGE_CMD` env overrides for ad-hoc
or secret-bearing values. The notifier is wired only in the long-lived
`startServer` process, never in the `buildApp` unit-test path.

## Consequences

- Strategy (C) is now usable: a wrapper subscribing to the webhook or command can
  auto-resume the agent the moment a human answers.
- The webhook is an **outbound** call to a user-chosen URL carrying the answer
  text; the command runs with the server's privileges. Both are user-configured
  and disabled unless set — see [10-security-lifecycle](../10-security-lifecycle.md).
- No new wire format: the webhook body reuses the WS event frame.
- Out of scope (future): retry/queue on webhook failure, signing the webhook
  payload, triggering on event types other than `input.answered`, and the actual
  Claude-Code re-invoke wrapper script (the trigger is delivered; the wrapper is
  the integrator's to write).
