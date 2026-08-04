import { NotFoundError, ServiceError, toFailureCode } from '../shared/errors.js';
import { decodeCursor, encodeCursor } from '../shared/cursor.js';
import {
  validateListCommentsQuery,
  validatePagination,
  validateReplyToCommentCommand,
} from '../shared/validation.js';
import { noopMetrics, type Metrics } from '../shared/observability.js';
import { requireCapability } from '../platforms/provider-registry.js';
import type { Comment, PageCursor, PublishedPost, TenantContext } from '../shared/types.js';
import type { ReplyOperation } from '../shared/types.js';
import type {
  CommentRepository,
  ListCommentsQuery,
  ListCommentsResult,
  PlatformProviderRegistry,
  PostRepository,
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
  ) {}

  /**
   * Serves comments from the local snapshot, hydrating from the provider when
   * the snapshot cannot answer the requested position (Spec-008).
   */
  public async listComments(
    context: TenantContext,
    postId: string,
    request: ListCommentsRequest,
  ): Promise<ListCommentsResult> {
    const post = await this.posts.findPublishedById(context, postId);
    if (!post) throw new NotFoundError('POST_NOT_FOUND', 'The requested post was not found.');

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
      let providerCursor = cursor.providerCursor;

      const upstreamMayHaveMore = cursor.after === null || cursor.providerCursor !== null;
      if (page.items.length === 0 && upstreamMayHaveMore) {
        providerCursor = await this.hydrate(context, post, providerCursor, request.limit);
        page = await this.comments.listByPost(context, query);
      }

      const last = page.items[page.items.length - 1];
      const hasMore = last !== undefined && (page.hasMore || providerCursor !== null);
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

      this.metrics.increment('comments.list.success', { platform: post.platform });
      this.metrics.observe('comments.list.duration_ms', Date.now() - startedAt, {
        platform: post.platform,
      });
      return { items: page.items, pagination };
    } catch (error) {
      this.metrics.increment('comments.list.failure', {
        platform: post.platform,
        code: toFailureCode(error),
      });
      throw error;
    }
  }

  public async replyToComment(
    context: TenantContext,
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
      if (replayed) return replayed;
    }

    const comment = await this.comments.findById(context, commentId);
    if (!comment) {
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The requested comment was not found.');
    }
    const post = await this.posts.findPublishedById(context, comment.postId);
    if (!post) {
      throw new NotFoundError('POST_NOT_FOUND', 'The post for this comment was not found.');
    }
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
      throw new ServiceError(
        'IDEMPOTENCY_CONFLICT',
        'A reply for this idempotency key is already in progress.',
        409,
      );
    }

    try {
      const reply = await provider.replyToComment({ post, parentExternalCommentId, body });
      const [stored] = await this.comments.upsertMany(context, [reply]);
      if (!stored) {
        throw new ServiceError('INTERNAL_ERROR', 'The published reply could not be stored.', 500);
      }
      await this.operations.complete(context, claim.operation.id, stored.id);
      this.metrics.increment('comments.reply.success', { platform: comment.platform });
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
      throw error;
    }
  }

  private async hydrate(
    context: TenantContext,
    post: PublishedPost,
    providerCursor: string | null,
    limit: number,
  ): Promise<string | null> {
    const provider = this.providers.get(post.platform);
    requireCapability(provider, 'list_comments');
    const page = await provider.listComments({
      post,
      limit,
      ...(providerCursor === null ? {} : { providerCursor }),
    });
    if (page.items.length > 0) await this.comments.upsertMany(context, page.items);
    this.metrics.increment('comments.list.hydrated', { platform: post.platform });
    return page.hasMore ? page.nextProviderCursor : null;
  }

  /**
   * Resolves a repeated idempotency key. A key is bound to one request body,
   * and an operation that already failed is terminal: the outcome at the
   * provider may be unknown, so replaying it could duplicate a published reply.
   */
  private async replay(
    context: TenantContext,
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
