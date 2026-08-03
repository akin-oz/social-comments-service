import { ServiceError } from '../shared/errors.js';
import type { Comment, PublishedPost, ReplyOperation, TenantContext } from '../shared/types.js';
import type {
  CommentRepository,
  ListCommentsQuery,
  ListCommentsResult,
  PostRepository,
  ReplyOperationRepository,
} from '../comments/contracts.js';

const encodeCursor = (offset: number): string =>
  Buffer.from(String(offset), 'utf8').toString('base64url');

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ServiceError('INVALID_REQUEST', 'The cursor is invalid.', 400);
  }
  return offset;
}

function scopedKey(accountId: string, id: string): string {
  return `${accountId}:${id}`;
}

export class InMemoryCommentRepository implements CommentRepository {
  private readonly comments = new Map<string, Comment>();

  public constructor(
    seed: readonly Comment[] = [],
    private readonly defaultAccountId = 'account-1',
  ) {
    for (const comment of seed) this.comments.set(scopedKey(defaultAccountId, comment.id), comment);
  }

  public async listByPost(
    context: TenantContext,
    query: ListCommentsQuery,
  ): Promise<ListCommentsResult> {
    const items = [...this.comments.entries()]
      .filter(
        ([key, comment]) =>
          key.startsWith(`${context.accountId}:`) &&
          comment.postId === query.postId &&
          comment.platform === query.platform,
      )
      .map(([, comment]) => comment)
      .sort((left, right) =>
        `${left.publishedAt}:${left.id}`.localeCompare(`${right.publishedAt}:${right.id}`),
      );
    const offset = decodeCursor(query.cursor);
    const page = items.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;
    return {
      items: page,
      pagination: {
        hasMore: nextOffset < items.length,
        nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
      },
    };
  }

  public async findById(context: TenantContext, commentId: string): Promise<Comment | null> {
    return this.comments.get(scopedKey(context.accountId, commentId)) ?? null;
  }

  public async upsert(context: TenantContext, comment: Comment): Promise<Comment> {
    this.comments.set(scopedKey(context.accountId, comment.id), comment);
    return comment;
  }
}

export class InMemoryPostRepository implements PostRepository {
  private readonly posts = new Map<string, PublishedPost>();

  public constructor(seed: readonly PublishedPost[] = []) {
    for (const post of seed) this.posts.set(post.id, post);
  }

  public async findPublishedById(
    context: TenantContext,
    postId: string,
  ): Promise<PublishedPost | null> {
    const post = this.posts.get(postId);
    return post?.accountId === context.accountId ? post : null;
  }
}

export class InMemoryReplyOperationRepository implements ReplyOperationRepository {
  private readonly operations = new Map<string, ReplyOperation>();

  public async findByIdempotencyKey(
    context: TenantContext,
    key: string,
  ): Promise<ReplyOperation | null> {
    return (
      [...this.operations.values()].find(
        (operation) =>
          operation.accountId === context.accountId && operation.idempotencyKey === key,
      ) ?? null
    );
  }

  public async createPending(
    context: TenantContext,
    operation: Omit<ReplyOperation, 'accountId'>,
  ): Promise<ReplyOperation> {
    const existing = await this.findByIdempotencyKey(context, operation.idempotencyKey);
    if (existing) return existing;
    const stored = { ...operation, accountId: context.accountId };
    this.operations.set(scopedKey(context.accountId, operation.id), stored);
    return stored;
  }

  public async complete(
    context: TenantContext,
    operationId: string,
    commentId: string,
  ): Promise<ReplyOperation> {
    const operation = this.operations.get(scopedKey(context.accountId, operationId));
    if (!operation)
      throw new ServiceError('INVALID_REQUEST', 'Reply operation was not found.', 500);
    const updated = {
      ...operation,
      status: 'completed' as const,
      resultingCommentId: commentId,
      completedAt: new Date().toISOString(),
    };
    this.operations.set(scopedKey(context.accountId, operationId), updated);
    return updated;
  }

  public async fail(
    context: TenantContext,
    operationId: string,
    failureCode: string,
  ): Promise<ReplyOperation> {
    const operation = this.operations.get(scopedKey(context.accountId, operationId));
    if (!operation)
      throw new ServiceError('INVALID_REQUEST', 'Reply operation was not found.', 500);
    const updated = { ...operation, status: 'failed' as const, failureCode };
    this.operations.set(scopedKey(context.accountId, operationId), updated);
    return updated;
  }
}
