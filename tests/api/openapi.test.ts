import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  createApplication,
  createDemoApplication,
  demoAccountId,
  demoPost,
} from '../../src/index.js';
import { AdaptiveProviderAdapter } from '../../src/platforms/adaptive-provider.js';
import { FixtureProviderClient } from '../../src/platforms/fixture-provider.js';
import {
  InMemoryCommentRepository,
  InMemoryPostRepository,
} from '../../src/repositories/in-memory.js';
import { serviceErrorReasons } from '../../src/shared/errors.js';

interface OpenApiDocument {
  openapi: string;
  paths: Record<
    string,
    Record<string, { operationId?: string; responses: Record<string, unknown> }>
  >;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
}

async function fetchDocument(): Promise<{ document: OpenApiDocument; close: () => Promise<void> }> {
  const app = createDemoApplication({ logger: false, apiDocs: true });
  const response = await app.inject({ method: 'GET', url: '/openapi.json' });
  expect(response.statusCode).toBe(200);
  return { document: response.json() as OpenApiDocument, close: () => app.close() };
}

describe('OpenAPI document', () => {
  it('describes both documented operations', async () => {
    const { document, close } = await fetchDocument();

    expect(document.openapi).toMatch(/^3\.1/);
    expect(document.paths['/v2/posts/{postId}/comments']?.get?.operationId).toBe('listComments');
    expect(document.paths['/v2/comments/{commentId}/replies']?.post?.operationId).toBe(
      'replyToComment',
    );
    await close();
  });

  it('documents every failure status the API contract defines', async () => {
    const { document, close } = await fetchDocument();

    const list = Object.keys(document.paths['/v2/posts/{postId}/comments']?.get?.responses ?? {});
    const reply = Object.keys(
      document.paths['/v2/comments/{commentId}/replies']?.post?.responses ?? {},
    );

    expect(list).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '422', '429', '500', '502', '503']),
    );
    // Only the write path can conflict on an idempotency key.
    expect(reply).toEqual(expect.arrayContaining(['201', '409']));
    expect(list).not.toContain('409');
    await close();
  });

  it('names the tenant header as the security scheme', async () => {
    const { document, close } = await fetchDocument();

    expect(document.components.securitySchemes.accountContext).toMatchObject({
      type: 'apiKey',
      name: 'X-Account-Id',
      in: 'header',
    });
    await close();
  });

  it('publishes the shared schemas under readable component names', async () => {
    const { document, close } = await fetchDocument();

    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining(['Comment', 'Pagination', 'Error']),
    );
    await close();
  });

  it('declares every reason the service can emit', async () => {
    // Reasons live in one exported list that both the error type and the schema
    // derive from, so drift is a compile error rather than a runtime surprise.
    // This asserts the projection into the published document as well.
    const { document, close } = await fetchDocument();

    const error = document.components.schemas.Error as {
      properties: { error: { properties: { reason: { enum: string[] } } } };
    };

    expect(error.properties.error.properties.reason.enum).toEqual([...serviceErrorReasons]);
    await close();
  });

  it('publishes Retry-After on the rate-limited response', async () => {
    // Prose said so from the beginning; the document did not, so a generated
    // client could not see the header at all (Spec-017).
    const { document, close } = await fetchDocument();

    const rateLimited = document.paths['/v2/posts/{postId}/comments']?.get?.responses['429'] as {
      headers?: Record<string, unknown>;
    };

    expect(rateLimited.headers).toMatchObject({
      'retry-after': { schema: { type: 'string' } },
    });
    await close();
  });

  it('ties nextCursor to hasMore rather than leaving it to prose', async () => {
    const { document, close } = await fetchDocument();

    const pagination = document.components.schemas.Pagination as {
      oneOf: { properties: Record<string, unknown> }[];
    };

    // The generator renders `const: x` as `enum: [x]`; both say the same thing.
    expect(pagination.oneOf.map((branch) => branch.properties)).toEqual([
      { hasMore: { enum: [true] }, nextCursor: { type: 'string' } },
      { hasMore: { enum: [false] }, nextCursor: { type: 'null' } },
    ]);
    await close();
  });

  it('matches the document committed to the repository', async () => {
    const { document, close } = await fetchDocument();
    const committed = JSON.parse(await readFile('docs/openapi.json', 'utf8')) as OpenApiDocument;

    // Fails when a route schema changes without regenerating: run `pnpm openapi`.
    expect(document).toEqual(committed);
    await close();
  });
});

describe('documentation endpoints', () => {
  it('serves the UI without an account context', async () => {
    const app = createDemoApplication({ logger: false, apiDocs: true });

    const ui = await app.inject({ method: 'GET', url: '/documentation' });
    const json = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect([200, 302]).toContain(ui.statusCode);
    expect(json.statusCode).toBe(200);
    await app.close();
  });

  it('disappears entirely when documentation is disabled', async () => {
    const app = createDemoApplication({ logger: false, apiDocs: false });

    const ui = await app.inject({ method: 'GET', url: '/documentation' });
    const json = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(ui.statusCode).toBe(404);
    expect(json.statusCode).toBe(404);
    await app.close();
  });

  it('is off by default in production, and opts back in explicitly', async () => {
    // The container image sets NODE_ENV=production, so this rule decides
    // whether /documentation exists in Docker. It was untested until the
    // Compose stack answered 404 on a URL the README advertised.
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env.ENABLE_API_DOCS;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ENABLE_API_DOCS;
      const off = createDemoApplication({ logger: false });
      expect((await off.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
      await off.close();

      process.env.ENABLE_API_DOCS = 'true';
      const on = createDemoApplication({ logger: false });
      expect((await on.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
      await on.close();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousFlag === undefined) delete process.env.ENABLE_API_DOCS;
      else process.env.ENABLE_API_DOCS = previousFlag;
    }
  });

  it('treats every plausible off spelling of ENABLE_API_DOCS as off in production', async () => {
    // An off switch with one accepted spelling is a misconfiguration that
    // reads as correct: ENABLE_API_DOCS=0 used to publish the schema in
    // production, the opposite of the intent (Spec-022).
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env.ENABLE_API_DOCS;
    try {
      process.env.NODE_ENV = 'production';
      for (const off of ['false', '0', 'no', 'off', '', 'FALSE', ' 0 ']) {
        process.env.ENABLE_API_DOCS = off;
        const app = createDemoApplication({ logger: false });
        expect(
          (await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode,
          `ENABLE_API_DOCS=${JSON.stringify(off)} must disable docs`,
        ).toBe(404);
        await app.close();
      }
      // And a genuine enable still enables.
      process.env.ENABLE_API_DOCS = 'true';
      const on = createDemoApplication({ logger: false });
      expect((await on.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
      await on.close();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousFlag === undefined) delete process.env.ENABLE_API_DOCS;
      else process.env.ENABLE_API_DOCS = previousFlag;
    }
  });

  it('refuses an account context that cannot be a tenant identifier', async () => {
    // A malformed value reached a ::uuid cast and produced a 500 with an
    // error-level log, where the contract promises a client error.
    const app = createDemoApplication({ logger: false, apiDocs: false });

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments`,
      headers: { 'x-account-id': 'not-a-uuid' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('treats a malformed post identifier as absent, not as a failure', async () => {
    const app = createDemoApplication({ logger: false, apiDocs: false });

    const response = await app.inject({
      method: 'GET',
      url: '/v2/posts/not-a-uuid/comments',
      headers: { 'x-account-id': demoAccountId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'POST_NOT_FOUND' } });
    await app.close();
  });

  it('still requires an account context for the API itself', async () => {
    const app = createDemoApplication({ logger: false, apiDocs: true });

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments`,
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe('response serialization', () => {
  it('keeps optional author fields the schema declares', async () => {
    const client = new FixtureProviderClient({
      commentsByPost: new Map([
        [
          demoPost.externalPostId,
          [
            {
              externalId: 'ig-comment-profile',
              authorId: 'ig-author-1',
              authorName: 'Ada Lovelace',
              authorProfileUrl: 'https://example.test/ada',
              body: 'Hello',
              publishedAt: '2026-08-01T10:00:00.000Z',
              updatedAt: '2026-08-01T10:00:00.000Z',
            },
          ],
        ],
      ]),
    });
    const app = createApplication({
      logger: false,
      posts: new InMemoryPostRepository([demoPost]),
      comments: new InMemoryCommentRepository([], demoAccountId),
      providers: (logger) =>
        new Map([
          [
            demoPost.platform,
            new AdaptiveProviderAdapter(
              demoPost.platform,
              client,
              new Set(['list_comments']),
              undefined,
              logger,
            ),
          ],
        ]),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v2/posts/${demoPost.id}/comments`,
      headers: { 'x-account-id': demoAccountId },
    });

    // Serialization is now schema-driven, so an undeclared field would vanish.
    expect(response.json().data[0].author).toEqual({
      id: 'ig-author-1',
      displayName: 'Ada Lovelace',
      profileUrl: 'https://example.test/ada',
    });
    await app.close();
  });
});
