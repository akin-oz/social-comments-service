---
spec: 042
title: Keep the service-role password out of migration DDL text
status: proposed
approved: no
owner: operations and migrations
depends_on:
  - Spec-012
  - Spec-018
paths:
  - src/migrate.ts
  - docs/operations.md
---

# Spec-042: Keep the service-role password out of migration DDL text

## Problem / gap

`src/migrate.ts` sets the `comments_app` password after applying migrations. `setApplicationPassword` (lines 65–73) reads `APP_DATABASE_PASSWORD` and issues:

```
alter role comments_app password ${client.escapeLiteral(password)}
```

`escapeLiteral` makes the value a correctly-escaped SQL string literal, so there is no injection. But the plaintext password _is_ that literal, embedded in the statement text. A PostgreSQL server configured with `log_statement = ddl` (or `all`) writes every DDL statement to its server log — so on such a server the migration writes the service role's plaintext password to the PostgreSQL log.

Migration `002` creates the role without a password (`create role comments_app login`, line 22), which is correct: the credential never lives in a migration file. The runner then reintroduces it into statement text at migrate time, which is where this gap lives.

This is the **lowest-priority open item** in `docs/tasks.md` (line 219, under "Still open, and deliberately so"), and it is **already disclosed with the correct remediation** in `docs/operations.md` (line 118). This spec formalizes that disclosed remediation; it does not invent a new one.

## Context and assumptions

- ADR-0012 and Spec-012 established the two-role model: migrations run as `comments_owner`, the service connects as `comments_app`, and the runner sets the service role's password out of band from `APP_DATABASE_PASSWORD` so credentials never live in a migration file. This spec changes _how_ the runner transfers that secret, not the model — **no ADR is required**.
- `ALTER ROLE … PASSWORD` cannot take a bound parameter, confirmed by the existing code comment (lines 60–64) and by `operations.md`. The password must be a literal in the statement text, so the fix is to change _which_ literal is emitted, not to parameterise it.
- `operations.md` (line 118) already names two remediations: leave `log_statement` at its default of `none` while migrating, or set a pre-computed SCRAM verifier instead of a plaintext password.
- PostgreSQL accepts a pre-computed SCRAM-SHA-256 verifier as the `PASSWORD` literal and authenticates the plaintext against it. Emitting the verifier keeps the plaintext out of statement text while the service still logs in with the same `APP_DATABASE_PASSWORD` value (its runtime `DATABASE_URL` is unchanged).
- A-002 keeps secrets in the platform secret store; this change concerns only how the runner moves that secret into the database, not where operators keep it.
- No production database exists yet, so changing the password-setting statement carries no backfill or migration-history consequence.

## Scope

### In scope

1. **Change `setApplicationPassword` in `src/migrate.ts`** so the emitted statement carries a SCRAM-SHA-256 verifier derived from `APP_DATABASE_PASSWORD`, not the plaintext. The existing `APP_DATABASE_PASSWORD` env contract, the refusal when it is unset or empty (lines 66–69), and the `alter role comments_app password …` statement shape are all retained; only the literal changes from plaintext to verifier.
2. **Keep `escapeLiteral`** on the emitted verifier — it is still a literal in the statement.
3. **Formalize the remediation in `docs/operations.md`** (line 118): describe the runner emitting a verifier rather than the plaintext, and retain the `log_statement = none`-during-migration posture as belt-and-braces, with the honest caveat that a SCRAM verifier is offline-crackable material rather than a public value.

### Out of scope

- Changing where operators store `APP_DATABASE_PASSWORD`, or introducing a platform secret-reference mechanism (A-002 territory; no such infrastructure exists here).
- Accepting a precomputed verifier through a new or renamed environment variable (see Open decisions).
- Setting `log_statement` from inside the runner session. It is a superuser-only (`SUSET`) parameter, so it would fail for the non-superuser migrating role on managed PostgreSQL — the exact deployment ADR-0012 protects — and is therefore not a reliable code fix.
- The service's runtime `DATABASE_URL`, which still authenticates with the same plaintext.
- Rotation tooling, seeding, and the RLS and role-attribute work already closed by Spec-012 and Spec-018.

## Contract impact

**Operational, not client-facing — stated plainly.** No client-facing contract changes. `docs/api-design.md`, `docs/database.md`, `docs/openapi.json`, the REST wire format, the domain model, and the database schema are all untouched. This changes only the SQL text the migration runner emits and the operations runbook.

- **Operational.** The `alter role comments_app password …` statement now carries a verifier instead of the plaintext, so a server logging DDL no longer captures the plaintext. Operators see no change in how they supply `APP_DATABASE_PASSWORD` or how the service connects.
- **Configuration.** Unchanged under the proposed approach: `APP_DATABASE_PASSWORD` remains the single input and continues to authenticate the service.
- **Dependencies.** None. The verifier is computable with Node's built-in `crypto` (PBKDF2-HMAC-SHA-256 plus HMAC/SHA-256), so no package is added.
- **No ADR.** The two-role model and the out-of-band password step from ADR-0012 are unchanged.

## Acceptance criteria

1. `pnpm migrate` still sets the `comments_app` password from `APP_DATABASE_PASSWORD` and still refuses when it is unset or empty — behavior unchanged from lines 66–69.
2. The statement `src/migrate.ts` emits for the password step does **not** contain the plaintext value of `APP_DATABASE_PASSWORD`; it contains a `SCRAM-SHA-256$…` verifier.
3. After migration, the service authenticates as `comments_app` using the same plaintext `APP_DATABASE_PASSWORD`, proving the verifier was derived correctly and login still works.
4. Running migrate against a server with `log_statement = all` writes no occurrence of the plaintext to the PostgreSQL server log; the verifier-bearing statement is what appears.
5. `docs/operations.md` describes the runner emitting a verifier and retains the `log_statement = none`-during-migration posture, with the caveat that a verifier is not a public value.

## Verification plan

- **Named check — `migrate password statement omits the plaintext` (unit).** Drive the runner's password step with a canary `APP_DATABASE_PASSWORD` and capture the SQL string it would send; assert the canary substring is **absent** and the `SCRAM-SHA-256$` prefix is **present**. This is the proof that the secret no longer appears in DDL text, and it mirrors the golden-vector and canary-in-logs discipline the suite already uses. It requires the password-step statement to be constructed by a testable unit rather than inlined mid-function.
- **Integration — login still works.** In the existing PostgreSQL integration suite, after migrate, open the `APP_DATABASE_URL` connection already used by the suite (it asserts `current_user = comments_app` at `tests/repositories/postgres.integration.test.ts:147`) with the plaintext and confirm it authenticates. This catches a broken verifier derivation, which criterion 2 alone would not.
- **Manual — server-log grep.** Set `log_statement = all`, run `pnpm migrate`, and grep the PostgreSQL server log for the plaintext. Expect zero hits. This is the PostgreSQL _server_ log, distinct from the application log the existing password canary already sweeps.

## Open decisions

1. **Derive the verifier in the runner vs. accept a precomputed one.** Proposed: derive it in `src/migrate.ts` from the existing `APP_DATABASE_PASSWORD`, keeping the env contract unchanged and the change to one code file. The alternative — accept a precomputed verifier via a new env var so the plaintext never enters the migrate process at all — is stronger, but adds a configuration-contract change and operator burden; deferred unless wanted.
2. **Verifier derivation source.** Proposed: Node `crypto`, adding no dependency. `pg` does not expose a stable public verifier builder, so relying on one is rejected.
3. **Whether the runbook-only posture is enough.** `operations.md` already names `log_statement = none` alone as a valid remediation. If the maintainer prefers zero code change, this spec collapses to a docs-only formalization, and criteria 2 and 4 then rest on operator posture rather than on the emitted statement. This is the crux below.
4. **Path claim for the verifying test.** The named check lives under `tests/`, which this spec's `paths:` does not claim. Per the Spec-032 path gate this either follows the established practice of Spec-012 (tests named in a spec but not path-claimed) or needs `tests/**` added to scope before implementation. Flagged, not resolved.

## Human decision required

Choose which already-disclosed remediation to formalize:

- **(A)** Change `src/migrate.ts` to emit a SCRAM-SHA-256 verifier derived from `APP_DATABASE_PASSWORD`, so the plaintext never enters statement text on any server — proposed, one code file plus a docs note, env contract unchanged; or
- **(B)** Keep the code as-is and formalize only the `log_statement = none`-during-migration posture in `docs/operations.md`, accepting that a server configured to log DDL still captures the plaintext.

Nothing is implemented until you change `approved: no` to `approved: yes`.
