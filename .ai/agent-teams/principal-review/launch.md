# principal-review

A standing review board: five senior reviewers each take the whole service through one lens, and a lead merges their findings into a single prioritised report. This is the review a senior engineering organisation would assemble to interrogate the design — not to check whether rules were followed, but to decide whether the thing is any good.

Run it when a milestone lands or before defending the work. It is a critique, not a gate.

## How this differs from the standing guardians

The guardians check **compliance**; this board exercises **judgement**. The distinction matters, because a repository can be perfectly consistent with a design that was wrong to choose.

| Question                                           | Who answers it                |
| -------------------------------------------------- | ----------------------------- |
| Are the documented boundaries respected?           | `architecture-guardian`       |
| Are the documented boundaries the right ones?      | `review-principal-architect`  |
| Was any contract invented without a specification? | `contract-guardian`           |
| Is the contract we documented actually good?       | `review-api-contract`         |
| Is this ready to hand over?                        | the `delivery-readiness` team |
| Is this good engineering?                          | this board                    |

## Members

| Reviewer            | Subagent                     | Model  | Lens                                                                                              |
| ------------------- | ---------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| Principal architect | `review-principal-architect` | opus   | Do the abstractions earn their keep, is the machinery proportionate, would you build it this way? |
| Reliability         | `review-reliability`         | opus   | Partial failure, concurrency, provider misbehaviour, idempotency and consistency semantics        |
| Domain model        | `review-domain-model`        | sonnet | Do the types say what the business means, and what can the model not express?                     |
| API contract        | `review-api-contract`        | sonnet | Integrate as a client and say what you would complain about                                       |
| Data model          | `review-data-model`          | sonnet | Keys, constraints, indexes against real query shapes, migration safety, growth                    |

All five are read-only (`Read, Glob, Grep, Bash`) and report findings as `file:line — what — fix` at P0, P1, or P2. Architecture and reliability run on `opus` because both are judgement about what is absent or what could happen, which is harder than reading what is there.

## Scope discipline

Each reviewer has one lens and hands off anything outside it rather than duplicating. The seams that will tempt them:

- The stored provider cursor is **reliability's** call on correctness and **data model's** call on where it lives.
- Identifier derivation is **domain model's** call on meaning and **data model's** call on the constraint that backs it.
- Error codes are **API contract's** call on what a client can do with them, not the architect's.
- Anything where the code disagrees with a document belongs to `readiness-claim-auditor`, not to this board.

## How to run it

Agent teams are experimental and gated behind an environment flag:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

---

> Convene the **principal-review** board over this repository and return **one** prioritised report. Spawn all five read-only reviewers **in parallel**.
>
> Shared context: a comment service for a social media scheduling platform, two operations — retrieve comments for a published post, reply to a comment — across multiple platforms. Both work end to end on PostgreSQL with verified tenant isolation and on in-memory adapters. No live provider SDK is selected; a deterministic fixture stands behind the same contract, and `docs/provider-capability-matrix.md` records what the five real platforms document. The repository's own bar is the smallest design that satisfies a demonstrated requirement.
>
> - **`review-principal-architect`** — is this the right design? Try deleting each abstraction and see what breaks. Judge whether the `.ai/` governance machinery is proportionate to a two-operation service, and whether the specification gate improved the design or only recorded it, given that several approved documents were later corrected by implementation.
> - **`review-reliability`** — walk the reply path statement by statement and name the failure window at each gap. Probe the at-most-once claim under real interleavings, the stored provider cursor that Meta documents against storing, and whether a client can distinguish "not published" from "unknown".
> - **`review-domain-model`** — read `src/shared/types.ts` and `src/comments/contracts.ts` and say what the model cannot express. Compare it against the platform differences in the capability matrix: one-level nesting enforced server-side, arbitrary depth on X, and moderation states nothing represents.
> - **`review-api-contract`** — write the pseudo-code a consumer must write to page through comments and to reply safely, and report everywhere the contract left you guessing. Judge `IDEMPOTENCY_CONFLICT` carrying three distinct meanings, and whether a client can reason about snapshot freshness at all.
> - **`review-data-model`** — tabulate every query in `src/repositories/postgres.ts` against the index that serves it. Judge the per-platform identifier derivation against the per-social-account unique constraint, migration safety on populated tables, and unbounded comment growth with no retention.
>
> Have each return its own P0/P1/P2 report. Then merge into one list ordered by severity and blast radius, deduplicated across lenses, ending with the single change you would make first and the strongest thing about the design.

---

Seed tasks for each reviewer are in `tasks.md`.
