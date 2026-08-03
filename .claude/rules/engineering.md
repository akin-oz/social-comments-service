# Project engineering rules

- Read `README.md` and the relevant files under `docs/` before changing architecture-sensitive code.
- Treat `docs/assumptions.md`, `docs/tasks.md`, and `docs/roadmap.md` as living project artifacts; update them when the implementation changes scope or assumptions.
- Keep dependencies pointed toward stable contracts. Do not leak Fastify, persistence clients, or provider SDKs into domain-facing types.
- Keep social-platform behavior behind `src/platforms/` provider abstractions.
- Prefer the smallest design that satisfies a demonstrated requirement. Do not introduce microservices, CQRS, event sourcing, Kafka, or DDD ceremony without an accepted ADR.
- Add tests with behavior changes and run typecheck, lint, formatting, and tests before handoff.
- Use Conventional Commits (`feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, or `revert`) with an imperative summary and a `Spec: NNN` or `ADR: NNNN` trailer.
- Keep ESLint at zero errors/warnings and use the checked-in Prettier configuration; do not bypass the quality gates.
- Do not implement business logic in initialization placeholders; replace a placeholder only when its roadmap milestone is active.
- Record material design changes in `docs/decisions/`.
