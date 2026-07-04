# 0008 — Git Linkage Is Client-Side; the Server Never Shells Out

## Status

Accepted

## Context

Linking tasks to their git artifacts (branches, commits, PRs) needs to read the
user's repository and, for PR/CI state, call `gh`. Two places could do that: the
CLI running in the user's working directory, or the board server.

The server is the wrong place. It may run detached from any repository (it is
spawned per-board, not per-checkout), it would need the repo path pushed to it,
and shelling out from the sole-writer process couples board availability to git
and network state. Storing PR/CI status server-side is worse still: it goes
stale immediately unless something polls, and a polling daemon is exactly the
kind of background machinery this project avoids.

## Decision

All git and `gh` execution lives in the CLI (`src/cli/git.ts`), run in the
user's cwd:

- `kanban git link` scans recent commits and local branches for `T-n` mentions
  and records them as **artifacts** — `kind: commit` (`uri: git:<sha>`) and
  `kind: branch` (`uri: branch:<name>`). No new entity: these are references,
  exactly what ADR 0005 artifacts are. The server's only accommodation is that
  `addArtifact` is **idempotent on (task, kind, uri)**, so re-scans are safe.
- `kanban git status` renders PR/CI state **on demand** via `gh pr view`,
  merged with board artifacts at read time — never stored, never polled, and
  degrading silently when `gh` is absent.
- `kanban git install-hooks` writes local `prepare-commit-msg` / `post-commit`
  hooks; the post-commit link call is fire-and-forget so a down server never
  blocks a commit.

## Consequences

- The server stays model-free and dependency-free: no git binary, no network,
  no repo path configuration, no pollers.
- Linkage quality depends on convention — branch names like `T-12-slug`
  (`kanban git branch` generates them) and commit messages mentioning `T-n`
  (the hook appends them).
- PR state shown by `git status` is as fresh as the moment you ask, and costs
  nothing when you don't.
