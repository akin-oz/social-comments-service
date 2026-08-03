export interface Metrics {
  increment(name: string, tags?: Readonly<Record<string, string>>): void;
  observe(name: string, milliseconds: number, tags?: Readonly<Record<string, string>>): void;
}

export const noopMetrics: Metrics = {
  increment: () => undefined,
  observe: () => undefined,
};

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry(error: unknown): boolean;
}

export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  let attempt = 1;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= policy.maxAttempts || !policy.shouldRetry(error)) throw error;
      const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
}

export const providerRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 500,
  shouldRetry: (error) => error instanceof Error && error.name === 'ProviderUnavailableError',
};
