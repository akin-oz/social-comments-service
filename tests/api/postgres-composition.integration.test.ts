import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresApplication } from '../../src/index.js';
import { seedTenants } from '../../src/seed-data.js';
import type { Database } from '../../src/repositories/database.js';

/**
 * Drives the wired composition — routes, service, PostgreSQL repositories —
 * against a real database.
 *
 * The repository-level integration tests call the three repositories directly,
 * so everything the service does between them was unexercised: fingerprint
 * comparison, cursor round-trip, error mapping over real rows. All three
 * defects found when PostgreSQL first ran for real lived in exactly that gap,
 * and each of them would fail this test.
 */
const appUrl = process.env.APP_DATABASE_URL;
const enabled = appUrl !== undefined;

const tenantA = seedTenants[0]!;
const tenantB = seedTenants[1]!;

describe.skipIf(!enabled)('PostgreSQL composition through the API', () => {
  let application: ReturnType<typeof createPostgresApplication>['application'];
  let database: Database;

  beforeAll(async () => {
    const composed = createPostgresApplication(appUrl!, { logger: false, apiDocs: false });
    application = composed.application;
    database = composed.database;
    await application.ready();
  });

  afterAll(async () => {
    await application?.close();
    await database?.close();
  });

  async function list(accountId: string, postId: string, query = 'limit=10') {
    return application.inject({
      method: 'GET',
      url: `/v2/posts/${postId}/comments?${query}`,
      headers: { 'x-account-id': accountId },
    });
  }

  it('hydrates from the provider and stores through the real repositories', async () => {
    const response = await list(tenantA.accountId, tenantA.postId);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toMatchObject({ postId: tenantA.postId, platform: tenantA.platform });
  });

  it('round-trips its own cursor against real rows', async () => {
    const first = await list(tenantA.accountId, tenantA.postId, 'limit=1');
    const cursor = first.json().pagination.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const second = await list(
      tenantA.accountId,
      tenantA.postId,
      `limit=1&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(second.statusCode).toBe(200);
    expect(second.json().data[0]?.id).not.toBe(first.json().data[0]?.id);
  });

  it('replays an idempotent retry instead of publishing twice', async () => {
    const listed = await list(tenantA.accountId, tenantA.postId);
    const commentId = listed.json().data[0].id;
    const key = `composition-${crypto.randomUUID()}`;
    const request = {
      method: 'POST' as const,
      url: `/v2/comments/${commentId}/replies`,
      headers: { 'x-account-id': tenantA.accountId, 'idempotency-key': key },
      payload: { body: 'Thank you!' },
    };

    const first = await application.inject(request);
    const second = await application.inject(request);

    expect(first.statusCode).toBe(201);
    // The fingerprint is read back from PostgreSQL here. Casting the row rather
    // than mapping it made every field undefined, so this comparison failed and
    // every retry was rejected as a different request.
    expect(second.statusCode).toBe(201);
    expect(second.json().data.id).toBe(first.json().data.id);
  });

  it('rejects the same key used for a different body', async () => {
    const listed = await list(tenantA.accountId, tenantA.postId);
    const commentId = listed.json().data[0].id;
    const headers = {
      'x-account-id': tenantA.accountId,
      'idempotency-key': `composition-${crypto.randomUUID()}`,
    };

    await application.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers,
      payload: { body: 'Thank you!' },
    });
    const conflict = await application.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers,
      payload: { body: 'A different reply' },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('refuses one tenant the other tenant post, over HTTP', async () => {
    // The demo composition has a single tenant, so this case could not be
    // expressed against it at all.
    const response = await list(tenantB.accountId, tenantA.postId);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'POST_NOT_FOUND' } });
  });

  it('treats a malformed identifier as absent rather than failing the cast', async () => {
    // Against PostgreSQL this reached a ::uuid cast and produced a 500 with an
    // error-level log per request.
    const response = await application.inject({
      method: 'GET',
      url: '/v2/posts/not-a-uuid/comments',
      headers: { 'x-account-id': tenantA.accountId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'POST_NOT_FOUND' } });
  });

  it('does not store the reply body in the audit trail', async () => {
    const listed = await list(tenantA.accountId, tenantA.postId);
    const commentId = listed.json().data[0].id;
    const secret = `sensitive-${crypto.randomUUID()}`;

    await application.inject({
      method: 'POST',
      url: `/v2/comments/${commentId}/replies`,
      headers: {
        'x-account-id': tenantA.accountId,
        'idempotency-key': `audit-${crypto.randomUUID()}`,
      },
      payload: { body: secret },
    });

    const stored = await database.withTenant(tenantA.accountId, (tx) =>
      tx.query<{ count: string }>(
        `select count(*)::text as count from reply_operations where request_fingerprint like $1`,
        [`%${secret}%`],
      ),
    );
    expect(stored.rows[0]!.count).toBe('0');
  });

  it('maps a forged cursor to the documented client error', async () => {
    const response = await list(tenantA.accountId, tenantA.postId, 'cursor=tampered');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  });
});
