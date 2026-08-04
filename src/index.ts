import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { registerCommentRoutes } from './api/routes.js';
import { CommentService } from './comments/comment-service.js';
import { InMemoryPlatformProviderRegistry } from './platforms/provider-registry.js';
import {
  AdaptiveProviderAdapter,
  type ExternalCommentRecord,
} from './platforms/adaptive-provider.js';
import { FixtureProviderClient } from './platforms/fixture-provider.js';
import {
  InMemoryCommentRepository,
  InMemoryPostRepository,
  InMemoryReplyOperationRepository,
} from './repositories/in-memory.js';
import {
  PostgresCommentRepository,
  PostgresPostRepository,
  PostgresReplyOperationRepository,
} from './repositories/postgres.js';
import { PostgresDatabase, type Database } from './repositories/database.js';
import { seedTenants } from './seed-data.js';
import type {
  AdaptiveProvider,
  CommentRepository,
  PostRepository,
  ReplyOperationRepository,
} from './comments/contracts.js';
import { loggingMetrics, type Logger, type Metrics } from './shared/observability.js';
import type { Platform, PublishedPost } from './shared/types.js';

/** Minimal shape of the Fastify logger this composition adapts. */
interface StructuredLogSink {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * Adapts the runtime logger to the {@link Logger} port so application code
 * never imports a logging library (ADR-0011). The `event` name is promoted to
 * a field because consumers match on it.
 */
export function toLoggerPort(sink: StructuredLogSink): Logger {
  return {
    debug: (event, fields) => sink.debug({ event, ...fields }, event),
    info: (event, fields) => sink.info({ event, ...fields }, event),
    warn: (event, fields) => sink.warn({ event, ...fields }, event),
    error: (event, fields) => sink.error({ event, ...fields }, event),
  };
}

export interface ApplicationDependencies {
  comments?: CommentRepository;
  posts?: PostRepository;
  operations?: ReplyOperationRepository;
  /**
   * Either a ready registry, or a factory that receives the application logger
   * so provider adapters can report retries and backoff.
   */
  providers?:
    | ReadonlyMap<Platform, AdaptiveProvider>
    | ((logger: Logger) => ReadonlyMap<Platform, AdaptiveProvider>);
  metrics?: Metrics;
  logger?: boolean;
  /**
   * Serves the OpenAPI document and Swagger UI. Defaults to enabled outside
   * production: a service behind an internal gateway has no reason to publish
   * its own schema (Spec-011).
   */
  apiDocs?: boolean;
}

/** The OpenAPI description shared by the served document and the generated file. */
export const openApiDocument = {
  // Name components after their schema $id instead of the positional default.
  refResolver: {
    buildLocalReference: (json: { $id?: string }, _base: unknown, _fragment: unknown, i: number) =>
      json.$id ?? `def-${i}`,
  },
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'Blotato Comments API',
      description:
        'Retrieve comments for a published post and reply to a comment, across multiple social platforms.',
      version: '2.0.0',
    },
    tags: [{ name: 'comments', description: 'Comment retrieval and replies' }],
    components: {
      securitySchemes: {
        accountContext: {
          type: 'apiKey' as const,
          name: 'X-Account-Id',
          in: 'header' as const,
          description:
            'Tenant context supplied by the platform gateway that already authenticated the caller (assumption A-001).',
        },
      },
    },
    security: [{ accountContext: [] }],
  },
};

function apiDocsEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  if (process.env.ENABLE_API_DOCS !== undefined) return process.env.ENABLE_API_DOCS !== 'false';
  return process.env.NODE_ENV !== 'production';
}

export function createApplication(dependencies: ApplicationDependencies = {}): FastifyInstance {
  const app = Fastify({
    logger:
      dependencies.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            // Drop the client address and port: behind an internal gateway they
            // identify the gateway, not the caller, and they are personal data.
            serializers: {
              req: (request: { method: string; url: string }) => ({
                method: request.method,
                url: request.url,
              }),
              res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
            },
          },
    requestIdHeader: 'x-request-id',
  });
  const logger = toLoggerPort(app.log);

  const comments = dependencies.comments ?? new InMemoryCommentRepository();
  const posts = dependencies.posts ?? new InMemoryPostRepository();
  const operations = dependencies.operations ?? new InMemoryReplyOperationRepository();
  const configured = dependencies.providers ?? new Map<Platform, AdaptiveProvider>();
  const providers = new InMemoryPlatformProviderRegistry(
    typeof configured === 'function' ? configured(logger) : configured,
  );
  const service = new CommentService(
    comments,
    posts,
    operations,
    providers,
    dependencies.metrics ?? loggingMetrics(logger),
    logger,
  );

  if (apiDocsEnabled(dependencies.apiDocs)) {
    void app.register(swagger, openApiDocument);
    void app.register(swaggerUi, { routePrefix: '/documentation' });
    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  }

  // Routes go in a plugin so they are registered after the documentation
  // plugins above; Fastify defers plugin bodies, and a route declared before
  // the swagger plugin loads is never captured in the document.
  void app.register(async (instance) => {
    registerCommentRoutes(instance, service);
  });

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  return app;
}

/** Identifiers used by the runnable demo composition and the README examples. */
export const demoAccountId = '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001';
export const demoPost: PublishedPost = {
  id: '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b002',
  accountId: demoAccountId,
  platform: 'instagram',
  externalPostId: 'ig-post-1',
  publishedAt: '2026-08-01T09:00:00.000Z',
};

const demoExternalComments: readonly ExternalCommentRecord[] = [
  {
    externalId: 'ig-comment-1',
    authorId: 'ig-author-1',
    authorName: 'Ada Lovelace',
    body: 'This is great!',
    publishedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  },
  {
    externalId: 'ig-comment-2',
    authorId: 'ig-author-2',
    authorName: 'Grace Hopper',
    body: 'Where can I read more?',
    publishedAt: '2026-08-01T11:00:00.000Z',
    updatedAt: '2026-08-01T11:00:00.000Z',
  },
  {
    externalId: 'ig-comment-3',
    authorId: 'ig-author-3',
    authorName: 'Katherine Johnson',
    body: 'Shipping this today.',
    publishedAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
  },
];

const secondTenantExternalComments: readonly ExternalCommentRecord[] = [
  {
    externalId: 'ig-comment-11',
    authorId: 'ig-author-11',
    authorName: 'Radia Perlman',
    body: 'Does this ship on Android too?',
    publishedAt: '2026-08-01T10:15:00.000Z',
    updatedAt: '2026-08-01T10:15:00.000Z',
  },
  {
    externalId: 'ig-comment-12',
    authorId: 'ig-author-12',
    authorName: 'Barbara Liskov',
    body: 'Following for the release notes.',
    publishedAt: '2026-08-01T11:15:00.000Z',
    updatedAt: '2026-08-01T11:15:00.000Z',
  },
];

/**
 * Fixture comments per provider post.
 *
 * Each post has distinct external identifiers because ADR-0010 derives a
 * comment's internal identity from `(platform, externalId)`. Reusing one set
 * across two posts would derive one identity for two comments and collide on
 * the primary key, which is what a real provider's globally unique comment
 * identifiers prevent.
 */
const fixtureCommentsByPost = new Map<string, readonly ExternalCommentRecord[]>([
  ['ig-post-1', demoExternalComments],
  ['ig-post-2', secondTenantExternalComments],
]);

/**
 * Composition backed by PostgreSQL, selected when `DATABASE_URL` is set.
 *
 * Persistence is real; the provider is still the deterministic fixture, since
 * no live platform SDK is selected. Comments are not seeded, so the first read
 * of a seeded post exercises provider hydration and writes rows through the
 * tenant-scoped transaction boundary (ADR-0012).
 */
export function createPostgresApplication(
  connectionString: string,
  overrides: Pick<ApplicationDependencies, 'logger' | 'apiDocs'> = {},
): { application: FastifyInstance; database: Database } {
  const database = new PostgresDatabase(connectionString);
  const client = new FixtureProviderClient({
    commentsByPost: fixtureCommentsByPost,
    maxPageSize: 2,
  });

  const application = createApplication({
    comments: new PostgresCommentRepository(database),
    posts: new PostgresPostRepository(database),
    operations: new PostgresReplyOperationRepository(database),
    providers: (logger) =>
      new Map(
        seedTenants.map((tenant) => [
          tenant.platform,
          new AdaptiveProviderAdapter(
            tenant.platform,
            client,
            new Set(['list_comments', 'reply_to_comment']),
            undefined,
            logger,
          ),
        ]),
      ),
    ...overrides,
  });
  return { application, database };
}

/**
 * Composition used by `pnpm dev` without a database. The comment cache starts
 * empty so the first request exercises provider-backed hydration rather than
 * seeded data.
 */
export function createDemoApplication(
  overrides: Pick<ApplicationDependencies, 'logger' | 'apiDocs'> = {},
): FastifyInstance {
  const client = new FixtureProviderClient({
    commentsByPost: new Map([[demoPost.externalPostId, demoExternalComments]]),
    maxPageSize: 2,
  });
  return createApplication({
    posts: new InMemoryPostRepository([demoPost]),
    comments: new InMemoryCommentRepository([], demoAccountId),
    providers: (logger) =>
      new Map([
        [
          demoPost.platform,
          new AdaptiveProviderAdapter(
            demoPost.platform,
            client,
            new Set(['list_comments', 'reply_to_comment']),
            undefined,
            logger,
          ),
        ],
      ]),
    ...overrides,
  });
}
