# 0001 — Plaintext-Default CLI Output

## Status

Accepted

## Context

KanAgentBan's CLI output is consumed primarily by LLM agents, where every token
has a cost, and secondarily by humans reading a terminal. A naive JSON-everywhere
default inflates payloads with braces, quotes, and repeated keys, and grows with
the project (see [03-token-efficiency](../03-token-efficiency.md)). At the same
time the output must be machine-parseable: the skill and the agent regex specific
fields rather than re-reading prose, so the shape of the output is effectively an
API contract.

## Decision

The CLI emits **terse, versioned plaintext by default**, with `--json` as an
opt-in for machine/UI consumers. The plaintext output is treated as a contract:
stable field order, stable section headers, no decorative noise, and no ANSI
colour when stdout is not a TTY. A `--format-version` flag (current `1`) pins the
shape so a fixed agent or skill never breaks silently.

## Consequences

- Agents extract fields cheaply with regex against a known, stable layout.
- UI and other programmatic consumers pass `--json` for a structured payload.
- Any breaking change to field order or headers **must bump `--format-version`**,
  so pinned agents fail loudly rather than mis-parsing.
- Two output paths must be kept in sync and tested.
