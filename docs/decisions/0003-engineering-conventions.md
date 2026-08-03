---
adr: 0003
title: Establish repository engineering conventions and quality gates
status: accepted
---

# ADR-0003: Establish repository engineering conventions and quality gates

## Context

The project is intended to look and behave like a well-run engineering repository. Consistent commits, formatting, linting, and verification reduce review noise and make changes easier to audit—especially when work is assisted by AI agents.

These conventions should be established before feature implementation and enforced by local scripts, agent governance, and CI.

## Decision

### Commit messages

Use Conventional Commits:

```text
<type>(<optional scope>): <imperative summary>
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, and `revert`. Summaries should be concise, imperative, and normally no longer than 72 characters.

Every implementation commit must also include exactly the relevant governance reference in its body/footer:

```text
Spec: NNN
```

or:

```text
ADR: NNNN
```

`--no-verify` is not allowed. Documentation-only maintenance may use the same convention without claiming an implementation spec when an ADR or docs change is the actual scope.

### ESLint

Use ESLint flat configuration with strict TypeScript-aware recommended rules. Lint must pass with zero errors and zero warnings in CI. Avoid `any`, unused variables, implicit fallthrough, unsafe dependency direction, and imports that couple domain contracts to infrastructure.

### Prettier

Prettier is the formatting source of truth with the repository’s checked-in configuration: single quotes, semicolons, trailing commas, and a 100-character print width. Formatting is checked in CI rather than applied silently during validation.

### Quality gates

The minimum verification gate is:

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm ai:validate
```

Pull requests must pass the gate before merge. Changes that alter the gate itself require an ADR or an approved specification.

## Consequences

Reviews can focus on behavior and design instead of incidental formatting or ambiguous commit history. AI-generated changes have a consistent audit trail through commit trailers and validation.

The project accepts some upfront tooling and rule maintenance. Strict rules may occasionally require an explicit exception; exceptions must be narrow, documented, and reviewed rather than silently disabled.

## Alternatives considered

Free-form commit messages and editor-dependent formatting were rejected because they weaken review history and create avoidable diffs. A larger bespoke lint framework was rejected in favor of standard ESLint, TypeScript, and Prettier capabilities.

## Implementation boundary

This ADR establishes conventions and gates. It does not authorize feature behavior, provider integration, persistence, or API changes.
