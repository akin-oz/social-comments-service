import { describe, expect, it, vi } from 'vitest';

import {
  callProvider,
  parseRetryAfter,
  providerPolicies,
  providerRetryPolicy,
  withTimeout,
  type RetryPolicy,
} from '../../src/shared/observability.js';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../../src/shared/errors.js';
import { REQUEST_TIMEOUT_MS } from '../../src/index.js';

/**
 * Stands in for a read policy: replaying a read is safe, so it retries both
 * classes. Rate limits are named explicitly because `retryDelayFor` now asks
 * `shouldRetry` before it looks at the error class — a policy that does not
 * claim rate limits does not get them retried, which is exactly how the write
 * policy stops a publish being replayed (Spec-026).
 */
const policy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 20,
  timeoutMs: 25,
  shouldRetry: (error) =>
    error instanceof ProviderUnavailableError || error instanceof ProviderRateLimitError,
};

describe('provider call policy', () => {
  it('fails a call that exceeds its budget as provider unavailable', async () => {
    await expect(
      withTimeout(() => new Promise((resolve) => setTimeout(resolve, 50)), 5),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('retries transient failures until one succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ProviderUnavailableError('temporarily down'))
      .mockResolvedValueOnce('published');
    await expect(callProvider(operation, policy)).resolves.toBe('published');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('never replays a failure the provider rejected on its merits', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new ProviderError('malformed request'));
    await expect(callProvider(operation, policy)).rejects.toBeInstanceOf(ProviderError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('honours rate-limit guidance that fits inside the retry budget', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ProviderRateLimitError('slow down', 5))
      .mockResolvedValueOnce('published');
    await expect(callProvider(operation, policy)).resolves.toBe('published');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('surfaces rate limits whose guidance exceeds the retry budget', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new ProviderRateLimitError('slow down', 60_000));
    await expect(callProvider(operation, policy)).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('reads both supported Retry-After encodings', () => {
    const now = Date.parse('2026-08-01T10:00:00.000Z');
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter('Sat, 01 Aug 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter('not-a-delay', now)).toBeNull();
  });

  it('refuses a negative delay and a date already in the past', () => {
    // A provider that sends a nonsense Retry-After must not produce a negative
    // sleep or a negative header value.
    const now = Date.parse('2026-08-01T10:00:00.000Z');
    expect(parseRetryAfter('-30', now)).toBeNull();
    // An HTTP-date in the past clamps to zero rather than going negative.
    expect(parseRetryAfter('Sat, 01 Aug 2026 09:59:30 GMT', now)).toBe(0);
  });

  it('keeps a bounded default budget for real providers', () => {
    // `> 0` and `> 1` are the assertions that cannot fail: timeoutMs 20s→200s
    // and maxDelayMs 5s→600s both survived them, and either would hold an HTTP
    // request open far past the point the client abandoned it. A budget is only
    // bounded if something pins the upper end (Spec-020).
    expect(providerRetryPolicy.timeoutMs).toBeGreaterThan(0);
    expect(providerRetryPolicy.timeoutMs).toBeLessThan(REQUEST_TIMEOUT_MS);

    expect(providerRetryPolicy.maxAttempts).toBeGreaterThan(1);
    expect(providerRetryPolicy.maxAttempts).toBeLessThanOrEqual(5);

    // The whole retry ladder has to fit inside one request too, so no single
    // backoff may approach the request timeout on its own.
    expect(providerRetryPolicy.maxDelayMs).toBeGreaterThan(0);
    expect(providerRetryPolicy.maxDelayMs).toBeLessThanOrEqual(10_000);
    expect(providerRetryPolicy.baseDelayMs).toBeLessThanOrEqual(providerRetryPolicy.maxDelayMs);
  });

  it('retries a transient failure under the policy that actually ships', async () => {
    // Every retry test above used a policy defined in this file, so the retry
    // branch of the shipped configuration never ran: `shouldRetry` could have
    // returned false for everything and nothing would have failed (Spec-020).
    let attempts = 0;
    const shipped = { ...providerRetryPolicy, baseDelayMs: 1, maxDelayMs: 2 };

    const result = await callProvider(async () => {
      attempts += 1;
      if (attempts < 3) throw new ProviderUnavailableError('temporarily down');
      return 'recovered';
    }, shipped);

    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
  });

  it('does not replay a provider refusal under the shipped policy either', async () => {
    let attempts = 0;
    const shipped = { ...providerRetryPolicy, baseDelayMs: 1, maxDelayMs: 2 };

    await expect(
      callProvider(async () => {
        attempts += 1;
        throw new ProviderError('upstream rejected the request');
      }, shipped),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(attempts).toBe(1);
  });

  it('never replays a write, whatever the read policy allows', async () => {
    // The pairing is the safety property: a timed-out publish may have
    // succeeded, so the write policy must refuse where the read policy retries.
    let reads = 0;
    let writes = 0;
    const policies = providerPolicies({ ...providerRetryPolicy, baseDelayMs: 1, maxDelayMs: 2 });

    await expect(
      callProvider(async () => {
        reads += 1;
        throw new ProviderUnavailableError('temporarily down');
      }, policies.read),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    await expect(
      callProvider(async () => {
        writes += 1;
        throw new ProviderUnavailableError('temporarily down');
      }, policies.write),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    expect(reads).toBe(providerRetryPolicy.maxAttempts);
    expect(writes).toBe(1);
  });

  it('never replays a write on a rate limit, at any Retry-After value', async () => {
    // The gap the test above could not see. `write` sets `shouldRetry: () => false`,
    // but `retryDelayFor` used to answer the rate-limit branch first, so that
    // override was dead code for a 429 and a publish went out three times.
    //
    // Every reply rate-limit test in the suite used `retryAfterMs: 30_000`,
    // which exceeds `maxDelayMs` and takes the branch that returns null — so the
    // suite agreed the write was not replayed while the two cases that matter
    // replayed it. Both are pinned here: a small Retry-After, and the absent
    // header that Meta and X routinely send, which falls to exponential backoff
    // from 100ms (Spec-026, ADR-0015).
    const policies = providerPolicies({ ...providerRetryPolicy, baseDelayMs: 1, maxDelayMs: 2 });

    for (const retryAfterMs of [200, 30_000, null]) {
      let publishes = 0;
      await expect(
        callProvider(async () => {
          publishes += 1;
          throw new ProviderRateLimitError('429 from an intermediary', retryAfterMs);
        }, policies.write),
      ).rejects.toBeInstanceOf(ProviderRateLimitError);

      expect(publishes, `Retry-After ${String(retryAfterMs)} replayed the publish`).toBe(1);
    }
  });

  it('still retries a rate-limited read, which is safe to replay', async () => {
    // The other half of the same change: closing the write path must not close
    // the read path, where a 429 is worth waiting out and refetching a page
    // converges on the same rows through the upsert.
    const policies = providerPolicies({ ...providerRetryPolicy, baseDelayMs: 1, maxDelayMs: 5 });
    let reads = 0;

    const result = await callProvider(async () => {
      reads += 1;
      if (reads < 2) throw new ProviderRateLimitError('slow down', 1);
      return 'page';
    }, policies.read);

    expect(result).toBe('page');
    expect(reads).toBe(2);
  });
});
