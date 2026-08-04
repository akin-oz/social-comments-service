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
import { noopMetrics, type Metrics } from './shared/observability.js';
import type { Platform, PublishedPost } from './shared/types.js';

export interface ApplicationDependencies {
  comments?: CommentRepository;
  posts?: PostRepository;
  operations?: ReplyOperationRepository;
  providers?: ReadonlyMap<Platform, AdaptiveProvider>;
  metrics?: Metrics;
  logger?: boolean;
}

export function createApplication(dependencies: ApplicationDependencies = {}): FastifyInstance {
  const comments = dependencies.comments ?? new InMemoryCommentRepository();
  const posts = dependencies.posts ?? new InMemoryPostRepository();
  const operations = dependencies.operations ?? new InMemoryReplyOperationRepository();
  const providers = new InMemoryPlatformProviderRegistry(
    dependencies.providers ?? new Map<Platform, AdaptiveProvider>(),
  );
  const service = new CommentService(
    comments,
    posts,
    operations,
    providers,
    dependencies.metrics ?? noopMetrics,
  );
  const app = Fastify({
    logger: dependencies.logger ?? true,
    requestIdHeader: 'x-request-id',
  });
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
  const provider = new AdaptiveProviderAdapter(
    demoPost.platform,
    client,
    new Set(['list_comments', 'reply_to_comment']),
  );
  return createApplication({
    posts: new InMemoryPostRepository([demoPost]),
    comments: new InMemoryCommentRepository([], demoAccountId),
    providers: new Map([[demoPost.platform, provider]]),
    ...overrides,
  });
}
