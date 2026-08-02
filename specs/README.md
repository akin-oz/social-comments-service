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
---
```

The authoring agent may create or revise a proposal, but only the human maintainer may change `approved: no` to `approved: yes`. Agents must stop when an applicable spec is missing or not approved.

An approved spec must define scope, contract impact, out-of-scope behavior, acceptance criteria, and verification. Significant architectural decisions also require an ADR under `docs/decisions/`.
