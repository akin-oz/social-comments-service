import { ServiceError } from '../shared/errors.js';
import type {
  Comment,
  CommentKeyset,
  ObservedComment,
  PublishedPost,
  ReplyOperation,
  TenantContext,
} from '../shared/types.js';
import type {
  CommentPage,
  CommentRepository,
  ListCommentsQuery,
  PostRepository,
  PostSnapshotState,
  PublishedPostRecord,
  ReplyOperationClaim,
  ReplyOperationRepository,
} from '../comments/contracts.js';

/**
 * Per-tenant storage that cannot match across a delimiter.
 *
 * The previous scheme flattened `(accountId, id)` into one `accountId:id`
 * string and scoped reads with `startsWith`. Composite string keys are exactly
 * the shape that leaks: an account identifier containing the delimiter can be
 * a prefix of another tenant's key, and a prefix match is a weaker check than
 * it looks. A map per tenant makes the boundary structural, which is the
 * closest an in-memory adapter gets to the database policy behind the
 * PostgreSQL composition (Spec-018).
 */
class TenantScoped<T> {
  private readonly byTenant = new Map<string, Map<string, T>>();

  public get(accountId: string, id: string): T | undefined {
    return this.byTenant.get(accountId)?.get(id);
  }

  public set(accountId: string, id: string, value: T): void {
    let scope = this.byTenant.get(accountId);
    if (scope === undefined) {
      scope = new Map<string, T>();
      this.byTenant.set(accountId, scope);
    }
    scope.set(id, value);
  }

  /** Everything one tenant can see, and nothing any other tenant stored. */
  public values(accountId: string): readonly T[] {
    return [...(this.byTenant.get(accountId)?.values() ?? [])];
  }
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

interface StoredComment {
  id: string;
  observed: ObservedComment;
}

export class InMemoryCommentRepository implements CommentRepository {
  private readonly byId = new TenantScoped<StoredComment>();
  /** Provider identity to assigned identity, mirroring the SQL unique constraint. */
  private readonly byExternalId = new TenantScoped<string>();

  public constructor(
    seed: readonly ObservedComment[] = [],
    private readonly defaultAccountId = 'account-1',
  ) {
    for (const observed of seed) this.store(this.defaultAccountId, observed);
  }

  public async listByPost(context: TenantContext, query: ListCommentsQuery): Promise<CommentPage> {
    const ordered = this.byId
      .values(context.accountId)
      .filter(
        (stored) =>
          stored.observed.postId === query.postId && stored.observed.platform === query.platform,
      )
      .map((stored) => this.toComment(context.accountId, stored))
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
    const stored = this.byId.get(context.accountId, commentId);
    return stored ? this.toComment(context.accountId, stored) : null;
  }

  public async findByExternalId(
    context: TenantContext,
    externalId: string,
  ): Promise<Comment | null> {
    const id = this.byExternalId.get(context.accountId, externalId);
    if (id === undefined) return null;
    const stored = this.byId.get(context.accountId, id);
    return stored ? this.toComment(context.accountId, stored) : null;
  }

  public async resolveExternalId(
    context: TenantContext,
    commentId: string,
  ): Promise<string | null> {
    return this.byId.get(context.accountId, commentId)?.observed.externalId ?? null;
  }

  public async upsertMany(
    context: TenantContext,
    observed: readonly ObservedComment[],
  ): Promise<readonly Comment[]> {
    const stored = observed.map((item) => this.store(context.accountId, item));
    // Parents resolve after the whole batch is stored, so a reply that arrives
    // alongside its parent still finds it.
    return stored.map((item) => this.toComment(context.accountId, item));
  }

  /** Assigns an identity, or reuses the one this provider comment already has. */
  private store(accountId: string, observed: ObservedComment): StoredComment {
    const id = this.byExternalId.get(accountId, observed.externalId) ?? crypto.randomUUID();
    const stored: StoredComment = { id, observed };
    this.byExternalId.set(accountId, observed.externalId, id);
    this.byId.set(accountId, id, stored);
    return stored;
  }

  private toComment(accountId: string, stored: StoredComment): Comment {
    const { observed } = stored;
    const parentExternal = observed.externalParentCommentId;
    return {
      id: stored.id,
      postId: observed.postId,
      platform: observed.platform,
      author: observed.author,
      body: observed.body,
      // The parent is whatever row holds that provider identifier, not a value
      // computed from it (ADR-0013).
      parentCommentId:
        parentExternal === null ? null : (this.byExternalId.get(accountId, parentExternal) ?? null),
      publishedAt: observed.publishedAt,
      updatedAt: observed.updatedAt,
    };
  }
}

export class InMemoryPostRepository implements PostRepository {
  private readonly posts = new Map<string, PublishedPost>();
  private readonly snapshots = new TenantScoped<PostSnapshotState>();

  public constructor(seed: readonly PublishedPost[] = []) {
    for (const post of seed) this.posts.set(post.id, post);
  }

  public async findPublishedById(
    context: TenantContext,
    postId: string,
  ): Promise<PublishedPostRecord | null> {
    const post = this.posts.get(postId);
    if (post?.accountId !== context.accountId) return null;
    // An unseen post has read nothing of its provider stream, so it is not
    // exhausted and the first read hydrates.
    const snapshot = this.snapshots.get(context.accountId, postId) ?? {
      providerCursor: null,
      exhausted: false,
      completedAt: null,
    };
    return { post, snapshot };
  }

  public async saveSnapshotState(
    context: TenantContext,
    postId: string,
    state: PostSnapshotState,
  ): Promise<void> {
    this.snapshots.set(context.accountId, postId, state);
  }
}

export class InMemoryReplyOperationRepository implements ReplyOperationRepository {
  private readonly operations = new TenantScoped<ReplyOperation>();
  /**
   * Idempotency key to operation id. This index is what plays the role the
   * unique constraint plays in PostgreSQL: without it the claim had to scan by
   * key, and the scan sat behind an `await`, so two concurrent callers both
   * passed the check and both were granted the same key.
   */
  private readonly claimedKeys = new TenantScoped<string>();

  public async findByIdempotencyKey(
    context: TenantContext,
    key: string,
  ): Promise<ReplyOperation | null> {
    return this.byIdempotencyKey(context, key);
  }

  public async claim(
    context: TenantContext,
    operation: Omit<ReplyOperation, 'accountId'>,
  ): Promise<ReplyOperationClaim> {
    // Test and set with nothing awaited in between, so no other caller can
    // interleave between the check and the write.
    const existing = this.byIdempotencyKey(context, operation.idempotencyKey);
    if (existing) return { operation: existing, claimed: false };
    const stored: ReplyOperation = { ...operation, accountId: context.accountId };
    this.claimedKeys.set(context.accountId, operation.idempotencyKey, operation.id);
    this.operations.set(context.accountId, operation.id, stored);
    return { operation: stored, claimed: true };
  }

  private byIdempotencyKey(context: TenantContext, key: string): ReplyOperation | null {
    const id = this.claimedKeys.get(context.accountId, key);
    if (id === undefined) return null;
    return this.operations.get(context.accountId, id) ?? null;
  }

  public async recordPublished(
    context: TenantContext,
    operationId: string,
    externalReplyId: string,
  ): Promise<ReplyOperation> {
    return this.update(context, operationId, { externalReplyId });
  }

  /** Only a pending operation moves, mirroring the SQL predicate. */
  public async markUnknown(
    context: TenantContext,
    operationId: string,
    failureCode: string,
  ): Promise<ReplyOperation | null> {
    const operation = this.operations.get(context.accountId, operationId);
    if (operation?.status !== 'pending') return null;
    return this.update(context, operationId, {
      status: 'unknown',
      failureCode,
      completedAt: new Date().toISOString(),
    });
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
    const operation = this.operations.get(context.accountId, operationId);
    if (!operation) {
      throw new ServiceError('INTERNAL_ERROR', 'Reply operation was not found.', 500);
    }
    const updated: ReplyOperation = { ...operation, ...changes };
    this.operations.set(context.accountId, operationId, updated);
    return updated;
  }
}
