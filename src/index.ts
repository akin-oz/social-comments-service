import Fastify, { type FastifyInstance } from 'fastify';

import { registerCommentRoutes } from './api/routes.js';
import { CommentService } from './comments/comment-service.js';
import { InMemoryPlatformProviderRegistry } from './platforms/provider-registry.js';
import {
  InMemoryCommentRepository,
  InMemoryPostRepository,
  InMemoryReplyOperationRepository,
} from './repositories/in-memory.js';
import type { AdaptiveProvider } from './comments/contracts.js';
import type { Comment, PublishedPost } from './shared/types.js';
import type { Platform } from './shared/types.js';

export interface ApplicationDependencies {
  comments?: InMemoryCommentRepository;
  posts?: InMemoryPostRepository;
  operations?: InMemoryReplyOperationRepository;
  providers?: ReadonlyMap<Platform, AdaptiveProvider>;
}

export function createApplication(dependencies: ApplicationDependencies = {}): FastifyInstance {
  const comments = dependencies.comments ?? new InMemoryCommentRepository();
  const posts = dependencies.posts ?? new InMemoryPostRepository();
  const operations = dependencies.operations ?? new InMemoryReplyOperationRepository();
  const providers = new InMemoryPlatformProviderRegistry(
    dependencies.providers ?? new Map<Platform, AdaptiveProvider>(),
  );
  const service = new CommentService(comments, posts, operations, providers);
  const app = Fastify({ logger: true, requestIdHeader: 'x-request-id' });
  registerCommentRoutes(app, service);
  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

export function createDemoApplication(seed: {
  comments: readonly Comment[];
  posts: readonly PublishedPost[];
}): FastifyInstance {
  return createApplication({
    comments: new InMemoryCommentRepository(seed.comments),
    posts: new InMemoryPostRepository(seed.posts),
  });
}
