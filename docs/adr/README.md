# Architecture Decision Records

This directory holds the Architecture Decision Records (ADRs) for **KanAgentBan**,
the agent-first kanban board. Each ADR captures a single significant design
decision in the standard format — Title, Status, Context, Decision, Consequences —
so the reasoning behind the system is durable and reviewable. ADRs are immutable
once accepted; a decision is changed by adding a new ADR that supersedes an older
one rather than editing history. For the broader design narrative, see the numbered
docs in [`../`](../) (data model, token efficiency, human-in-the-loop, and more).

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-plaintext-default-output.md) | Plaintext-Default CLI Output | Accepted |
| [0002](0002-durable-async-pause-over-blocking.md) | Durable-Async Pause Over Blocking Long-Poll | Accepted |
| [0003](0003-single-writer-server.md) | Single-Writer Server per Board | Accepted |
| [0004](0004-derived-blocked-status.md) | "Blocked" Is Derived, Not a Stored Status | Accepted |
| [0005](0005-artifacts-are-references-not-blobs.md) | Artifacts Are References, Not Blobs | Accepted |
| [0006](0006-external-nudge-transport.md) | External-Nudge Transport: Webhook + Local Command | Accepted |
