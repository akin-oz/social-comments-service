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
  if (error instanceof ProviderRateLimitError) {
    if (error.retryAfterMs === null) return backoffDelay(attempt, policy);
    return error.retryAfterMs <= policy.maxDelayMs ? error.retryAfterMs : null;
  }
  return policy.shouldRetry(error) ? backoffDelay(attempt, policy) : null;
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
 * Pairs a read policy with a write policy that never replays an ambiguous
 * failure. Rate limits are still retried, because a rate-limited call is one
 * the provider refused: refusal is proof the request was not accepted.
 */
export function providerPolicies(read: RetryPolicy): ProviderRetryPolicies {
  return { read, write: { ...read, shouldRetry: () => false } };
}

export const providerRetryPolicies: ProviderRetryPolicies = providerPolicies(providerRetryPolicy);
