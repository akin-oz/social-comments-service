---
spec: 006
title: Complete engineering and operational documentation
status: approved
approved: yes
owner: documentation
depends_on:
  - ADR-0008
---

# Spec 006: Complete engineering and operational documentation

## Problem / gap

The initial design documents describe the target system, but implementation and operations will introduce details that must remain discoverable and consistent.

## Scope

- Update architecture, assumptions, API, database, roadmap, tasks, and ADR links to reflect implemented behavior.
- Document the provider capability matrix and onboarding process for a new adapter.
- Document local development, configuration boundaries, testing, and failure behavior.
- Add ADRs for material decisions and keep generated AI artifacts reproducible.
- Ensure README commands match the actual project scripts.

## Out of scope

Changing architecture solely to produce documentation, replacing source contracts with prose, and documenting unsupported provider behavior as fact.

## Acceptance criteria

- [ ] ADR-0008 and the relevant implementation specs are accepted.
- [ ] A new engineer can run the project and locate the source of truth for each major contract.
- [ ] Implemented behavior and documented assumptions agree.
- [ ] Provider differences, operational limits, and failure recovery are documented.
- [ ] Generated AI output is validated and no generated file is hand-edited.

## Verification

Perform a documentation review using the architecture and contract guardian agents, run all quality commands, and verify links and examples against the repository.
