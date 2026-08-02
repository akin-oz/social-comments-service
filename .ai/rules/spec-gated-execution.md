# Spec-gated execution

This repository uses a human-approved specification gate.

- Agents may inspect the repository, explain options, draft ADRs, and write proposed specs.
- Agents must not implement business logic, change API/database/platform contracts, add dependencies, or alter architectural decisions unless an applicable `specs/NNN-*.md` contains `approved: yes` in its front matter.
- Agents must not set `approved: yes`. Only the human maintainer approves a spec.
- Changes that establish or revise an architectural decision require an ADR under `docs/decisions/`, even when an approved spec also exists.
- If a requirement is missing, stop and propose a spec or ADR. Do not infer the missing behavior from a prompt, provider convention, or likely implementation.
- Every commit must include either `Spec: NNN` or `ADR: NNNN` in its commit message trailer. Never bypass verification with `--no-verify`.
- Keep implementation scope within the approved spec and update `docs/tasks.md` as work progresses.

The initialization skeleton is not an approval to implement the comment system. It only establishes contracts, documentation, and governance.
