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

const policy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 20,
  timeoutMs: 25,
  shouldRetry: (error) => error instanceof ProviderUnavailableError,
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

  it('keeps a bounded default budget for real providers', () => {
    expect(providerRetryPolicy.timeoutMs).toBeGreaterThan(0);
    expect(providerRetryPolicy.maxAttempts).toBeGreaterThan(1);
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
});
