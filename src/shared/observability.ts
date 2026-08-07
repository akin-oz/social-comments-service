import { ProviderRateLimitError, ProviderUnavailableError, ServiceError } from './errors.js';

export interface Metrics {
  increment(name: string, tags?: Readonly<Record<string, string>>): void;
  observe(name: string, milliseconds: number, tags?: Readonly<Record<string, string>>): void;
}

export const noopMetrics: Metrics = {
  increment: () => undefined,
  observe: () => undefined,
};

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Logging port (ADR-0011). Application and platform code depend on this rather
 * than on a logging library, so the domain stays free of infrastructure and the
 * backend remains replaceable.
 *
 * `event` is a stable `noun.verb` identifier that consumers match on; the
 * wording of any human-readable message is never part of the contract. Callers
 * must not pass comment bodies, author display names, or credentials in
 * `fields` — log a measurement such as a length or a count instead.
 */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Routes metric events to the logger so counters and timings are visible in
 * compositions that have not selected a metrics backend. Production
 * compositions replace this with a real exporter (ADR-0009, ADR-0011).
 */
export function loggingMetrics(logger: Logger): Metrics {
  return {
    increment: (name, tags) => logger.debug('metric.counter', { metric: name, ...tags }),
    observe: (name, milliseconds, tags) =>
      logger.debug('metric.timing', { metric: name, durationMs: milliseconds, ...tags }),
  };
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Budget for a single provider call before it is treated as unavailable. */
  timeoutMs: number;
  shouldRetry(error: unknown): boolean;
}

/**
 * Fails a provider call that exceeds its budget. The underlying request cannot
 * be cancelled, so the timer only bounds how long a caller waits.
 */
export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProviderUnavailableError(`The provider did not respond within ${timeoutMs}ms.`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs a provider call under the timeout and retry policy. Rate limits honour
 * the provider's own guidance; guidance beyond the policy budget is surfaced to
 * the caller instead of being slept off.
 */
export async function callProvider<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (error: unknown, delayMs: number) => void,
): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await withTimeout(operation, policy.timeoutMs);
    } catch (error) {
      const delayMs = retryDelayFor(error, attempt, policy);
      if (delayMs === null) throw error;
      onRetry?.(error, delayMs);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

function retryDelayFor(error: unknown, attempt: number, policy: RetryPolicy): number | null {
  if (attempt >= policy.maxAttempts) return null;
  // `shouldRetry` decides *whether* to replay; the branches below decide only
  // *when*. That order matters and used to be the other way round: the
  // rate-limit branch answered first, so the write policy's
  // `shouldRetry: () => false` was unreachable for a 429 and a publish was
  // replayed three times — the exact duplication this policy split exists to
  // prevent (Spec-026, ADR-0015).
  if (!policy.shouldRetry(error)) return null;
  if (error instanceof ProviderRateLimitError) {
    // The provider's own guidance wins when it fits the budget. Guidance beyond
    // the budget is surfaced to the caller rather than slept off.
    if (error.retryAfterMs === null) return backoffDelay(attempt, policy);
    return error.retryAfterMs <= policy.maxDelayMs ? error.retryAfterMs : null;
  }
  return backoffDelay(attempt, policy);
}

function backoffDelay(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Interprets an HTTP `Retry-After` header value in either supported form. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

export const providerRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
  timeoutMs: 20_000,
  shouldRetry: (error) => {
    if (error instanceof ProviderUnavailableError) return true;
    // A rate limit is retriable *for a read*, which is why this is stated here
    // rather than assumed by the delay logic. Refetching a page converges on
    // the same rows through the upsert, so replaying one costs a provider call
    // and nothing else. The write policy overrides this to false, and since
    // `retryDelayFor` now consults `shouldRetry` first, that override is what
    // actually decides a 429 on the reply path (Spec-026).
    if (error instanceof ProviderRateLimitError) return true;
    // Never replay a request the provider already rejected on its merits.
    if (error instanceof ServiceError) return false;
    return false;
  },
};

/**
 * Reads and writes cannot share a retry policy.
 *
 * A read is safe to replay: fetching the same provider page twice converges on
 * the same rows through the upsert. A write is not. A timeout does not prove
 * the provider rejected the request — it proves only that no answer arrived —
 * so replaying one can publish a second reply under someone else's name, which
 * is precisely the duplication the idempotency design exists to prevent.
 */
export interface ProviderRetryPolicies {
  read: RetryPolicy;
  write: RetryPolicy;
}

/**
 * Pairs a read policy with a write policy that replays nothing at all.
 *
 * This used to carve out rate limits, on the premise that "a rate-limited call
 * is one the provider refused, and refusal is proof the request was not
 * accepted." That premise is true of a 429 raised by the write handler and
 * false of a 429 raised by anything in front of it — Meta's limiter, a CDN, a
 * gateway refusing on its own retry budget — which can return 429 *after* the
 * origin accepted and published. The service cannot tell the two apart from the
 * status code, so it no longer guesses (ADR-0015).
 *
 * The carve-out was also unreachable in the direction that mattered: because
 * `retryDelayFor` consulted the rate-limit branch before `shouldRetry`, this
 * `() => false` never ran for a 429, and a publish was replayed up to three
 * times. Both halves are fixed; this one is the statement of intent.
 */
export function providerPolicies(read: RetryPolicy): ProviderRetryPolicies {
  return { read, write: { ...read, shouldRetry: () => false } };
}

export const providerRetryPolicies: ProviderRetryPolicies = providerPolicies(providerRetryPolicy);
