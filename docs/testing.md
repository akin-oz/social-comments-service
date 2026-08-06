# Testing

Spec-005 governs test coverage. This document states the standard a test is held to, which Spec-020 added after a review measured that the suite would stay green over five real defects.

## The standard: would this test fail if the code were wrong?

**If inverting a line of source turns no test red, the test is decoration.**

That is the question to ask before adding a test, and the way to check one after. It is not the same as coverage. Every defect this repository has shipped lived in code that was executed by the suite — the row-cast bug, the identity derivation, the newest-first unreachability. Execution is not detection.

The practice, when fixing a defect:

1. Write the test that reproduces it. Watch it fail.
2. Fix the code. Watch it pass.
3. Re-apply the defect. Confirm the test fails again.

Step 3 is the one that gets skipped, and it is the only one that proves anything.

## What this caught

A review re-applied real defects rather than reading for style, and five mutations survived a suite of 105 tests:

| Mutation                                               | Now caught by                                                |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `p.status = 'published'` → `is not null`               | a draft post fixture that must not be returned               |
| the upsert's `do update set` clause removed            | a comment observed twice with edited content                 |
| parent derivation returning a provider identifier      | a reply whose parent resolves to the stored row              |
| `requireCapability(provider, 'list_comments')` deleted | a read against a provider that only replies                  |
| the platform predicate neutralised in either adapter   | a YouTube comment that must not appear in an Instagram query |

Three of the five survived for the same reason: **fixture uniformity**. One platform, one post status, one tenant. A fixture that differs in nothing cannot distinguish a predicate that reads it from one that ignores it. The seed data now carries two Instagram tenants and one YouTube tenant, and the integration suite creates a non-published post and an edited comment.

The suite also ran with `passWithNoTests: true` and no floor, so a broken glob would have produced a green build running zero tests. It is off, and `tests/suite-integrity.test.ts` spawns a run with a deliberately broken glob to prove the build fails — the one assertion that cannot be made from inside a test run.

## Layers

| Layer                | Where                                                | Runs                                             |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Unit and application | `tests/comments`, `tests/shared`                     | Always. In-memory adapters, fixture provider.    |
| HTTP contract        | `tests/api/routes.test.ts`                           | Always. Through the real Fastify app.            |
| OpenAPI drift        | `tests/api/openapi.test.ts`                          | Always. Fails if `docs/openapi.json` is stale.   |
| Persistence and RLS  | `tests/repositories/*.integration.test.ts`           | Only with `DATABASE_URL` and `APP_DATABASE_URL`. |
| Full composition     | `tests/api/postgres-composition.integration.test.ts` | Only with both database URLs.                    |

The integration suites skip without a database so the default run needs no Docker. CI supplies both URLs, so nothing is skipped there — a suite that only ever skips is a suite that proves nothing.

Some behaviour can only be observed against PostgreSQL: row-level security, the compare-and-set on snapshot state, the upsert's conflict clause, and every deletion rule. An in-memory version of those tests would pass for the wrong reason.

## Two guards a test cannot kill, and why they stay

`validatePagination` is called just before a list response is built. Removing the call kills no test, and no test can be written that kills it: the service constructs `hasMore` and `nextCursor` together from one expression, so it cannot produce the inconsistent pair the validator exists to reject. It is a defensive assertion against a future edit, not a reachable branch, and it is recorded here rather than deleted or given a test that only re-tests the validator in isolation.

`validateComment` is called by nothing in `src/`. It is the executable statement of what a valid `Comment` is, exercised by `tests/comments/domain-model.test.ts`, and that is the whole of its current job. Wiring it into the repositories would turn a mapper defect into a typed failure rather than a malformed response — worth doing, a behaviour change, and therefore specified rather than slipped in.

## Assertions to avoid

- **Computing an expectation with the function under test.** The test then asserts the function equals itself. Use a golden value, or read the result back through a different path.
- **`rejects.toThrow(expect.not.stringContaining(...))`.** It passes whatever the message says. Catch the error and assert on it directly. This one shipped here and was caught by mutating it.
- **Asserting only that something did not throw.** Assert the value.
- **A fixture that varies in nothing relevant.** If every row has the same platform, no test covers the platform predicate.
