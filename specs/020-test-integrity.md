---
spec: 020
title: Close the gaps where a real defect would keep the suite green
status: accepted
approved: yes
owner: verification
depends_on:
  - Spec-005
---

# Spec-020: Close the gaps where a real defect would keep the suite green

## Problem / gap

The test-integrity reviewer did not argue that coverage was low. It re-applied real defects and measured which ones the suite failed to notice. Several survived, and the ones that survive are in the paths where a defect is most expensive.

Surviving mutations, each verified by the reviewer against a live database:

- `p.status = 'published'` can be changed to `is not null` — no fixture has a non-published post, so nothing distinguishes them.
- The upsert's `do update set` clause can be gutted, and no test notices that an edited comment would never refresh.
- The parent-derivation branch is never exercised, and it is the one database-layer path that could return a raw provider identifier to a client.
- `requireCapability(provider, 'list_comments')` can be deleted.
- The platform predicate in both adapters can be neutralised, because every fixture is `instagram`.

Weak assertions in the same class:

- The production retry policy's retry branch never runs; only the test policies exercise retrying.
- `internalCommentId` had no golden vector, so tests computed expectations with the function under test. That function is now gone, but the pattern would recur wherever a pure function is asserted against itself.
- `Retry-After` is never asserted on a response.
- `passWithNoTests: true` with no coverage floor means a broken test glob produces a green build running zero tests.

## Context and assumptions

- Spec-005 governs test strategy, and this spec extends rather than revises it.
- The suite is now 105 tests and genuinely catches the historical defects: re-applying the row-cast bug turns it red. The remaining gaps are narrower and specific.
- Fixture uniformity is the root cause of three of the five surviving mutations: one platform, one post status, one tenant in the demo composition.

## Scope

### In scope

1. **Diversify the fixtures** so uniformity stops hiding defects: a post that is not published, at least one non-`instagram` platform, and comments that are edited between observations.
2. **Cover each surviving mutation** with an assertion that fails when the mutation is applied: the published-status filter, the upsert's update clause, the parent resolution, the capability check, and the platform predicate.
3. **Exercise the production retry policy** rather than only test-local ones, so the shipped configuration is the one under test.
4. **Assert `Retry-After`** on a rate-limited response, end to end.
5. **Remove `passWithNoTests`** and add a floor that fails the build if the suite collapses, so a broken glob cannot pass as green.
6. **Adopt the mutation question as the standard** for new tests in the test-strategy documentation: if inverting a line of source turns no test red, the test is decoration.

### Out of scope

- A mutation-testing tool in CI. That is a dependency and a runtime cost; the discipline is the point, and the reviewer applied it by hand effectively.
- A coverage percentage target. Percentages measure execution, not detection, and this repository's defects all lived in executed code.
- Rewriting tests that are sound.

## Contract impact

None. No production code changes except where a test proves a defect, in which case that fix is reported rather than folded in silently.

`vitest.config.ts` and the test-strategy documentation change.

## Acceptance criteria

1. Each of the five surviving mutations, re-applied, turns the suite red. Every one is demonstrated in the verification, not asserted.
2. A non-published post is not returned, proven by a fixture that has one.
3. An edited comment observed twice reflects the update, proven against PostgreSQL.
4. The parent-resolution path is exercised, and a test would fail if it returned a provider identifier.
5. A capability the provider lacks is rejected, and deleting the check fails a test.
6. At least one test runs against a platform other than `instagram`, and neutralising the platform predicate fails a test.
7. The production retry policy is exercised by a test.
8. A rate-limited response asserts `Retry-After`.
9. A build with zero collected tests fails.

## Verification plan

The verification is the mutation exercise itself. For each of the five, apply the mutation, run the suite, record that it fails, and revert. A finding is only closed when the mutation has been shown to turn the suite red, in the same way the row-cast defect was.

Beyond that: a test asserting the suite fails with no tests collected, and a review of the new fixtures to confirm they add a distinction rather than volume.

## Open decisions

1. **How the zero-test floor is enforced.** Proposed: remove `passWithNoTests` so vitest fails on its own. A minimum count is more explicit but becomes a number nobody maintains.
2. **Which second platform to use in fixtures.** Proposed: `youtube`, because the capability matrix documents it as differing from Instagram in reply handling, so the fixture carries information rather than just a different string.
3. **Whether an edited-comment test belongs in the integration suite only.** Proposed: yes. The in-memory adapter cannot express the `do update set` clause the test is for, so an in-memory version would pass for the wrong reason.
4. **Whether to record mutation results in the repository.** Proposed: no as a standing artefact, since it goes stale, but the commit implementing this should state which mutations were shown to fail.

## Human decision required

Approval requires accepting:

1. Test-only work with no product change, prioritised against features — justified because the suite stayed green over three real defects and the review measured that it still would over five more.
2. Removing `passWithNoTests`, which makes a misconfigured run a failure rather than a pass.
3. That the mutation question becomes the standard a new test is held to, which is a slower way to write tests and the reason they catch anything.
