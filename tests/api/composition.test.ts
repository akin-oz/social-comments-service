import { describe, expect, it } from 'vitest';

import {
  chooseComposition,
  createDemoApplication,
  demoAccountId,
  demoPost,
  toLoggerPort,
} from '../../src/index.js';
import { noopLogger, type Metrics } from '../../src/shared/observability.js';

/**
 * The rules that decide what the process becomes, and the composition wiring
 * that decides what it logs.
 *
 * These lived only in `src/server.ts`, which no test imports and no CI step
 * runs, so the fail-closed guard — the one control whose entire job is to stop
 * a silent production downgrade — was deletable with the suite green
 * (Spec-020).
 */
describe('composition selection', () => {
  it('runs on PostgreSQL when a database URL is present', () => {
    expect(chooseComposition({ DATABASE_URL: 'postgres://x/y' })).toEqual({
      kind: 'postgres',
      databaseUrl: 'postgres://x/y',
    });
  });

  it('runs the in-memory demo outside production', () => {
    expect(chooseComposition({})).toEqual({ kind: 'demo' });
    expect(chooseComposition({ NODE_ENV: 'development' })).toEqual({ kind: 'demo' });
  });

  it('refuses to start in production without a database', () => {
    // The in-memory composition passes its health check, accepts any account,
    // and has no row-level security behind it. Starting it because a variable
    // was misspelled is the worst outcome available.
    const choice = chooseComposition({ NODE_ENV: 'production' });

    expect(choice.kind).toBe('refuse');
    expect(choice.kind === 'refuse' && choice.reason).toContain('DATABASE_URL');
  });

  it('treats an empty database URL as absent, not as a connection string', () => {
    expect(chooseComposition({ NODE_ENV: 'production', DATABASE_URL: '' }).kind).toBe('refuse');
    expect(chooseComposition({ DATABASE_URL: '' }).kind).toBe('demo');
  });

  it('still runs on PostgreSQL in production when the URL is set', () => {
    expect(chooseComposition({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y' })).toEqual({
      kind: 'postgres',
      databaseUrl: 'postgres://x/y',
    });
  });
});

describe('composition observability wiring', () => {
  it('drives the metrics port from a real request', async () => {
    // Every other test passes `noopMetrics`, so nothing observed that the
    // service calls the port at all — the counters and timings the operations
    // guide tells an operator to watch could have been silently dead
    // (Spec-020).
    const counters: { name: string; tags?: Record<string, string> }[] = [];
    const timings: { name: string; ms: number }[] = [];
    const metrics: Metrics = {
      increment: (name, tags) => counters.push({ name, ...(tags ? { tags: { ...tags } } : {}) }),
      observe: (name, ms) => timings.push({ name, ms }),
    };
    const app = createDemoApplication({ logger: false, metrics });

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments?limit=2`,
      headers: { 'x-account-id': demoAccountId },
    });
    expect(response.statusCode).toBe(200);

    expect(counters.map((counter) => counter.name)).toContain('comments.list.success');
    expect(counters.map((counter) => counter.name)).toContain('comments.list.hydrated');
    expect(counters.find((counter) => counter.name === 'comments.list.success')?.tags).toEqual({
      platform: 'instagram',
    });
    expect(timings.map((timing) => timing.name)).toContain('comments.list.duration_ms');
    expect(timings.every((timing) => Number.isFinite(timing.ms))).toBe(true);
    await app.close();
  });

  it('adapts a log sink to the logger port with the event promoted to a field', () => {
    const written: { fields: Record<string, unknown>; message: string }[] = [];
    const sink = {
      debug: (fields: Record<string, unknown>, message: string) =>
        written.push({ fields, message }),
      info: (fields: Record<string, unknown>, message: string) => written.push({ fields, message }),
      warn: (fields: Record<string, unknown>, message: string) => written.push({ fields, message }),
      error: (fields: Record<string, unknown>, message: string) =>
        written.push({ fields, message }),
    };

    toLoggerPort(sink).warn('comments.reply.conflict', { commentId: 'c-1' });

    expect(written).toEqual([
      {
        fields: { event: 'comments.reply.conflict', commentId: 'c-1' },
        message: 'comments.reply.conflict',
      },
    ]);
    expect(noopLogger.warn('anything')).toBeUndefined();
  });
});
