import { describe, expect, it } from 'vitest';

import {
  createApplication,
  createDemoApplication,
  demoAccountId,
  demoPost,
} from '../../src/index.js';
import { AdaptiveProviderAdapter } from '../../src/platforms/adaptive-provider.js';
import {
  InMemoryCommentRepository,
  InMemoryPostRepository,
} from '../../src/repositories/in-memory.js';
import { ProviderRateLimitError } from '../../src/shared/errors.js';
import { providerPolicies, providerRetryPolicy } from '../../src/shared/observability.js';

const auth = { 'x-account-id': demoAccountId };

/** A composition whose provider always rate limits, with the given guidance. */
function rateLimitedApp(retryAfterMs: number) {
  return createApplication({
    logger: false,
    posts: new InMemoryPostRepository([demoPost]),
    comments: new InMemoryCommentRepository([], demoAccountId),
    providers: new Map([
      [
        'instagram' as const,
        new AdaptiveProviderAdapter(
          'instagram',
          {
            listComments: async () => {
              throw new ProviderRateLimitError('Too many requests.', retryAfterMs);
            },
            replyToComment: async () => {
              throw new Error('not used');
            },
          },
          new Set(['list_comments']),
          providerPolicies({ ...providerRetryPolicy, maxAttempts: 1 }),
        ),
      ],
    ]),
  });
}

/** Records what the composition logs, so level rules can be asserted. */
function captureLogs(
  app: ReturnType<typeof createDemoApplication>,
  into: { level: string; fields: Record<string, unknown> }[],
): void {
  for (const level of ['warn', 'error'] as const) {
    const original = app.log[level].bind(app.log);
    Object.defineProperty(app.log, level, {
      configurable: true,
      value: (fields: Record<string, unknown>, message: string) => {
        if (typeof fields === 'object') into.push({ level, fields });
        return original(fields as never, message as never);
      },
    });
  }
}

async function listComments(
  app: ReturnType<typeof createDemoApplication>,
  query = 'limit=10',
): Promise<{
  statusCode: number;
  body: { data: { id: string }[]; pagination: { nextCursor: string | null; hasMore: boolean } };
}> {
  const response = await app.inject({
    method: 'GET',
    url: `/v2/posts/${demoPost.id}/comments?${query}`,
    headers: auth,
  });
  return { statusCode: response.statusCode, body: response.json() };
}

describe('comment REST API', () => {
  it('serves comments hydrated from the provider on first request', async () => {
    const app = createDemoApplication({ logger: false });

    const { statusCode, body } = await listComments(app);

    expect(statusCode).toBe(200);
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toEqual({
      id: expect.any(String),
      postId: demoPost.id,
      platform: 'instagram',
      author: { id: expect.any(String), displayName: 'Ada Lovelace' },
      body: 'This is great!',
      parentCommentId: null,
      publishedAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    });
    await app.close();
  });

  it('never serializes provider identifiers to clients', async () => {
    const app = createDemoApplication({ logger: false });

    const { body } = await listComments(app);

    expect(JSON.stringify(body)).not.toContain('ig-comment-');
    await app.close();
  });

  it('never serializes the authorised connection to clients', async () => {
    // The connection travels with every provider call (Spec-016). It names a
    // secret and identifies a platform account, so neither it nor the social
    // account it points at may cross the API boundary.
    const app = createDemoApplication({ logger: false });

    const { body } = await listComments(app);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(demoPost.connection.credentialReference);
    expect(serialized).not.toContain(demoPost.connection.socialAccountId);
    expect(serialized).not.toContain('secret://');
    await app.close();
  });

  it('walks every page using the cursor it issued', async () => {
    const app = createDemoApplication({ logger: false });

    const first = await listComments(app, 'limit=2');
    expect(first.body.pagination.hasMore).toBe(true);

    const cursor = first.body.pagination.nextCursor ?? '';
    const second = await listComments(app, `limit=2&cursor=${encodeURIComponent(cursor)}`);

    expect(second.statusCode).toBe(200);
    expect(second.body.data.map((item) => item.id)).not.toEqual(
      first.body.data.map((item) => item.id),
    );
    expect(second.body.pagination.hasMore).toBe(false);
    await app.close();
  });

  it('rejects a cursor the service did not issue', async () => {
    const app = createDemoApplication({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments?cursor=tampered`,
      headers: auth,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
    await app.close();
  });

  it('requires an account context and an idempotency key', async () => {
    const app = createDemoApplication({ logger: false });

    await expect(
      app.inject({ method: 'GET', url: `/v2/posts/${demoPost.id}/comments` }),
    ).resolves.toMatchObject({ statusCode: 401 });

    const { body } = await listComments(app);
    const commentId = body.data[0]?.id ?? '';
    const response = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: auth,
      payload: { body: 'Thanks!' },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('carries a machine-readable reason on every error, not only a message', async () => {
    // Correct client behaviour used to depend on matching English prose, which
    // a copy-edit silently breaks (Spec-017).
    const app = createDemoApplication({ logger: false });

    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments`,
    });
    const badCursor = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments?cursor=not-a-cursor`,
      headers: auth,
    });

    expect(unauthenticated.json()).toMatchObject({
      error: { code: 'UNAUTHENTICATED', reason: 'missing_account_context' },
    });
    expect(badCursor.json()).toMatchObject({
      error: { code: 'INVALID_CURSOR', reason: 'cursor_not_issued_by_service' },
    });
    await app.close();
  });

  it('sends Retry-After when the provider supplied that guidance', async () => {
    // Described in prose since the first version and never asserted on a
    // response, so nothing would have caught it disappearing.
    const app = rateLimitedApp(45_000);

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments`,
      headers: auth,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('45');
    expect(response.json()).toMatchObject({
      error: { code: 'PROVIDER_RATE_LIMITED', reason: 'provider_rate_limited' },
    });
    await app.close();
  });

  it('rounds Retry-After up, so a client never retries too early', async () => {
    // 1500 ms must become 2 seconds, not 1. Rounding down tells the client to
    // come back while the provider is still refusing.
    const app = rateLimitedApp(1_500);

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments`,
      headers: auth,
    });

    expect(response.headers['retry-after']).toBe('2');
    await app.close();
  });

  it('names a reason on both routes to a 400, not only the status', async () => {
    // Two different guards produce a 400 here and they are not the same
    // situation. An absent header fails the route schema, which is generic
    // request validation. A header that is present but blank reaches the
    // handler, which knows exactly what is wrong. Only asserting "400" hid
    // that the two reasons differ (Spec-020).
    const app = createDemoApplication({ logger: false });
    const { body } = await listComments(app);
    const commentId = body.data[0]?.id ?? '';

    const absent = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: auth,
      payload: { body: 'Thanks!' },
    });
    const blank = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: { ...auth, 'idempotency-key': '   ' },
      payload: { body: 'Thanks!' },
    });

    expect(absent.statusCode).toBe(400);
    expect(absent.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', reason: 'request_validation_failed' },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', reason: 'idempotency_key_missing' },
    });
    await app.close();
  });

  it('logs a refused client request at warn and a service failure at error', async () => {
    // operations.md promises that a rejected client request is logged at warn,
    // never error, so that error stays meaningful for alerting. Nothing
    // asserted the split (Spec-020).
    const records: { level: string; fields: Record<string, unknown> }[] = [];
    const app = createDemoApplication({ logger: false });
    for (const level of ['warn', 'error'] as const) {
      const original = app.log[level].bind(app.log);
      Object.defineProperty(app.log, level, {
        configurable: true,
        value: (fields: Record<string, unknown>, message: string) => {
          if (typeof fields === 'object') records.push({ level, fields });
          return original(fields as never, message as never);
        },
      });
    }

    await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments?cursor=tampered`,
      headers: auth,
    });

    const rejection = records.find((record) => record.fields.event === 'http.request.rejected');
    expect(rejection?.level).toBe('warn');
    expect(rejection?.fields).toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
    expect(records.some((record) => record.level === 'error')).toBe(false);
    await app.close();
  });

  it('answers an oversized body as a client error, not a service failure', async () => {
    // The handler checked validation, then DomainValidationError, then
    // ServiceError, then fell through to INTERNAL_ERROR with a stack at error
    // level — for something the client did. Anyone with a valid account header
    // could raise a page-worthy signal at will (Spec-022).
    const records: { level: string; fields: Record<string, unknown> }[] = [];
    const app = createDemoApplication({ logger: false });
    captureLogs(app, records);
    const { body } = await listComments(app);
    const commentId = body.data[0]?.id ?? '';

    const response = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: { ...auth, 'idempotency-key': 'oversized-1' },
      payload: { body: 'x'.repeat(200_000) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', reason: 'request_body_too_large' },
    });
    expect(records.some((record) => record.level === 'error')).toBe(false);
    expect(records.find((record) => record.fields.event === 'http.request.rejected')?.level).toBe(
      'warn',
    );
    await app.close();
  });

  it('answers malformed JSON as a client error, not a service failure', async () => {
    const records: { level: string; fields: Record<string, unknown> }[] = [];
    const app = createDemoApplication({ logger: false });
    captureLogs(app, records);

    const response = await app.inject({
      method: 'POST',
      url: `/v2/comments/${crypto.randomUUID()}/replies`,
      headers: { ...auth, 'idempotency-key': 'malformed-1', 'content-type': 'application/json' },
      payload: '{"body": ',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', reason: 'request_body_malformed' },
    });
    expect(records.some((record) => record.level === 'error')).toBe(false);
    await app.close();
  });

  it('reports a malformed stored comment as 500, never as the caller mistake', async () => {
    // The specific mistake Spec-025 exists to avoid. `validateComment` throws a
    // DomainValidationError, which this handler maps to a 400 — so wiring the
    // guard in without a distinct type would have told the caller its request
    // was invalid while the fault is in this service's data.
    const records: { level: string; fields: Record<string, unknown> }[] = [];
    const comments = new InMemoryCommentRepository([], demoAccountId);
    // A stored observation the domain model does not accept. The in-memory
    // adapter does not validate on write, so this is the shape a mapper defect
    // or a corrupt row would produce on read.
    await comments
      .upsertMany({ accountId: demoAccountId }, [
        {
          postId: demoPost.id,
          platform: 'instagram',
          author: { id: 'author-1', displayName: 'Ada Lovelace' },
          body: '   ',
          publishedAt: '2026-08-01T10:00:00.000Z',
          updatedAt: '2026-08-01T10:00:00.000Z',
          externalId: 'ig-broken-1',
          externalParentCommentId: null,
        },
      ])
      .catch(() => undefined);

    const app = createApplication({
      logger: false,
      posts: new InMemoryPostRepository([demoPost]),
      comments,
      providers: new Map([
        [
          'instagram' as const,
          new AdaptiveProviderAdapter(
            'instagram',
            {
              listComments: async () => ({ items: [], nextCursor: null, hasMore: false }),
              replyToComment: async () => {
                throw new Error('not used');
              },
            },
            new Set(['list_comments']),
            providerPolicies({ ...providerRetryPolicy, maxAttempts: 1 }),
          ),
        ],
      ]),
    });
    captureLogs(app, records);

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments`,
      headers: auth,
    });

    expect(response.statusCode).toBe(500);
    expect(response.statusCode).not.toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', reason: 'stored_record_invalid' },
    });

    // A service fault is an error-level record, and it names the row without
    // carrying its content (ADR-0011).
    const failure = records.find((record) => record.level === 'error');
    expect(failure).toBeDefined();
    expect(failure?.fields).toMatchObject({ code: 'INTERNAL_ERROR', recordKind: 'comment' });
    expect(JSON.stringify(records)).not.toContain('Ada Lovelace');
    await app.close();
  });

  it('answers an unknown route in the documented envelope', async () => {
    // Fastify's default 404 has its own shape and names the framework.
    const app = createDemoApplication({ logger: false });

    const response = await app.inject({ method: 'GET', url: '/v2/nope', headers: auth });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'ROUTE_NOT_FOUND',
        reason: 'route_not_found',
        message: expect.any(String),
        requestId: expect.any(String),
      },
    });
    await app.close();
  });

  it('ignores a caller-supplied request identifier', async () => {
    // It flowed unbounded into every log record and every error body, so the
    // identifier an operator correlates by was attacker-chosen: two unrelated
    // requests could be given one id.
    const forged = 'f'.repeat(229);
    const app = createDemoApplication({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments`,
      headers: { 'x-request-id': forged },
    });

    const requestId = response.json().error.requestId as string;
    expect(requestId).not.toBe(forged);
    expect(requestId).not.toContain('ffff');
    expect(requestId.length).toBeLessThan(64);
    await app.close();
  });

  it('gives two requests two different identifiers even when told otherwise', async () => {
    const app = createDemoApplication({ logger: false });
    const forged = { 'x-request-id': 'the-same-id-for-both' };

    const first = await app.inject({ method: 'GET', url: '/v2/nope', headers: forged });
    const second = await app.inject({ method: 'GET', url: '/v2/nope', headers: forged });

    expect(first.json().error.requestId).not.toBe(second.json().error.requestId);
    await app.close();
  });

  it('rejects a reply body carrying a NUL before the provider is contacted', async () => {
    // JSON permits a NUL that PostgreSQL text does not, and the reply reaches
    // the provider before the insert. Without the schema guard this published
    // real content and then orphaned it — raising the one log record the
    // operations guide says always warrants a human, on demand (Spec-022).
    const records: { level: string; fields: Record<string, unknown> }[] = [];
    const app = createDemoApplication({ logger: false });
    captureLogs(app, records);
    const { body } = await listComments(app);
    const commentId = body.data[0]?.id ?? '';

    const response = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: { ...auth, 'idempotency-key': 'nul-1' },
      payload: { body: `CANARY-BODY-${String.fromCharCode(0)}-NUL` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', reason: 'request_validation_failed' },
    });
    // The refusal happened at the edge: nothing was published, nothing orphaned.
    expect(records.some((r) => r.fields.event === 'comments.reply.orphaned')).toBe(false);
    expect(records.some((r) => r.level === 'error')).toBe(false);

    // And an ordinary multi-line body still passes.
    const fine = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: { ...auth, 'idempotency-key': 'nul-2' },
      payload: { body: 'line one\nline two\ttabbed' },
    });
    expect(fine.statusCode).toBe(201);
    await app.close();
  });

  it('bounds the idempotency key at the edge, not at the btree', async () => {
    // Unbounded, an incompressible 4000-character key overflowed the unique
    // index row and surfaced as a 500; a compressible one was stored with no
    // ceiling (Spec-022).
    const app = createDemoApplication({ logger: false });
    const { body } = await listComments(app);
    const commentId = body.data[0]?.id ?? '';

    const atLimit = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: { ...auth, 'idempotency-key': 'k'.repeat(255) },
      payload: { body: 'Thanks!' },
    });
    const overLimit = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: { ...auth, 'idempotency-key': 'k'.repeat(256) },
      payload: { body: 'Thanks!' },
    });

    expect(atLimit.statusCode).toBe(201);
    expect(overLimit.statusCode).toBe(400);
    expect(overLimit.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', reason: 'request_validation_failed' },
    });
    await app.close();
  });

  it('enforces the documented input bounds, not merely declares them', async () => {
    // Removing these bounds from the schema failed only the OpenAPI golden
    // file — which the documented fix regenerates. A golden compare detects
    // that a declaration changed, never that it is enforced (Spec-020).
    const app = createDemoApplication({ logger: false });
    const { body } = await listComments(app);
    const commentId = body.data[0]?.id ?? '';

    const overLimit = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments?limit=101`,
      headers: auth,
    });
    const overLongBody = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: { ...auth, 'idempotency-key': 'long-1' },
      payload: { body: 'x'.repeat(10_001) },
    });

    expect(overLimit.statusCode).toBe(400);
    expect(overLongBody.statusCode).toBe(400);
    await app.close();
  });

  it('returns a cursor exactly when there is more to read', async () => {
    const app = createDemoApplication({ logger: false });

    const partial = await listComments(app, 'limit=2');
    const complete = await listComments(app, 'limit=50');

    expect(partial.body.pagination.hasMore).toBe(true);
    expect(partial.body.pagination.nextCursor).toEqual(expect.any(String));
    expect(complete.body.pagination.hasMore).toBe(false);
    expect(complete.body.pagination.nextCursor).toBeNull();
    await app.close();
  });

  it('publishes a reply once and replays it for an idempotent retry', async () => {
    const app = createDemoApplication({ logger: false });
    const { body } = await listComments(app);
    const commentId = body.data[0]?.id ?? '';
    const request = {
      method: 'POST' as const,
      url: `/v2/comments/${commentId}/replies`,
      headers: { ...auth, 'idempotency-key': 'request-1' },
      payload: { body: 'Thanks!' },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(first.json().data).toMatchObject({ parentCommentId: commentId, body: 'Thanks!' });
    await app.close();
  });

  it('conflicts when an idempotency key is reused for a different reply', async () => {
    const app = createDemoApplication({ logger: false });
    const { body } = await listComments(app);
    const commentId = body.data[0]?.id ?? '';
    const headers = { ...auth, 'idempotency-key': 'request-1' };

    await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers,
      payload: { body: 'Thanks!' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers,
      payload: { body: 'A different reply' },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    await app.close();
  });

  it('answers the health probe without an account context', async () => {
    const app = createDemoApplication({ logger: false });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
