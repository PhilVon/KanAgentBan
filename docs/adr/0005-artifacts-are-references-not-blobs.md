# 0005 — Artifacts Are References, Not Blobs

## Status

Accepted

## Context

Tasks accumulate artifacts: PR links, file paths, output references, external
URLs. Storing the *contents* of these in the database would bloat both the DB and,
worse, any context payload that includes them — inlining a large file or PR diff
into an agent's working set is a token bomb that defeats the whole token-efficiency
design ([03-token-efficiency](../03-token-efficiency.md)). It also risks pulling
secrets and large blobs into the store ([02-data-model](../02-data-model.md)).

## Decision

The `artifact` row stores a **reference only** — a `uri` that is a path, URL, or
PR ref — together with a `kind` and `title`. It **never** stores file contents.
The `context <id>` working set renders artifacts as title + URI only.

## Consequences

- Agents fetch contents themselves, on demand, only when actually needed.
- The database stays small and context payloads stay bounded and predictable.
- No secret material or large blobs land in the DB, reducing security exposure.
- A reference can dangle if the underlying resource moves or is deleted; that is
  accepted, since the artifact is a pointer, not a copy.
