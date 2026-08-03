import { ServiceError, NotFoundError } from '../shared/errors.js';
import { validateListCommentsQuery, validateReplyToCommentCommand } from '../shared/validation.js';
import type { TenantContext } from '../shared/types.js';
import { noopMetrics, type Metrics } from '../shared/observability.js';
import { requireCapability } from '../platforms/provider-registry.js';
import type { PlatformProviderRegistry } from '../platforms/provider-registry.js';
import type {
  CommentRepository,
  ListCommentsQuery,
  ListCommentsResult,
  PostRepository,
  ReplyOperationRepository,
  ReplyToCommentCommand,
} from './contracts.js';

export class CommentService {
  public constructor(
    private readonly comments: CommentRepository,
    private readonly posts: PostRepository,
    private readonly operations: ReplyOperationRepository,
    private readonly providers: PlatformProviderRegistry,
    private readonly metrics: Metrics = noopMetrics,
  ) {}

  public async listComments(
    context: TenantContext,
    postId: string,
    query: Omit<ListCommentsQuery, 'postId' | 'platform'>,
  ): Promise<ListCommentsResult> {
    const post = await this.posts.findPublishedById(context, postId);
    if (!post) throw new NotFoundError('POST_NOT_FOUND', 'The requested post was not found.');
    const fullQuery = { ...query, postId, platform: post.platform };
    validateListCommentsQuery(fullQuery);
    const startedAt = Date.now();
    try {
      const result = await this.comments.listByPost(context, fullQuery);
      this.metrics.increment('comments.list.success', { platform: post.platform });
      this.metrics.observe('comments.list.duration_ms', Date.now() - startedAt, {
        platform: post.platform,
      });
      return result;
    } catch (error) {
      this.metrics.increment('comments.list.failure', { platform: post.platform });
      throw error;
    }
  }

  public async replyToComment(
    context: TenantContext,
    commentId: string,
    body: string,
    idempotencyKey: string,
  ) {
    const command: ReplyToCommentCommand = { commentId, body, idempotencyKey };
    validateReplyToCommentCommand(command);
    const fingerprint = `${commentId}:${body}`;
    const existing = await this.operations.findByIdempotencyKey(context, idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new ServiceError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency key was already used for a different request.',
          409,
        );
      }
      if (existing.resultingCommentId) {
        const result = await this.comments.findById(context, existing.resultingCommentId);
        if (result) return result;
      }
    }

    const comment = await this.comments.findById(context, commentId);
    if (!comment)
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The requested comment was not found.');

    const operation =
      existing ??
      (await this.operations.createPending(context, {
        id: `reply_${crypto.randomUUID()}`,
        commentId,
        idempotencyKey,
        requestFingerprint: fingerprint,
        status: 'pending',
        resultingCommentId: null,
        failureCode: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      }));

    const provider = this.providers.get(comment.platform);
    requireCapability(provider, 'reply_to_comment');
    try {
      const reply = await provider.replyToComment(command);
      const stored = await this.comments.upsert(context, reply);
      await this.operations.complete(context, operation.id, stored.id);
      this.metrics.increment('comments.reply.success', { platform: comment.platform });
      return stored;
    } catch (error) {
      await this.operations.fail(
        context,
        operation.id,
        error instanceof Error ? error.name : 'PROVIDER_ERROR',
      );
      this.metrics.increment('comments.reply.failure', { platform: comment.platform });
      throw error;
    }
  }
}
