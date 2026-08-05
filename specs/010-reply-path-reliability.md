---
spec: 010
title: Reply-path reliability — timeouts, retries, and idempotency
status: accepted
approved: yes
owner: platform-integration
---

# Spec-010: Reply-path reliability — timeouts, retries, and idempotency

## Problem / Gap

The reply-to-comment path has three correctness and operational gaps:

1. **No provider timeouts**: The `withRetry` utility ([observability.ts](../src/shared/observability.ts)) has no call-site timeout, so a hanging provider can block indefinitely.
2. **Ignores rate-limit signals**: The retry policy treats `ProviderUnavailableError` as retriable but does not honor HTTP `Retry-After` headers or provider-specific backoff guidance.
3. **Concurrent retry race**: Two simultaneous requests with the same idempotency key can both pass the `findByIdempotencyKey` check and both attempt provider calls, leading to duplicate replies.
4. **Failure-code taxonomy drift**: The service captures `error.name` as `failureCode`, which stores `"ServiceError"` instead of the documented API error codes (e.g., `"PROVIDER_RATE_LIMITED"`).

Together, these can cause silent duplicate replies or operational timeouts under provider load.

## Context and assumptions

- **A-009**: Idempotency is required for writes; clients provide an idempotency key.
- **[operations.md](../docs/operations.md)**: Retries must be limited to safe, transient failures and remain idempotency-aware. A reply operation is persisted before provider publication and completed after storage.
- The schema already captures `failure_code` for audit and retry decisions.
- Rate-limit errors are known at the provider level and should be communicated to the caller and honored in retry delay.

## Scope

### In scope

1. **Provider call timeouts**: Set a configurable per-call timeout for `provider.replyToComment()` (recommended: 10–30s depending on provider SLA).
2. **Rate-limit-aware retry**: Parse `Retry-After` header or provider-specific backoff; if present, honor it; if absent, use exponential backoff capped at the policy limit.
3. **Concurrent idempotency claim**: Ensure that only one request per idempotency key attempts to call the provider (exclusive lock on insert or test-and-set).
4. **Failure-code alignment**: Capture the documented error code (e.g., `PROVIDER_RATE_LIMITED`, `PROVIDER_ERROR`, `UNAUTHENTICATED`) in `failureCode`, not `error.name`.

### Out of scope

- Long-running retry queues or background workers for failed replies (out of scope per A-006).
- OAuth token refresh on 401 (handled by existing credential infrastructure per A-002).
- Partial success (e.g., reply published but store fails) — the transaction already handles this as "fail the operation."

## Contract impact

### API (no change)

`POST /v2/comments/{commentId}/replies` remains unchanged. Error codes already include `PROVIDER_RATE_LIMITED` and `PROVIDER_ERROR`; the implementation now captures and communicates them correctly.

### Domain / Service layer (minimal change)

- `CommentService.replyToComment()` catches provider errors and maps them to `failureCode` using the documented taxonomy.
- Timeout and rate-limit retry are configured in the `withRetry` call.

### Observability (minor change)

- `providerRetryPolicy` gains configuration for `timeoutMs` and `shouldRetry` becomes rate-limit-aware.
- Metrics can track retry attempts and `Retry-After` delays.

### Repositories (minimal change)

- `ReplyOperationRepository` now receives a documented `failureCode` string, not an error name.

## Acceptance criteria

1. A provider call that does not complete within the timeout throws a `PROVIDER_UNAVAILABLE` error (mapped to 503).
2. A provider call that returns HTTP 429 (rate-limited) with `Retry-After: 30` is retried after 30 seconds (or immediately if configured to return 429 to the caller).
3. Two simultaneous requests with the same idempotency key only call the provider once; the second request retrieves the result of the first.
4. `failureCode` in `reply_operations` table stores values like `"PROVIDER_RATE_LIMITED"`, `"PROVIDER_ERROR"`, not `"ServiceError"` or `"ProviderUnavailableError"`.
5. A client receives HTTP 429 with `Retry-After` if the provider is rate-limited (or HTTP 503 `PROVIDER_UNAVAILABLE` if retry delay exceeds the policy limit).
6. Metrics include counters for: `reply.timeout`, `reply.rate_limited`, `reply.retry`, `reply.duplicate_attempted`.

## Verification plan

### Unit tests

- Mock provider that times out after 1s; verify timeout error is thrown and mapped to `PROVIDER_UNAVAILABLE`.
- Mock provider that returns 429 with `Retry-After: 2`; verify retry is delayed and succeeds.
- Mock provider called twice with the same idempotency key; verify second call does not reach the provider (caught by claim logic).
- Verify `failureCode` captures documented error codes, not error names.

### Integration tests (Milestone 10)

- Fixture provider with configurable delay; test timeout boundaries.
- Test concurrent requests with same idempotency key using fixture provider; verify single provider call.
- Verify `reply_operations.failure_code` and `failureCode` are aligned.

### Manual verification

- Run `pnpm dev`; simulate provider timeout with fixture provider and verify 503 is returned.
- Simulate rate-limit with fixture provider and verify 429 or retry behavior is correct.

## Configuration

### Proposed timeout and retry policy

```typescript
export const providerReplyPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  timeoutMs: 20000, // 20s per call
  shouldRetry: (error) => {
    // Retry on transient failures
    if (error instanceof Error && error.name === 'ProviderUnavailableError') return true;
    // Do NOT retry on 4xx (e.g., unauthenticated, invalid comment)
    if (error instanceof ServiceError && error.statusCode >= 400 && error.statusCode < 500)
      return false;
    return false;
  },
};
```

### Rate-limit handling

```typescript
async function withRetryAndRateLimit<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  let attempt = 1;
  while (true) {
    try {
      return await withTimeout(operation(), policy.timeoutMs);
    } catch (error) {
      if (error instanceof RateLimitError) {
        const retryAfter = parseRetryAfter(error.headers['retry-after']);
        if (retryAfter > policy.maxDelayMs) {
          throw error; // Rate-limit delay exceeds policy; return to caller
        }
        await delay(retryAfter);
        attempt += 1;
        continue;
      }
      if (attempt >= policy.maxAttempts || !policy.shouldRetry(error)) throw error;
      const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
}
```

## Open decisions

1. **Rate-limit response**: On rate-limit, should the service return 429 to the caller or retry silently? _Proposed: If retry delay fits within timeout, retry silently; if delay exceeds timeout, return 429 to caller with `Retry-After` header._
2. **Timeout per provider**: Should different providers have different timeout SLAs, or one global policy? _Proposed: One global policy initially; provider-specific SLAs can be added if needed._
3. **Idempotency claim**: Should concurrent requests with the same key block waiting for the first to complete, or immediately return a conflict? _Proposed: Return conflict (test-and-set) to encourage client backoff; blocking risks deadlock._

## Human decision required

Approval requires:

1. Confirmation of timeout (20s recommended; provider-specific guidance needed).
2. Confirmation of rate-limit response strategy (retry silently or return 429).
3. Agreement to capture error codes (not error names) in `failureCode` for audit and retry logic.
4. Confirmation that concurrent idempotency-key requests should use test-and-set (return conflict) rather than blocking.
