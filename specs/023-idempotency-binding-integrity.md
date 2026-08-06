---
spec: 023
title: Make the idempotency fingerprint bind what it claims to bind
status: proposed
approved: no
owner: platform-integration
depends_on:
  - Spec-010
  - Spec-015
---

# Spec-023: Make the idempotency fingerprint bind what it claims to bind

## Problem / gap

The fingerprint is `sha256(commentId + ':' + body)`, stored beside the operation and compared on every replay. Two things are wrong with it, and one fix addresses both.

**The comment half is not proven to bind.** Reducing the digest to `sha256(body)` survives the whole suite: no test reuses one idempotency key against a _different parent comment_. The check that stops a key being replayed against another comment is therefore untested, and the property it protects — a key names one reply to one comment — rests on a line nothing exercises.

**The digest is a guessing oracle.** `request_fingerprint` sits in the same row as `comment_id`, unsalted. Anyone who can read the table — a support engineer, a backup, an analytics export — can confirm a guess at a short reply body by computing one hash. Reply bodies are customer content; "Thanks!", "DM sent", "We'll look into it" are a very small dictionary. The row was deliberately built to avoid storing the body (ADR-0011), and an unsalted digest of it is a weaker version of storing it, presented as a stronger one.

## Context and assumptions

- A-009: the client supplies the key, the design is at-most-once, and a key binds to one request.
- Spec-010 established the claim-on-insert and the fingerprint comparison; Spec-015 added the lease and the `unknown` state on top of it.
- The service holds no secret today. Introducing one is the substantive part of this change, not the hashing.
- No production data exists, so a change of digest needs no migration of stored values — but it does invalidate any in-flight key, which matters at deploy time.

## Scope

### In scope

1. **Key the digest with a service-held secret** so a stored fingerprint cannot be confirmed against a guessed body by anyone who can read the row.
2. **Fail closed when the secret is absent** in production, in the same way and for the same reason `DATABASE_URL` does. A silent fallback to an unkeyed digest would leave the deployment believing it had the protection.
3. **Test that the comment identifier actually binds**: the same key against a different parent must conflict.
4. **State the rotation consequence** in the operations guide: rotating the secret invalidates every stored fingerprint, so a replay of an in-flight key after rotation reads as a body mismatch.
5. Keep the comparison constant-time, since it is a comparison against attacker-influenced input.

### Out of scope

- Storing the request body. ADR-0011 keeps user content out of the audit row, and this change is what makes that decision hold rather than weakening it.
- A secret-management mechanism. The service reads a reference or a value from the environment, as it already does for the database password; provisioning is the platform's under A-002.
- Changing what a fingerprint mismatch does. It stays `IDEMPOTENCY_CONFLICT` with `idempotency_key_body_mismatch`.

## Contract impact

### API

None. The fingerprint is never sent, returned, or documented.

### Persistence

No schema change: the column already holds a hex digest of the same length. The _values_ change meaning, so any operation pending across the deploy will read as a body mismatch on replay. With no production data this is free now and is not free later.

### Operations

A new required secret, and a new failure mode if it is missing. The rotation behaviour has to be written down, because rotating it looks like a client bug from the outside.

## Acceptance criteria

1. Reusing an idempotency key against a different parent comment conflicts, and deleting the comment identifier from the digest fails that test.
2. The fingerprint cannot be recomputed from the stored row and a guessed body without the secret.
3. Starting in production without the secret refuses, with a message naming what is missing.
4. Outside production a development default is used, and the fact that it is a default is visible in the startup log.
5. Comparison of a stored fingerprint against a computed one is constant-time.
6. The secret appears in no log record, no error message, and no response.
7. Every existing idempotency test still passes.

## Verification plan

- A test replaying one key against two different comments, asserting the conflict. It fails against a body-only digest.
- A test asserting two different secrets produce different fingerprints for identical input.
- A test of `chooseComposition`-style startup refusal when the secret is absent under `NODE_ENV=production`.
- A log test asserting the secret's value appears nowhere, in the same shape as the credential-reference test.
- Mutation: removing the comment identifier from the digest, and removing the production guard, must each turn a test red.

## Open decisions

1. **HMAC or a salted hash.** Proposed: HMAC-SHA256 with a service-held key, because it is the standard construction for exactly this and Node provides it without a dependency.
2. **Where the secret comes from.** Proposed: an environment variable, matching `APP_DATABASE_PASSWORD`. A reference resolved through platform infrastructure would be more consistent with A-002 and needs infrastructure that does not exist here.
3. **What happens outside production without a secret.** Proposed: a fixed development default, logged as such at startup, so `pnpm dev` needs no configuration and nobody can mistake it for a real one.
4. **Whether rotation should be supported without invalidating in-flight keys** — by trying the previous secret on comparison. Proposed: no. It doubles the comparison and the window it protects is minutes long; an operator rotates during a quiet period instead.

## Human decision required

Approval requires accepting:

1. A new required secret in production, and a service that refuses to start without it.
2. That rotating it invalidates every stored fingerprint, so a client replaying a key across the rotation is told its body changed.
3. That this is defence against someone who can already read the database — which is worth having precisely because the row was designed on the assumption that it holds nothing sensitive.
