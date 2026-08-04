# delivery-readiness — seed tasks

Concrete starting points per investigator. These are leads, not a checklist to complete: each is a place this repository has failed before or a claim currently resting on nobody having checked it. Follow what you find rather than stopping at the list.

## readiness-fresh-clone

1. Extract every fenced `bash` block from the README and `docs/` and confirm each command exists in `package.json`. `pnpm dev` once pointed at a module with no `listen()`.
2. Compare `packageManager` in `package.json` against the `pnpm/action-setup` version in `.github/workflows/ci.yml`. The action fails when the two disagree, and local pnpm has silently rewritten that field before.
3. Confirm every `allowBuilds` entry in `pnpm-workspace.yaml` has a real boolean. An unanswered placeholder there failed every non-interactive install.
4. Walk the Dockerfile runtime stage and list everything read at run time that it does not copy. It shipped without `migrations/` once.
5. Trace `docker compose up` from an empty volume: does PostgreSQL become healthy, does migrate apply and seed, does the API start with the environment it needs, and does `ENABLE_API_DOCS` still reach it?
6. Run migrate and seed twice mentally against the SQL and confirm both are no-ops the second time.
7. Check `docs/openapi.json` against what `pnpm openapi` would produce, and `.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md` against what `pnpm ai:sync` would produce from `.ai/`.
8. Confirm the integration tests skip cleanly without `DATABASE_URL` and that CI supplies it.

## readiness-claim-auditor

1. Read `docs/api-design.md` beside `src/api/routes.ts`, `src/api/schemas.ts`, and `docs/openapi.json`. Compare limits, defaults, headers, status codes, error codes, and cursor semantics field by field.
2. Read `docs/database.md` beside `migrations/` and `src/repositories/postgres.ts`. Every control it describes as enforced must be traceable to a constraint, policy, grant, or role.
3. For each file in `specs/`, check its acceptance criteria against the implementation. Spec-008 criterion 3 and criterion 2 both diverged; confirm each divergence is recorded and no new ones are silent.
4. For each ADR, check its decision against the code. ADR-0010, ADR-0011, and ADR-0012 all carry corrections; confirm no other ADR needs one.
5. Verify the README's status section, the roadmap's milestone states, and the task tracker agree with each other and with the code.
6. Check the provider capability matrix still reads as documentation research rather than as verified integration.
7. Challenge every use of "verified", "tested", and "confirmed" in the repository and find the evidence for each.

## readiness-test-integrity

1. Build the map of `src/` modules to the tests that execute them, and name anything unexecuted. `src/server.ts` and the migration and seed entry points are expected gaps — say whether that is acceptable and why.
2. For tenant isolation, idempotency, capability rejection, cursor validation, and error mapping, find the test that would fail if the behaviour were inverted. Name any without one.
3. Examine the integration tests gated on `DATABASE_URL`: confirm CI supplies it, and that a developer without Docker is told what they are not running.
4. Look for tests that share an assumption with the code. The adapter test that asserted `instagram:external-comment-1` is the archetype; find its remaining relatives.
5. Check whether any test would still pass with its subject deleted.
6. Assess the fixture data: is any scenario too short or too uniform to reach the branch it is meant to cover? The provider that exhausts in a single page hid a multi-page defect.
7. Check determinism: wall-clock dependence, unguaranteed ordering, shared state, and re-runnability against a database that already holds rows from a previous run.

## readiness-security

1. Verify tenant isolation the only way that proves it: a query with its `account_id` predicate removed, under one tenant's context, returning none of another tenant's rows. Confirm a test does this and that it runs.
2. Confirm the service connects as a role that is neither a superuser nor a table owner, and that a test asserts it rather than the configuration merely implying it.
3. Read `migrations/` in order and confirm no later migration drops `FORCE ROW LEVEL SECURITY`, widens a grant, or changes ownership.
4. Grep tracked files and `git log -p` for secrets. Classify the Compose credentials explicitly rather than skipping them.
5. Trace one list request and one reply request end to end, naming every point where data enters a log or a response, and confirm bodies, display names, and provider identifiers reach neither.
6. Check the error handler: no SQL, stack traces, provider payloads, or internal identifiers in a client-facing body.
7. Confirm the header-trust boundary is documented where a reviewer will see it, and that nothing else trusts client input silently.
8. Check request size limits and schema validation at every edge, including that a forged cursor cannot make the service act on attacker-chosen values.

## readiness-reviewer-experience

1. Read the README top to bottom once as a stranger and note the first point at which you would be confused, misled, or give up.
2. Time how long it takes to locate each of the brief's four deliverables from the README: schema, API design, code, and the explanation of decisions.
3. Follow the first documented run path exactly, with no prior knowledge, and note anything it assumes but does not state.
4. Hunt for overstatement: any claim of production-readiness, completeness, or verification that exceeds what exists.
5. Judge whether the governance machinery reads as rigour or as ceremony at first contact, and whether its justification appears where a reviewer meets it.
6. Check the repository tree, status section, and roadmap against what actually exists.
7. Run `git status` and list branches; report anything unmerged, uncommitted, or left behind.
8. End with the single change that would most improve the first fifteen minutes.
