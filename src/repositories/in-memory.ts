import { ServiceError } from '../shared/errors.js';
import type {
  Comment,
  CommentKeyset,
  NormalizedComment,
  PublishedPost,
  ReplyOperation,
  TenantContext,
} from '../shared/types.js';
import type {
  CommentPage,
  CommentRepository,
  ListCommentsQuery,
  PostRepository,
  ReplyOperationClaim,
  ReplyOperationRepository,
} from '../comments/contracts.js';

function scopedKey(accountId: string, id: string): string {
  return `${accountId}:${id}`;
}

function keysetOf(comment: Comment): CommentKeyset {
  return { publishedAt: comment.publishedAt, id: comment.id };
}

/** Total ordering that matches the `(published_at, id)` index used in SQL. */
function compareKeyset(left: CommentKeyset, right: CommentKeyset): number {
  if (left.publishedAt !== right.publishedAt) {
    return left.publishedAt < right.publishedAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export class InMemoryCommentRepository implements CommentRepository {
  private readonly records = new Map<string, NormalizedComment>();

  public constructor(
    seed: readonly NormalizedComment[] = [],
    private readonly defaultAccountId = 'account-1',
  ) {
    for (const record of seed) {
      this.records.set(scopedKey(defaultAccountId, record.comment.id), record);
    }
  }

  public async listByPost(context: TenantContext, query: ListCommentsQuery): Promise<CommentPage> {
    const ordered = [...this.records.entries()]
      .filter(
        ([key, record]) =>
          key.startsWith(`${context.accountId}:`) &&
          record.comment.postId === query.postId &&
          record.comment.platform === query.platform,
      )
      .map(([, record]) => record.comment)
      .sort((left, right) => compareKeyset(keysetOf(left), keysetOf(right)));

    const after = query.after;
    const startIndex =
      after === undefined
        ? 0
        : ordered.findIndex((comment) => compareKeyset(keysetOf(comment), after) > 0);
    if (startIndex === -1) return { items: [], hasMore: false };

    const items = ordered.slice(startIndex, startIndex + query.limit);
    return { items, hasMore: startIndex + items.length < ordered.length };
  }

  public async findById(context: TenantContext, commentId: string): Promise<Comment | null> {
    return this.records.get(scopedKey(context.accountId, commentId))?.comment ?? null;
  }

  public async resolveExternalId(
    context: TenantContext,
    commentId: string,
  ): Promise<string | null> {
    return this.records.get(scopedKey(context.accountId, commentId))?.externalId ?? null;
  }

  public async upsertMany(
    context: TenantContext,
    records: readonly NormalizedComment[],
  ): Promise<readonly Comment[]> {
    for (const record of records) {
      this.records.set(scopedKey(context.accountId, record.comment.id), record);
    }
    return records.map((record) => record.comment);
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

  public async claim(
    context: TenantContext,
    operation: Omit<ReplyOperation, 'accountId'>,
  ): Promise<ReplyOperationClaim> {
    const existing = await this.findByIdempotencyKey(context, operation.idempotencyKey);
    if (existing) return { operation: existing, claimed: false };
    const stored: ReplyOperation = { ...operation, accountId: context.accountId };
    this.operations.set(scopedKey(context.accountId, operation.id), stored);
    return { operation: stored, claimed: true };
  }

  public async complete(
    context: TenantContext,
    operationId: string,
    commentId: string,
  ): Promise<ReplyOperation> {
    return this.update(context, operationId, {
      status: 'completed',
      resultingCommentId: commentId,
      failureCode: null,
      completedAt: new Date().toISOString(),
    });
  }

  public async fail(
    context: TenantContext,
    operationId: string,
    failureCode: string,
  ): Promise<ReplyOperation> {
    return this.update(context, operationId, {
      status: 'failed',
      failureCode,
      completedAt: new Date().toISOString(),
    });
  }

  private update(
    context: TenantContext,
    operationId: string,
    changes: Partial<ReplyOperation>,
  ): ReplyOperation {
    const key = scopedKey(context.accountId, operationId);
    const operation = this.operations.get(key);
    if (!operation) {
      throw new ServiceError('INTERNAL_ERROR', 'Reply operation was not found.', 500);
    }
    const updated: ReplyOperation = { ...operation, ...changes };
    this.operations.set(key, updated);
    return updated;
  }
}
