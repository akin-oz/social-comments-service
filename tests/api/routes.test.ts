import { describe, expect, it } from 'vitest';

import { createDemoApplication, demoAccountId, demoPost } from '../../src/index.js';

const auth = { 'x-account-id': demoAccountId };

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
