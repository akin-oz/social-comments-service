# Manual QA — Comment Service

Human-executable acceptance cases for the two `/v2` operations, tenant isolation,
pagination, idempotency, and error semantics. Every case is grounded in the
authoritative contract (`docs/api-design.md`, the route schemas, and the seed),
not in assumed behaviour.

Branch checks on **`error.code` + `error.reason`**, never on `message` — the
message wording is explicitly outside the contract.

---

## Setup

Pick a target. Both are equivalent; the live demo has `ENABLE_API_DOCS=true`.

```bash
# Live demo
export BASE=https://comments.akinoztorun.dev
# — or local (docker compose up --build --wait), then:
# export BASE=http://localhost:3000

# Seeded fixtures (fixed IDs shared by seed, README, and the isolation tests)
export ACCOUNT_A=2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001   # tenant A (instagram)
export POST_A=2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b002       #   tenant A, post 1
export POST_A2=2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b022      #   tenant A, 2nd connection's post
export ACCOUNT_B=7c3d9e10-4a5b-4c6d-8e9f-01a2b3c4d005   # tenant B (instagram)
export POST_B=7c3d9e10-4a5b-4c6d-8e9f-01a2b3c4d006       #   tenant B, post 2
export ACCOUNT_C=f0a4c2d8-6b3e-4f21-8a7c-3d5e9b1c2007   # tenant C (youtube)
export POST_C=f0a4c2d8-6b3e-4f21-8a7c-3d5e9b1c2008       #   tenant C, video 1
```

`jq` is used to read `error.code`/`error.reason`. Add `-i` (or `-w '\n%{http_code}\n'`)
to any `curl` to see the status line.

> **Note on reply cases.** Comment IDs are service-owned UUIDs assigned at
> persistence time, so they are **not** fixed constants — you obtain a live one
> by listing the post first (QA-11 helper). Reply cases publish through the
> deployment's configured provider and create data; that is expected and safe
> against the demo/fixture provider.

Helper used by several reply cases — grab a real **top-level** comment id:

```bash
get_comment() { curl -s "$BASE/v2/posts/$1/comments?limit=25" -H "X-Account-Id: $2" \
  | jq -r '.data[] | select(.parentCommentId==null) | .id' | head -1; }
```

---

## A. Liveness & documentation

### QA-01 — Health probe is public
- **Steps:** `curl -i "$BASE/health"`
- **Expected:** `200`. No `X-Account-Id` required (health touches no account and no DB).

### QA-02 — Swagger UI served when docs enabled
- **Steps:** open `"$BASE/documentation"` in a browser.
- **Expected:** `200`, Swagger UI renders the two `/v2` operations. Not under `/v2`, no account context.

### QA-03 — OpenAPI document served
- **Steps:** `curl -s "$BASE/openapi.json" | jq '.openapi, (.paths | keys)'`
- **Expected:** `"3.1.x"`; paths include `/v2/posts/{postId}/comments` and `/v2/comments/{commentId}/replies`.

---

## B. Authentication / account context (A-001 trust boundary)

### QA-04 — Missing `X-Account-Id` is rejected
- **Steps:** `curl -s "$BASE/v2/posts/$POST_A/comments" | jq .error`
- **Expected:** `401`; code `UNAUTHENTICATED`, reason `missing_account_context`.

### QA-05 — Non-UUID `X-Account-Id` is rejected
- **Steps:** `curl -s "$BASE/v2/posts/$POST_A/comments" -H "X-Account-Id: not-a-uuid" | jq .error`
- **Expected:** `401`; `UNAUTHENTICATED` / `missing_account_context` (the header must be a UUID).

### QA-06 — Reply also requires account context
- **Steps:** `curl -s -X POST "$BASE/v2/comments/00000000-0000-0000-0000-000000000000/replies" -H "Content-Type: application/json" -H "Idempotency-Key: k1" -d '{"body":"hi"}' | jq .error`
- **Expected:** `401`; `UNAUTHENTICATED` / `missing_account_context` (auth is checked before anything else).

### QA-07 — Client `X-Request-Id` is ignored
- **Steps:** send any request with `-H "X-Request-Id: attacker-chosen"` and trigger an error (e.g. QA-04 shape with a bad account).
- **Expected:** `error.requestId` is a **service-generated** value, not `attacker-chosen`.

---

## C. Retrieve comments — happy path

### QA-08 — List returns a well-formed page
- **Steps:** `curl -s "$BASE/v2/posts/$POST_A/comments?limit=5" -H "X-Account-Id: $ACCOUNT_A" | jq '{n:(.data|length), pg:.pagination, snap:.snapshot}'`
- **Expected:** `200`. `data` is an array of comments; each has `id, postId, platform, author{id,displayName}, body, parentCommentId, publishedAt, updatedAt`. `pagination` has `hasMore` + `nextCursor`; `snapshot.syncedAt` present (string or `null`).

### QA-09 — Provider identifiers never leak
- **Steps:** `curl -s "$BASE/v2/posts/$POST_A/comments?limit=25" -H "X-Account-Id: $ACCOUNT_A" | jq '.data[0]'`
- **Expected:** comment `id`/`postId` are service UUIDs. No provider comment/post id fields present. `author.id` **is** the provider's author id (the one documented exception).

### QA-10 — Default limit is 25
- **Steps:** list without `limit`.
- **Expected:** `200`; at most 25 items (fewer is valid — see QA-14).

### QA-11 — `platform` reflects the post
- **Steps:** list `$POST_A` (tenant A) and `$POST_C` (tenant C) as their owners.
- **Expected:** A's comments carry `"platform":"instagram"`; C's carry `"platform":"youtube"`.

---

## D. Pagination

### QA-12 — Follow `nextCursor` to page through
- **Steps:**
```bash
r1=$(curl -s "$BASE/v2/posts/$POST_A/comments?limit=1" -H "X-Account-Id: $ACCOUNT_A")
cur=$(echo "$r1" | jq -r '.pagination.nextCursor')
curl -s "$BASE/v2/posts/$POST_A/comments?limit=1&cursor=$cur" -H "X-Account-Id: $ACCOUNT_A" | jq '.data[0].id'
```
- **Expected:** page 1 has `hasMore:true` + non-null `nextCursor`; page 2 returns the **next** comment (ascending `publishedAt,id`), no repeat of page 1.

### QA-13 — Keyset stability (no dupes, no gaps)
- **Steps:** page fully through a post one item at a time, collecting `data[].id`.
- **Expected:** ids are strictly ordered and unique across the whole run; the final page has `hasMore:false` and `nextCursor:null`.

### QA-14 — A short page does not mean the end
- **Reference:** `hasMore` reflects whether more exist, **not** whether this page filled. A page may hold fewer than `limit`, or none, with `hasMore:true`.
- **Expected:** a client keeps going while `hasMore` is true regardless of page size.

### QA-15 — Fabricated cursor is rejected
- **Steps:** `curl -s "$BASE/v2/posts/$POST_A/comments?cursor=not-a-real-cursor" -H "X-Account-Id: $ACCOUNT_A" | jq .error`
- **Expected:** `400`; code `INVALID_CURSOR`, reason `cursor_not_issued_by_service`. (Action: restart from no cursor.)

### QA-16 — Empty cursor fails schema validation
- **Steps:** request with `cursor=` (empty).
- **Expected:** `400`; `INVALID_REQUEST` / `request_validation_failed` (`cursor` has `minLength:1`).

---

## E. Snapshot / `syncedAt` semantics (Spec-021)

### QA-17 — A partial run ends on `syncedAt: null` → restart
- **Steps:** page a post to its last page (`hasMore:false`) and read `snapshot.syncedAt`.
- **Expected:** if the **final** page carries `syncedAt: null`, the run was partial — restart from no cursor. The second run returns everything and ends with `syncedAt` set to a timestamp. If the final page already has a timestamp, the single run was complete. (A client that ignores `syncedAt` still gets a gap-free, duplicate-free sequence.)

---

## F. Tenant isolation (the headline requirement)

### QA-18 — Cross-tenant read is 404, not 403
- **Steps:** tenant A reads tenant B's post:
```bash
curl -s "$BASE/v2/posts/$POST_B/comments" -H "X-Account-Id: $ACCOUNT_A" | jq .error
```
- **Expected:** `404`; code `POST_NOT_FOUND`, reason `post_not_found`. The response must **not** reveal that the post exists (no `403`).

### QA-19 — Each tenant sees only its own post
- **Steps:** A→`$POST_A` and B→`$POST_B` succeed (`200`); A→`$POST_B` and B→`$POST_A` both `404 POST_NOT_FOUND`.
- **Expected:** as above — the isolation is symmetric.

### QA-20 — Unknown post id is 404 (not a 500)
- **Steps:** `curl -s "$BASE/v2/posts/11111111-1111-1111-1111-111111111111/comments" -H "X-Account-Id: $ACCOUNT_A" | jq .error`
- **Expected:** `404`; `POST_NOT_FOUND` / `post_not_found`.

### QA-21 — Cross-tenant reply target is hidden too
- **Steps:** with a real comment id from tenant B's post, attempt a reply **as tenant A**.
```bash
CB=$(get_comment "$POST_B" "$ACCOUNT_B")
curl -s -X POST "$BASE/v2/comments/$CB/replies" -H "X-Account-Id: $ACCOUNT_A" \
  -H "Content-Type: application/json" -H "Idempotency-Key: xt-1" -d '{"body":"hi"}' | jq .error
```
- **Expected:** `404`; `COMMENT_NOT_FOUND` / `comment_not_found` (A cannot see B's comment).

---

## G. Reply — happy path

### QA-22 — Publish a reply to a top-level comment
- **Steps:**
```bash
CA=$(get_comment "$POST_A" "$ACCOUNT_A")
curl -s -X POST "$BASE/v2/comments/$CA/replies" -H "X-Account-Id: $ACCOUNT_A" \
  -H "Content-Type: application/json" -H "Idempotency-Key: reply-$(date +%s)" \
  -d '{"body":"Thank you!"}' | jq '{status:"201?", data:.data}'
```
- **Expected:** `201`. `data.parentCommentId == $CA`; `data.body == "Thank you!"`; `data.id` is a new service UUID; `data.platform == "instagram"`.

### QA-23 — Reply to an id the service never issued
- **Steps:** POST a reply to `99999999-9999-9999-9999-999999999999`.
- **Expected:** `404`; `COMMENT_NOT_FOUND` / `comment_not_found` (reply requires the parent to be in the local snapshot; list first).

---

## H. Reply — idempotency (Spec-023)

### QA-24 — Same key + same body replays, does not duplicate
- **Steps:** send QA-22's request **twice** with the **same** `Idempotency-Key` and identical body.
```bash
CA=$(get_comment "$POST_A" "$ACCOUNT_A"); K=idem-$(date +%s)
one=$(curl -s -X POST "$BASE/v2/comments/$CA/replies" -H "X-Account-Id: $ACCOUNT_A" -H "Content-Type: application/json" -H "Idempotency-Key: $K" -d '{"body":"dup?"}')
two=$(curl -s -X POST "$BASE/v2/comments/$CA/replies" -H "X-Account-Id: $ACCOUNT_A" -H "Content-Type: application/json" -H "Idempotency-Key: $K" -d '{"body":"dup?"}')
echo "$one" | jq .data.id; echo "$two" | jq .data.id
```
- **Expected:** both `201`, **identical `data.id`** — the reply is published once and replayed.

### QA-25 — Same key + different body is a conflict
- **Steps:** reuse `$K` from QA-24 with a **different** body.
- **Expected:** `409`; `IDEMPOTENCY_CONFLICT` / `idempotency_key_body_mismatch`. (Action: fix the caller — reusing a key for a different body is a bug.)

### QA-26 — Missing `Idempotency-Key`
- **Steps:** POST a valid reply body with no `Idempotency-Key` header.
- **Expected:** `400`; `INVALID_REQUEST` / `idempotency_key_missing`.

### QA-27 — Over-long `Idempotency-Key`
- **Steps:** send `Idempotency-Key` of 256+ chars (`printf 'k%.0s' {1..300}`).
- **Expected:** `400`; `INVALID_REQUEST` / `request_validation_failed` (key is capped at 255).

---

## I. Reply — body validation & depth

### QA-28 — Empty body rejected
- **Steps:** `-d '{"body":""}'`.
- **Expected:** `400`; `INVALID_REQUEST` / `request_validation_failed` (`body` `minLength:1`).

### QA-29 — Missing body field rejected
- **Steps:** `-d '{}'`.
- **Expected:** `400`; `INVALID_REQUEST` / `request_validation_failed` (`body` required).

### QA-30 — Body over 10 000 chars rejected (schema, not transport)
- **Steps:** body of 10 001 chars: `-d "{\"body\":\"$(printf 'a%.0s' {1..10001})\"}"`.
- **Expected:** `400`; `INVALID_REQUEST` / `request_validation_failed` (`maxLength:10000`). Distinct from the 64 KB transport limit (QA-33).

### QA-31 — Control characters rejected
- **Steps:** body containing a NUL / C0 control char (e.g. ` `).
- **Expected:** `400`; `INVALID_REQUEST` / `request_validation_failed` (an unstorable body is refused before it can reach the provider).

### QA-32 — Reply to a reply exceeds allowed depth (ADR-0014)
- **Steps:** publish a reply (QA-22), capture its `data.id`, then POST a reply **to that reply's id** on Instagram (tenant A).
- **Expected:** `422`; `REPLY_DEPTH_EXCEEDED` / `reply_depth_exceeded` (one level of replies is the service's normalisation). Action: reply to the top-level comment instead.

---

## J. Transport & routing limits (Spec-022)

### QA-33 — Body over 64 KB is 413, not a crash
- **Steps:** POST a reply whose JSON payload exceeds 64 KB: `-d "{\"body\":\"$(printf 'a%.0s' {1..70000})\"}"`.
- **Expected:** `413`; `INVALID_REQUEST` / `request_body_too_large`.

### QA-34 — Unsupported content type
- **Steps:** POST with `-H "Content-Type: text/plain" -d 'hello'`.
- **Expected:** `415`; `INVALID_REQUEST` / `request_body_malformed`.

### QA-35 — Malformed JSON
- **Steps:** POST `-H "Content-Type: application/json" -d '{"body":'` (truncated JSON) with a valid account + key.
- **Expected:** `400`; `INVALID_REQUEST` / `request_body_malformed`.

### QA-36 — Unknown route
- **Steps:** `curl -s "$BASE/v2/nope" -H "X-Account-Id: $ACCOUNT_A" | jq .error`
- **Expected:** `404`; code `ROUTE_NOT_FOUND` (no route matched, distinct from a scoped resource 404).

### QA-37 — Unknown query parameter is ignored (forward-compatible)
- **Steps:** `curl -s -w '\n%{http_code}\n' "$BASE/v2/posts/$POST_A/comments?bogus=1" -H "X-Account-Id: $ACCOUNT_A"`
- **Expected:** `200`. The unknown parameter is **stripped and ignored**, not rejected — Fastify's ajv `removeAdditional` drops it before validation, so the `additionalProperties:false` on the querystring never trips. This matches the `/v2` compatibility policy: adding an optional request parameter is a permitted, non-breaking change, so an older deployment tolerates a parameter a newer client sends. Contrast QA-38, where a *known* parameter with an out-of-range value **is** a `400`.
- **Verified:** live demo returns `200`. *(Same mechanism applies to the reply body — unknown fields are stripped, not rejected.)*

### QA-38 — `limit` out of range rejected
- **Steps:** `?limit=0`, `?limit=101`, `?limit=abc` (three requests).
- **Expected:** each `400`; `INVALID_REQUEST` / `request_validation_failed` (`limit` is integer 1–100).

---

## Coverage map

| Area | Cases |
| --- | --- |
| Liveness & docs | QA-01–03 |
| Auth / account context | QA-04–07 |
| Retrieve — happy path | QA-08–11 |
| Pagination | QA-12–16 |
| Snapshot semantics | QA-17 |
| **Tenant isolation** | QA-18–21 |
| Reply — happy path | QA-22–23 |
| Idempotency | QA-24–27 |
| Body validation & depth | QA-28–32 |
| Transport & routing | QA-33–38 |

**Result key:** every failure asserts an HTTP status **and** the exact
`error.code` + `error.reason`. A case that returns the right status with the
wrong reason is a fail — the reason is the machine-actionable half of the
contract.
