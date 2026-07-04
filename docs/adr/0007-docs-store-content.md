# 0007 — Docs and Ideas Store Content; Artifacts Remain References

## Status

Accepted

## Context

Agents doing multi-step work produce planning artifacts the board previously had
no home for: design docs, architecture decision records, spike write-ups, and
research findings. These need to be **durable** (survive the session), **linked**
to the tasks they govern, and **searchable** — which means their content has to
live somewhere the board can reach.

[ADR 0005](0005-artifacts-are-references-not-blobs.md) rules that artifacts store
references only, because artifact contents live elsewhere (a PR, a file, a URL)
and inlining them is a token bomb. Board-native knowledge is different: a design
doc or research note produced *for* the board has no canonical home elsewhere —
pushing it out to a file and storing a path would make it invisible to search,
fragile across machines, and useless to the web UI.

## Decision

The `doc` entity (and, later, brainstorm `idea` text) stores its markdown **body
in the board DB**. This is a deliberate, scoped departure from ADR 0005 — which
stands unchanged for artifacts: things that live elsewhere stay references.

Token-bomb risk is contained by guard rails on both sides:

- **Write side**: doc bodies are capped at 64 KB (`MAX_DOC_BODY_BYTES`,
  src/server/repo.ts); oversized bodies are rejected with a validation error
  suggesting a file + artifact reference instead.
- **Read side**: list tiers (`kanban docs`, the `context` docs section, JSON
  list/detail envelopes) render **title + summary only, never the body**. The
  body renders solely via `doc show D-n`, which is budgeted **by default**
  (`DEFAULT_DOC_MAX_TOKENS = 2000`, src/server/render.ts) and sheds the body
  tail with a never-silent footer.

## Consequences

- Knowledge written during planning survives, is linked many-to-many to tasks,
  and can be indexed by board-wide search.
- An agent must explicitly opt in (`doc show`, `--full`) to pay for a body; no
  other read path ever includes one.
- The DB grows with doc content; the 64 KB cap and archived-doc filtering keep
  that bounded. Large source material still belongs outside the board, attached
  as an artifact reference.
