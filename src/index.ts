import Fastify, { type FastifyInstance } from 'fastify';

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

  registerCommentRoutes(app, service);
  app.get('/health', async () => ({ status: 'ok' }));
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

/**
 * Composition used by `pnpm dev`. The comment cache starts empty so the first
 * request exercises provider-backed hydration rather than seeded data.
 */
export function createDemoApplication(
  overrides: Pick<ApplicationDependencies, 'logger'> = {},
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
