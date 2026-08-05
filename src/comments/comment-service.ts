import { createHash } from 'node:crypto';

import {
  NotFoundError,
  ProviderCursorRejectedError,
  ReplyDepthExceededError,
  ReplyOutcomeUnknownError,
  ServiceError,
  toFailureCode,
} from '../shared/errors.js';
import { decodeCursor, encodeCursor } from '../shared/cursor.js';
import {
  validateListCommentsQuery,
  validatePagination,
  validateReplyToCommentCommand,
} from '../shared/validation.js';
import {
  noopLogger,
  noopMetrics,
  type LogFields,
  type Logger,
  type Metrics,
} from '../shared/observability.js';
import { requireCapability } from '../platforms/provider-registry.js';
import type { Comment, PageCursor, PublishedPost, RequestContext } from '../shared/types.js';
import type { ReplyOperation } from '../shared/types.js';
import type {
  CommentRepository,
  ListCommentsQuery,
  ListCommentsResult,
  PlatformProviderRegistry,
  PostRepository,
  PostSnapshotState,
  ReplyOperationRepository,
  ReplyToCommentCommand,
} from './contracts.js';

export interface ListCommentsRequest {
  limit: number;
  cursor?: PageCursor;
}

/**
 * Bounds how many provider calls one request may make. Completing a snapshot is
 * what makes pagination stable, but it must not become unbounded work inside a
 * single read: past the bound the caller is told there is more and the next
 * request continues (Spec-014).
 */
const MAX_HYDRATIONS_PER_REQUEST = 20;

/** Page size requested from a provider while completing a snapshot. */
const PROVIDER_PAGE_LIMIT = 100;

const DEFAULT_SNAPSHOT_LIFETIME_SECONDS = 300;

/**
 * How long a claimed idempotency key stays claimed (Spec-015).
 *
 * Comfortably longer than any request that can still be alive — the HTTP
 * request timeout is 30 seconds and the provider call budget is shorter still —
 * so a lease can only expire after the request holding it has finished or died.
 * Too short and a takeover races a live request; too long and a crashed process
 * blocks its key for that long.
 */
const REPLY_LEASE_MS = 120_000;

/**
 * Whether a provider failure proves the reply was never published.
 *
 * A rate limit is a refusal: the provider declined to process the request, so
 * nothing went out and the key can be cleanly failed. A timeout or an upstream
 * error proves only that no usable answer arrived, which is a different thing
 * and gets the different state. Treating silence as refusal is what invites a
 * duplicate publication under a customer's name.
 */
function provesRejection(code: string): boolean {
  return code === 'PROVIDER_RATE_LIMITED';
}

function snapshotLifetimeMs(): number {
  const configured = Number(process.env.SNAPSHOT_LIFETIME_SECONDS);
  const seconds =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SNAPSHOT_LIFETIME_SECONDS;
  return seconds * 1000;
}

/**
 * Binds an idempotency key to one request without storing the request. The
 * body is user content, and an audit row is the wrong place to keep it
 * (ADR-0011); a digest compares identically.
 *
 * Exported because it defines how a key binds to a request, which a test
 * constructing a realistic claim needs to reproduce rather than guess.
 */
export function requestFingerprint(commentId: string, body: string): string {
  return createHash('sha256').update(`${commentId}:${body}`, 'utf8').digest('hex');
}

const emptySnapshotState: PostSnapshotState = {
  providerCursor: null,
  exhausted: false,
  completedAt: null,
};

export class CommentService {
  public constructor(
    private readonly comments: CommentRepository,
    private readonly posts: PostRepository,
    private readonly operations: ReplyOperationRepository,
    private readonly providers: PlatformProviderRegistry,
    private readonly metrics: Metrics = noopMetrics,
    private readonly logger: Logger = noopLogger,
  ) {}

  /**
   * Serves comments from the local snapshot, hydrating from the provider when
   * the snapshot cannot answer the requested position (Spec-008).
   */
  public async listComments(
    context: RequestContext,
    postId: string,
    request: ListCommentsRequest,
  ): Promise<ListCommentsResult> {
    const found = await this.posts.findPublishedById(context, postId);
    if (!found) throw new NotFoundError('POST_NOT_FOUND', 'The requested post was not found.');
    const { post, snapshot } = found;

    const cursor = decodeCursor(request.cursor);
    const query: ListCommentsQuery = {
      postId,
      platform: post.platform,
      limit: request.limit,
      ...(cursor.after === null ? {} : { after: cursor.after }),
    };
    validateListCommentsQuery(query);

    const startedAt = Date.now();
    try {
      // A snapshot completed long enough ago is read again from the start:
      // exhaustion without a lifetime hides every comment published since.
      let state = this.stale(snapshot) ? emptySnapshotState : snapshot;
      let page = await this.comments.listByPost(context, query);
      let hydrations = 0;

      // A pagination run must read a snapshot that does not move underneath it.
      // Provider order is not the service's order — Meta, X, and YouTube return
      // newest first, so later provider pages land behind an ascending keyset
      // and become unreachable for the rest of the run. Starting a run
      // therefore completes the snapshot first; continuing one only tops it up
      // when the page is short (Spec-014).
      const startingRun = cursor.after === null;
      while (
        !state.exhausted &&
        hydrations < MAX_HYDRATIONS_PER_REQUEST &&
        (startingRun || page.items.length < request.limit)
      ) {
        state = await this.hydrate(context, post, state);
        await this.posts.saveSnapshotState(context, postId, state);
        page = await this.comments.listByPost(context, query);
        hydrations += 1;
      }

      const last = page.items[page.items.length - 1];
      // Completeness decides this, not whether this page happened to fill.
      const hasMore = page.hasMore || !state.exhausted;
      const pagination = {
        hasMore,
        nextCursor: hasMore
          ? encodeCursor({
              // With nothing returned, the caller keeps its position and comes
              // back; each request advances the snapshot.
              after: last ? { publishedAt: last.publishedAt, id: last.id } : cursor.after,
            })
          : null,
      };
      validatePagination(pagination);

      const durationMs = Date.now() - startedAt;
      this.metrics.increment('comments.list.success', { platform: post.platform });
      this.metrics.observe('comments.list.duration_ms', durationMs, { platform: post.platform });
      this.logger.info(
        hydrations > 0 ? 'comments.list.hydrated' : 'comments.list.served_from_cache',
        {
          ...this.trace(context),
          postId,
          platform: post.platform,
          returned: page.items.length,
          hasMore,
          hydrations,
          durationMs,
        },
      );
      return {
        items: page.items,
        pagination,
        snapshot: { syncedAt: state.completedAt },
      };
    } catch (error) {
      const code = toFailureCode(error);
      this.metrics.increment('comments.list.failure', { platform: post.platform, code });
      this.logger.warn('comments.list.failed', {
        ...this.trace(context),
        postId,
        platform: post.platform,
        code,
      });
      throw error;
    }
  }

  public async replyToComment(
    context: RequestContext,
    commentId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Comment> {
    const command: ReplyToCommentCommand = { commentId, body, idempotencyKey };
    validateReplyToCommentCommand(command);
    const fingerprint = requestFingerprint(commentId, body);

    const previous = await this.operations.findByIdempotencyKey(context, idempotencyKey);
    if (previous) {
      const replayed = await this.replay(context, previous, fingerprint);
      if (replayed) {
        this.metrics.increment('comments.reply.replayed', { platform: replayed.platform });
        this.logger.info('comments.reply.replayed', {
          ...this.trace(context),
          commentId,
          replyId: replayed.id,
        });
        return replayed;
      }
    }

    const comment = await this.comments.findById(context, commentId);
    if (!comment) {
      // Counted here too: a dashboard that only sees post-claim failures
      // undercounts exactly the outage worth alerting on.
      this.metrics.increment('comments.reply.failure', { code: 'COMMENT_NOT_FOUND' });
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The requested comment was not found.');
    }
    // One level is a normalisation this service chose, not a platform rule
    // (ADR-0014): X and Facebook nest arbitrarily. The stored parent already
    // says whether it is itself a reply, so enforcing it costs no round trip.
    if (comment.parentCommentId !== null) {
      this.metrics.increment('comments.reply.failure', {
        platform: comment.platform,
        code: 'REPLY_DEPTH_EXCEEDED',
      });
      throw new ReplyDepthExceededError();
    }

    const postRecord = await this.posts.findPublishedById(context, comment.postId);
    if (!postRecord) {
      throw new NotFoundError('POST_NOT_FOUND', 'The post for this comment was not found.');
    }
    const post = postRecord.post;
    const parentExternalCommentId = await this.comments.resolveExternalId(context, commentId);
    if (parentExternalCommentId === null) {
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The requested comment was not found.');
    }

    const provider = this.providers.get(comment.platform);
    requireCapability(provider, 'reply_to_comment');

    const now = Date.now();
    const claim = await this.operations.claim(context, {
      id: crypto.randomUUID(),
      commentId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      status: 'pending',
      resultingCommentId: null,
      failureCode: null,
      leaseExpiresAt: new Date(now + REPLY_LEASE_MS).toISOString(),
      externalReplyId: null,
      createdAt: new Date(now).toISOString(),
      completedAt: null,
    });
    if (!claim.claimed) {
      const replayed = await this.replay(context, claim.operation, fingerprint);
      if (replayed) {
        this.metrics.increment('comments.reply.replayed', { platform: comment.platform });
        this.logger.info('comments.reply.replayed', {
          ...this.trace(context),
          commentId,
          replyId: replayed.id,
          reason: 'concurrent',
        });
        return replayed;
      }
      this.metrics.increment('comments.reply.duplicate_attempted', { platform: comment.platform });
      this.logger.warn('comments.reply.conflict', {
        ...this.trace(context),
        commentId,
        platform: comment.platform,
        reason: 'in_progress',
      });
      throw new ServiceError(
        'IDEMPOTENCY_CONFLICT',
        'A reply for this idempotency key is already in progress.',
        409,
      );
    }

    const startedAt = Date.now();

    // Only a provider failure may mark the operation failed. Everything after
    // this point has a published reply behind it, and recording that as failed
    // would tell the client to retry with a new key and publish a second reply
    // under someone else's name.
    let reply;
    try {
      reply = await provider.replyToComment({
        post,
        connection: post.connection,
        parentExternalCommentId,
        body,
      });
    } catch (error) {
      const failureCode = toFailureCode(error);
      // A refusal is failed and a silence is unknown. They ask the client for
      // different things, and before they were the same state (Spec-015).
      if (provesRejection(failureCode)) {
        await this.operations.fail(context, claim.operation.id, failureCode);
      } else {
        await this.operations.markUnknown(context, claim.operation.id, failureCode);
      }
      this.metrics.increment('comments.reply.failure', {
        platform: comment.platform,
        code: failureCode,
      });
      if (failureCode === 'PROVIDER_UNAVAILABLE') {
        this.metrics.increment('comments.reply.timeout', { platform: comment.platform });
      }
      if (failureCode === 'PROVIDER_RATE_LIMITED') {
        this.metrics.increment('comments.reply.rate_limited', { platform: comment.platform });
      }
      this.logger.warn('comments.reply.failed', {
        ...this.trace(context),
        commentId,
        platform: comment.platform,
        code: failureCode,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    // From here the reply exists at the provider. Record where, before doing
    // anything that can fail: this is the only thing that later distinguishes
    // "published and stored, completion lost" — which recovers — from
    // "published and gone", which does not.
    let stored;
    try {
      await this.operations.recordPublished(context, claim.operation.id, reply.externalId);
      [stored] = await this.comments.upsertMany(context, [reply]);
      if (!stored) {
        throw new ServiceError('INTERNAL_ERROR', 'The published reply could not be stored.', 500);
      }
    } catch (error) {
      // Nothing was stored. The outcome is not failed — a reply was published —
      // and not pending, because no later request can resolve it. It is
      // unknown, which is the state that says a human should look.
      await this.operations
        .markUnknown(context, claim.operation.id, 'REPLY_OUTCOME_UNKNOWN')
        .catch(() => undefined);
      this.metrics.increment('comments.reply.orphaned', { platform: comment.platform });
      this.logger.error('comments.reply.orphaned', {
        ...this.trace(context),
        commentId,
        platform: comment.platform,
        // The provider's own identifier, so an operator can find the reply that
        // exists without having to guess.
        externalReplyId: reply.externalId,
        code: toFailureCode(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    try {
      await this.operations.complete(context, claim.operation.id, stored.id);
    } catch (error) {
      // The reply is published and stored; only the record of that is missing.
      // The operation stays pending on purpose, because the next request for
      // this key can reconcile it from the stored reply.
      this.metrics.increment('comments.reply.unreconciled', { platform: comment.platform });
      this.logger.error('comments.reply.unreconciled', {
        ...this.trace(context),
        commentId,
        platform: comment.platform,
        replyId: stored.id,
        code: toFailureCode(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    this.metrics.increment('comments.reply.success', { platform: comment.platform });
    this.logger.info('comments.reply.published', {
      ...this.trace(context),
      commentId,
      replyId: stored.id,
      platform: comment.platform,
      // Length rather than content: reply bodies are user data (ADR-0011).
      bodyLength: body.length,
      durationMs: Date.now() - startedAt,
    });
    return stored;
  }

  /**
   * Reads the next provider page into the snapshot and reports how far the
   * stream has been consumed.
   *
   * A stored continuation is best-effort: vendors document that cursors must
   * not be stored, because one is invalidated when the item it points at is
   * deleted. A rejected cursor therefore restarts the stream rather than
   * failing the read, which is safe because re-reading deduplicates on
   * `(social_account_id, external_comment_id)` (Spec-014).
   */
  private async hydrate(
    context: RequestContext,
    post: PublishedPost,
    state: PostSnapshotState,
  ): Promise<PostSnapshotState> {
    const provider = this.providers.get(post.platform);
    requireCapability(provider, 'list_comments');
    const startedAt = Date.now();

    let page;
    try {
      page = await this.fetchPage(provider, post, state.providerCursor);
    } catch (error) {
      if (!(error instanceof ProviderCursorRejectedError)) throw error;
      this.metrics.increment('comments.list.cursor_rejected', { platform: post.platform });
      this.logger.warn('provider.cursor.rejected', {
        ...this.trace(context),
        platform: post.platform,
        postId: post.id,
      });
      page = await this.fetchPage(provider, post, null);
    }

    if (page.items.length > 0) await this.comments.upsertMany(context, page.items);
    this.metrics.increment('comments.list.hydrated', { platform: post.platform });
    this.logger.info('provider.list.completed', {
      ...this.trace(context),
      platform: post.platform,
      postId: post.id,
      fetched: page.items.length,
      hasMore: page.hasMore,
      durationMs: Date.now() - startedAt,
    });

    return page.hasMore
      ? { providerCursor: page.nextProviderCursor, exhausted: false, completedAt: null }
      : { providerCursor: null, exhausted: true, completedAt: new Date().toISOString() };
  }

  private async fetchPage(
    provider: ReturnType<PlatformProviderRegistry['get']>,
    post: PublishedPost,
    providerCursor: string | null,
  ) {
    return provider.listComments({
      post,
      connection: post.connection,
      limit: PROVIDER_PAGE_LIMIT,
      ...(providerCursor === null ? {} : { providerCursor }),
    });
  }

  /** True when a completed snapshot is old enough to be worth reading again. */
  private stale(state: PostSnapshotState): boolean {
    if (!state.exhausted || state.completedAt === null) return false;
    return Date.now() - Date.parse(state.completedAt) > snapshotLifetimeMs();
  }

  private trace(context: RequestContext): LogFields {
    return { requestId: context.requestId, accountId: context.accountId };
  }

  /**
   * Resolves a repeated idempotency key, recovering the operation where it can.
   *
   * A key is bound to one request body. A failed key is terminal because the
   * provider refused it; an unknown key is terminal because nobody knows what
   * the provider did. Returning null means the key is genuinely in flight and
   * the caller should be told so.
   */
  private async replay(
    context: RequestContext,
    operation: ReplyOperation,
    fingerprint: string,
  ): Promise<Comment | null> {
    if (operation.requestFingerprint !== fingerprint) {
      throw new ServiceError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was already used for a different request.',
        409,
      );
    }
    if (operation.status === 'completed' && operation.resultingCommentId !== null) {
      const stored = await this.comments.findById(context, operation.resultingCommentId);
      if (stored) return stored;
    }
    if (operation.status === 'failed') {
      throw new ServiceError(
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key already failed; retry with a new key.',
        409,
      );
    }
    if (operation.status === 'unknown') throw unknownOutcome();
    if (operation.status === 'pending') return this.recover(context, operation);
    return null;
  }

  /**
   * Decides what a pending operation actually is.
   *
   * Three cases hide behind `pending`. The reply was published and stored and
   * only the completion was lost, which self-heals here without touching the
   * provider. The lease has expired, so the process that held it is gone and
   * the outcome cannot be established — that becomes `unknown` rather than
   * being retried, because an expired lease does not prove the provider was
   * never reached. Or the work is genuinely in flight, which is the only case
   * that returns null.
   */
  private async recover(
    context: RequestContext,
    operation: ReplyOperation,
  ): Promise<Comment | null> {
    if (operation.externalReplyId !== null) {
      const stored = await this.comments.findByExternalId(context, operation.externalReplyId);
      if (stored) {
        await this.operations.complete(context, operation.id, stored.id);
        this.metrics.increment('comments.reply.reconciled');
        this.logger.info('comments.reply.reconciled', {
          ...this.trace(context),
          commentId: operation.commentId,
          replyId: stored.id,
        });
        return stored;
      }
    }

    // Checked only once the reply is known not to be stored: a live request may
    // be between its publish and its write, and resolving it from underneath
    // would be worse than making its caller wait.
    if (Date.parse(operation.leaseExpiresAt) > Date.now()) return null;

    await this.operations.markUnknown(context, operation.id, 'REPLY_OUTCOME_UNKNOWN');
    this.metrics.increment('comments.reply.lease_expired');
    this.logger.warn('comments.reply.lease_expired', {
      ...this.trace(context),
      commentId: operation.commentId,
      ...(operation.externalReplyId === null ? {} : { externalReplyId: operation.externalReplyId }),
    });
    throw unknownOutcome();
  }
}

function unknownOutcome(): ReplyOutcomeUnknownError {
  return new ReplyOutcomeUnknownError(
    'The outcome of this reply could not be established; a reply may have been published. Do not retry with a new key.',
  );
}
