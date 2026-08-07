import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { registerCommentRoutes } from './api/routes.js';
import { CommentService, developmentFingerprintSecret } from './comments/comment-service.js';
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
   * Keys the idempotency fingerprint (Spec-023). Defaults to the development
   * key; `chooseComposition` refuses to start production without a real one.
   */
  fingerprintSecret?: string;
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
  const raw = process.env.ENABLE_API_DOCS;
  if (raw !== undefined) {
    // An off switch with exactly one accepted spelling is a misconfiguration
    // that reads as correct: ENABLE_API_DOCS=0 used to publish the
    // documentation in production (Spec-022).
    return !['false', '0', 'no', 'off', ''].includes(raw.trim().toLowerCase());
  }
  return process.env.NODE_ENV !== 'production';
}

/**
 * How long a request may run before Fastify abandons it.
 *
 * Exported because the reply lease has to outlast it: a lease that expires
 * while the request holding it is still running lets a second request take the
 * claim over and publish a duplicate reply. That invariant used to rest on this
 * number being hand-copied into a test, where nothing noticed if the two drifted
 * apart (Spec-020).
 */
export const REQUEST_TIMEOUT_MS = 30_000;

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
    // The request identifier is generated here, not read from a header.
    // Fastify's `requestIdHeader` honoured `x-request-id` verbatim, so an
    // unbounded caller-supplied string flowed into every log record and every
    // error body — a 229-character value was accepted, and two unrelated
    // requests could be given one id. The correlation identifier an operator
    // reconstructs a request by must not be attacker-chosen (Spec-022).
    // Cross-system correlation belongs to the gateway, which can do it without
    // handing the choice to the caller.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // A request that outlives this is one the client has already abandoned.
    requestTimeout: REQUEST_TIMEOUT_MS,
    // The largest documented body is a 10,000-character reply. Fastify's
    // default is 1 MB, a hundredfold of parse work the contract never wanted.
    bodyLimit: 64 * 1024,
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
    dependencies.fingerprintSecret ?? developmentFingerprintSecret,
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

  // Fastify's default 404 has its own body shape and names the framework, so a
  // client handling `error.code` uniformly met one response without one.
  app.setNotFoundHandler((request, reply) => {
    request.log.warn(
      { event: 'http.request.rejected', code: 'ROUTE_NOT_FOUND', statusCode: 404 },
      'request rejected',
    );
    return reply.code(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        reason: 'route_not_found',
        message: 'No route matches this method and path.',
        requestId: request.id,
      },
    });
  });

  return app;
}

/**
 * Which composition an environment selects, or why it may not start.
 *
 * Extracted from the entry point so the fail-closed rule below is reachable by
 * a test. It was inline in `server.ts`, which no test imports and no CI step
 * runs, so the guard could be deleted with the suite green — the one control
 * whose whole job is to prevent a silent production downgrade.
 */
export type CompositionChoice =
  | { kind: 'postgres'; databaseUrl: string; fingerprintSecret: string }
  | { kind: 'demo'; fingerprintSecret: string }
  | { kind: 'refuse'; reason: string };

export function chooseComposition(env: NodeJS.ProcessEnv): CompositionChoice {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL;
  const configuredSecret = env.IDEMPOTENCY_FINGERPRINT_SECRET;

  // Falling back to the demo composition in production would start a service
  // that passes its health check, accepts any account, and has no row-level
  // security behind it. A missing or misspelled DATABASE_URL must stop the
  // process, not silently downgrade it.
  if (production && (databaseUrl === undefined || databaseUrl === '')) {
    return {
      kind: 'refuse',
      reason:
        'DATABASE_URL is required when NODE_ENV=production: refusing to start the in-memory composition.',
    };
  }
  // Same shape, same reason (Spec-023). Falling back to the development key in
  // production would leave a deployment believing its stored fingerprints were
  // unguessable when they are computed from a constant in this repository.
  if (production && (configuredSecret === undefined || configuredSecret === '')) {
    return {
      kind: 'refuse',
      reason:
        'IDEMPOTENCY_FINGERPRINT_SECRET is required when NODE_ENV=production: refusing to start with the development key.',
    };
  }

  const fingerprintSecret = configuredSecret ?? developmentFingerprintSecret;
  if (databaseUrl !== undefined && databaseUrl !== '') {
    return { kind: 'postgres', databaseUrl, fingerprintSecret };
  }
  return { kind: 'demo', fingerprintSecret };
}

/** Identifiers used by the runnable demo composition and the README examples. */
export const demoAccountId = '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001';
export const demoPost: PublishedPost = {
  id: '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b002',
  accountId: demoAccountId,
  platform: 'instagram',
  externalPostId: 'ig-post-1',
  publishedAt: '2026-08-01T09:00:00.000Z',
  connection: {
    socialAccountId: '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b011',
    platform: 'instagram',
    // A pointer to a secret held by platform infrastructure, never the secret
    // itself (A-002).
    credentialReference: 'secret://social/instagram/tenant-a',
  },
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

/** A second platform in the runnable composition, not only in the matrix. */
const youtubeExternalComments: readonly ExternalCommentRecord[] = [
  {
    externalId: 'yt-comment-1',
    authorId: 'yt-author-1',
    authorName: 'Margaret Hamilton',
    body: 'Great walkthrough — what version is this?',
    publishedAt: '2026-08-01T10:45:00.000Z',
    updatedAt: '2026-08-01T10:45:00.000Z',
  },
  {
    externalId: 'yt-comment-2',
    authorId: 'yt-author-2',
    authorName: 'Annie Easley',
    body: 'Subscribed.',
    publishedAt: '2026-08-01T11:45:00.000Z',
    updatedAt: '2026-08-01T11:45:00.000Z',
  },
];

/**
 * Fixture comments per provider post.
 *
 * Each post has distinct external identifiers because deduplication keys on
 * `(social_account_id, external_comment_id)` (ADR-0013). Reusing one set across
 * two posts under one social account would fold two comments into one row,
 * which globally unique provider identifiers prevent in reality.
 */
const fixtureCommentsByPost = new Map<string, readonly ExternalCommentRecord[]>([
  ['ig-post-1', demoExternalComments],
  ['ig-post-2', secondTenantExternalComments],
  ['yt-video-1', youtubeExternalComments],
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
  overrides: Pick<ApplicationDependencies, 'logger' | 'apiDocs' | 'fingerprintSecret'> = {},
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
  overrides: Pick<
    ApplicationDependencies,
    'logger' | 'apiDocs' | 'metrics' | 'fingerprintSecret'
  > = {},
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
