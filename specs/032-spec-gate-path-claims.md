---
spec: 032
title: Make the spec gate evaluate the predicate it states
status: implemented
approved: yes
owner: platform-integration
paths:
  - .ai/hooks/**
  - specs/**
---

# Spec-032: Make the spec gate evaluate the predicate it states

> **Process note.** Implemented in the same session this was written, as a
> deliberate exception by the maintainer.

## Problem

Raised as P1 by the `principal-review` board, and verified.

`guard-spec-gate.sh` computed:

```sh
APPROVED=$(find "$PROJECT_DIR/specs" ... | xargs -0 rg -l '^approved:[[:space:]]*yes[[:space:]]*$')
[ -n "$APPROVED" ] && exit 0
```

That is a repository-wide existence test: _does any file in `specs/` contain
`approved: yes`?_ All 25 do. `APPROVED` was therefore non-empty for every edit to
every path, `exit 0` ran unconditionally, and the `ask` branch below it had been
unreachable since 2026-08-02.

The rule the repository states is that an agent may not change logic "unless an
approved specification **covers the change**". "Covers the change" is precisely
the predicate the hook never evaluated. The README is candid that the gate did
not catch the three known defects — but that discloses _the gate does not make
output correct_, not _the machine check is an unconditional pass_.

## Scope

### In scope

1. Each spec declares the paths it claims in a `paths:` front-matter list, with
   `**` matching any number of segments.
2. The hook asks whether some approved spec claims the path being written, and
   returns `ask` when none does.
3. `migrations/`, `.githooks/`, `scripts/`, `Dockerfile`, `docker-compose.yml`,
   and `fly.toml` join the gated set. All are implementation surfaces that were
   ungated.

### Out of scope

- Enforcing that the _content_ of a change stays within its spec. A path claim
  is a coarse instrument and is not claimed to be more.

## A caveat the maintainer should read

The `paths:` lists on specs 001–025 were derived from those specs' titles and
scope sections by an agent, not written by their authors. They are a reasonable
reading and they make the gate real, but they are inference. Two are worth a
second look: `007-production-polish` was given build and CI files rather than
`src/**`, to avoid re-creating the wildcard this spec exists to remove; and
several specs claim overlapping areas, which is accurate — more than one spec
has touched `src/comments/` — but means a change there is gated by whichever
claims it first.

## Verification

Probed directly with the hook's own input format. Claimed paths
(`src/comments/comment-service.ts`, `migrations/…`, `tests/…`, `docs/api-design.md`)
pass; an unclaimed path (`src/brand-new-area/thing.ts`) returns `ask`. So does
`.claude/settings.json` — the hand edit that broke CI at commit `74c6a81`.
