# delivery-readiness

A read-only task force that sweeps the repository from five angles before it is submitted or presented, and returns one severity-ranked list of gaps the maintainer can act on. Nothing here mutates code, writes a specification, or commits.

The point is to find the red build, the unenforced control, the test that cannot fail, and the document that promises something the code does not do — before a reviewer does.

## Why these five lenses

Each investigator exists because this repository has already failed in that specific way at least once:

| Investigator            | Subagent                        | Exists because                                                                                                                             |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh-clone engineer    | `readiness-fresh-clone`         | `pnpm dev` started no server, the Docker image had never built, and the runtime image shipped without `migrations/`                        |
| Claim auditor           | `readiness-claim-auditor`       | `api-design.md` documented limits, auth, and error codes the routes did not implement; the README pointed at a `/documentation` that 404'd |
| Test-integrity reviewer | `readiness-test-integrity`      | The suite stayed green over three PostgreSQL defects, and one adapter test asserted the exact identifier bug it should have caught         |
| Security reviewer       | `readiness-security`            | Row-level security was enabled, policied, and enforcing nothing, because the connecting role bypassed every policy                         |
| Reviewer-experience     | `readiness-reviewer-experience` | The reasoning was spread across twelve ADRs, and the brief states that reasoning is what is being evaluated                                |

All five are `tools: Read, Glob, Grep, Bash` and read-only. Two run on `opus` — security and test integrity — because both require reasoning about what is _absent_ rather than what is present, which is the harder judgement.

## How to run it

Agent teams are experimental and gated behind an environment flag:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

Then paste the prompt below into a session at the repository root. The five run in parallel; the session that launched them is the lead and merges their findings.

---

> Run the **delivery-readiness** task force over this repository before submission. Launch these five read-only investigators **in parallel**, each scoped to the whole repository, and merge their findings into one severity-ranked checklist at the end.
>
> Context they all share: this is a take-home assignment being judged on engineering reasoning, not on matching a reference implementation. Both required operations work end to end on PostgreSQL with verified tenant isolation and on in-memory adapters. No live provider SDK is selected; a deterministic fixture stands behind the same contract. The `.ai/` workspace is the source of truth and `.claude/`, `.codex/`, `CLAUDE.md`, and `AGENTS.md` are generated from it. Implementation work is gated behind approved specifications under `specs/`.
>
> 1. **Fresh-clone engineer** — subagent `readiness-fresh-clone`. Would a clean clone install, build, test, and run by both documented paths? Check every command in the README against `package.json`, the `packageManager` pin against the CI pin, `pnpm-workspace.yaml` build approvals, the Dockerfile's runtime copies, Compose service ordering and environment, migration and seed idempotency, and whether `docs/openapi.json` and the generated `.claude`/`.codex` artefacts are current.
> 2. **Claim auditor** — subagent `readiness-claim-auditor`. Is anything in the README, `docs/`, `specs/`, or `docs/decisions/` untrue of the code as it stands? Check documented endpoints, defaults, and error codes against the routes and `docs/openapi.json`; persistence claims against `migrations/` and the repositories; and every specification and ADR against the implementation it governs, including whether divergences are recorded.
> 3. **Test-integrity reviewer** — subagent `readiness-test-integrity`. Would this suite fail if the code were wrong? Build the executed-versus-unexecuted map first, then apply the mutation question to the highest-risk assertions, and pay particular attention to tests that share an assumption with the code they cover and to anything gated on an environment variable that CI may not supply.
> 4. **Security reviewer** — subagent `readiness-security`. What could leak, and what control is claimed but not enforced? Verify tenant isolation with the repository predicate removed, that the service role is neither superuser nor owner, that no secret is committed or logged, that comment bodies and display names never reach a log record, that provider identifiers never reach a response, and that no later migration re-exempts the service role.
> 5. **Reviewer-experience investigator** — subagent `readiness-reviewer-experience`. Read the repository cold, as the evaluator will. Are the brief's four deliverables findable in the first fifteen minutes, is the reasoning where a reviewer will look, is anything overstated, and what single change would most improve the impression?
>
> Have each return its own severity-ranked report. Then produce one merged checklist ordered by severity across all five, deduplicated, with the one item you would fix first called out.

---

## Scope discipline

Each investigator has exactly one lens and should decline findings that belong to another. Overlap between five reports is noise the lead has to reconcile, and a finding reported five ways is not five findings.

These five complement rather than replace the standing reviewers. `architecture-guardian` owns boundaries and dependency direction, `contract-guardian` owns invented contracts, and `spec-author` writes proposals. The readiness task force answers a narrower question — _is this ready to hand over_ — and runs at the end rather than continuously.

Seed tasks for each member are in `tasks.md`.
