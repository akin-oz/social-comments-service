# Implementation specifications

Specifications are the approval gate for implementation work.

Create proposals as `NNN-<short-slug>.md` with this front matter:

```yaml
---
spec: NNN
title: <short imperative title>
status: proposed
approved: no
owner: <area>
paths:
  - src/area/**
---
```

`paths:` is what the spec gate evaluates. Each entry is a repository-relative glob where `**` matches any number of segments, and a change is allowed only when some approved spec claims the path being written. Before [Spec-032](032-spec-gate-path-claims.md) the hook asked instead whether _any_ file in `specs/` was approved — which all 25 were — so it passed unconditionally for every path. A spec with no `paths:` claims nothing.

The authoring agent may create or revise a proposal, but only the human maintainer may change `approved: no` to `approved: yes`. Agents must stop when an applicable spec is missing or not approved.

An approved spec must define scope, contract impact, out-of-scope behavior, acceptance criteria, and verification. Significant architectural decisions also require an ADR under `docs/decisions/`.
