import { NotFoundError, ServiceError, toFailureCode } from '../shared/errors.js';
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
      let page = await this.comments.listByPost(context, query);
      let providerCursor = snapshot.providerCursor;
      let exhausted = snapshot.exhausted;

      // Hydrate whenever the snapshot cannot fill the page and the provider
      // stream has not been read to its end. Triggering on an empty page
      // instead would leave a partly-synchronised post reporting no further
      // results to any caller that did not carry a cursor (Spec-013).
      const hydrated = page.items.length < request.limit && !exhausted;
      if (hydrated) {
        const fetched = await this.hydrate(context, post, providerCursor, request.limit);
        providerCursor = fetched.providerCursor;
        exhausted = fetched.exhausted;
        await this.posts.saveSnapshotState(context, postId, { providerCursor, exhausted });
        page = await this.comments.listByPost(context, query);
      }

      const last = page.items[page.items.length - 1];
      // Completeness of the snapshot decides this, never the caller's cursor.
      const hasMore = last !== undefined && (page.hasMore || !exhausted);
      const pagination = {
        hasMore,
        nextCursor: hasMore
          ? encodeCursor({
              after: { publishedAt: last.publishedAt, id: last.id },
              providerCursor,
            })
          : null,
      };
      validatePagination(pagination);

      const durationMs = Date.now() - startedAt;
      this.metrics.increment('comments.list.success', { platform: post.platform });
      this.metrics.observe('comments.list.duration_ms', durationMs, { platform: post.platform });
      this.logger.info(hydrated ? 'comments.list.hydrated' : 'comments.list.served_from_cache', {
        ...this.trace(context),
        postId,
        platform: post.platform,
        returned: page.items.length,
        hasMore,
        durationMs,
      });
      return { items: page.items, pagination };
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
    const fingerprint = `${commentId}:${body}`;

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
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The requested comment was not found.');
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

    const claim = await this.operations.claim(context, {
      id: crypto.randomUUID(),
      commentId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      status: 'pending',
      resultingCommentId: null,
      failureCode: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    if (!claim.claimed) {
      const replayed = await this.replay(context, claim.operation, fingerprint);
      if (replayed) return replayed;
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
    try {
      const reply = await provider.replyToComment({ post, parentExternalCommentId, body });
      const [stored] = await this.comments.upsertMany(context, [reply]);
      if (!stored) {
        throw new ServiceError('INTERNAL_ERROR', 'The published reply could not be stored.', 500);
      }
      await this.operations.complete(context, claim.operation.id, stored.id);
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
    } catch (error) {
      const failureCode = toFailureCode(error);
      await this.operations.fail(context, claim.operation.id, failureCode);
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
  }

  /**
   * Reads one provider page into the snapshot and reports how far the stream
   * has been consumed. One page per request keeps a single read from making an
   * unbounded number of provider calls, so a page may come back shorter than
   * the requested limit while more remains upstream.
   */
  private async hydrate(
    context: RequestContext,
    post: PublishedPost,
    providerCursor: string | null,
    limit: number,
  ): Promise<PostSnapshotState> {
    const provider = this.providers.get(post.platform);
    requireCapability(provider, 'list_comments');
    const startedAt = Date.now();
    const page = await provider.listComments({
      post,
      limit,
      ...(providerCursor === null ? {} : { providerCursor }),
    });
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
      ? { providerCursor: page.nextProviderCursor, exhausted: false }
      : { providerCursor: null, exhausted: true };
  }

  private trace(context: RequestContext): LogFields {
    return { requestId: context.requestId, accountId: context.accountId };
  }

  /**
   * Resolves a repeated idempotency key. A key is bound to one request body,
   * and an operation that already failed is terminal: the outcome at the
   * provider may be unknown, so replaying it could duplicate a published reply.
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
    return null;
  }
}
