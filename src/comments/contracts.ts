import type {
  Comment,
  CommentKeyset,
  ObservedComment,
  Pagination,
  Platform,
  PublishedPost,
  ReplyOperation,
  SocialConnection,
  TenantContext,
} from '../shared/types.js';

/** Repository-facing query. Callers pass a decoded keyset, never an opaque cursor. */
export interface ListCommentsQuery {
  postId: string;
  platform: Platform;
  after?: CommentKeyset;
  limit: number;
}

/** A page of locally cached comments. The opaque cursor is composed by the service. */
export interface CommentPage {
  items: Comment[];
  hasMore: boolean;
}

export interface ListCommentsResult {
  items: Comment[];
  pagination: Pagination;
  /** How current the local snapshot is, so a client need not assume (Spec-014). */
  snapshot: { syncedAt: string | null };
}

export interface ReplyToCommentCommand {
  commentId: string;
  body: string;
  idempotencyKey: string;
}

export interface CommentRepository {
  listByPost(context: TenantContext, query: ListCommentsQuery): Promise<CommentPage>;
  findById(context: TenantContext, commentId: string): Promise<Comment | null>;
  /**
   * Finds the reply an operation published, by the provider identifier recorded
   * on that operation. Used to reconcile an operation that was left pending
   * because its completion write was lost (Spec-015).
   *
   * Takes the sibling comment — the parent the reply answers — rather than a
   * bare identifier, because provider identifiers are unique only within a
   * social account. A tenant with two connections on one platform can hold the
   * same identifier twice, legitimately, and an account-scoped lookup would
   * pick whichever row the planner returned first, completing an operation
   * against a reply published through a different connection. The sibling
   * names the connection, so the lookup can be as narrow as the constraint
   * that guarantees it (Spec-024).
   */
  findReplyByExternalId(
    context: TenantContext,
    siblingCommentId: string,
    externalId: string,
  ): Promise<Comment | null>;
  /** Translates an internal identity back to the provider identifier (ADR-0010). */
  resolveExternalId(context: TenantContext, commentId: string): Promise<string | null>;
  /**
   * Stores a reply this service just published, and never overwrites a row it
   * did not create.
   *
   * Separate from {@link CommentRepository.upsertMany} because the two want
   * opposite things from a conflict. Hydration is reconciling with the provider,
   * so a conflict means "this comment was edited" and taking the new body is
   * correct. Publication is creating something new, so a conflict means the
   * provider handed back an identifier that already names a different stored
   * comment — and sharing hydration's clause there wrote the reply's text over
   * a customer's own comment, destroying content this service does not own and
   * cannot recover.
   *
   * Re-storing the same reply stays idempotent: the recovery path may run this
   * twice for one publication, and the second call returns the stored row
   * unchanged rather than failing (Spec-027).
   */
  storePublishedReply(context: TenantContext, reply: ObservedComment): Promise<Comment>;
  /**
   * Stores observations and returns them with the identities persistence
   * assigned.
   *
   * Return order and cardinality are unspecified: the PostgreSQL adapter reads
   * the batch back in one query with no ORDER BY, and a batch spanning more
   * than one connection may return fewer rows than it was given. Callers must
   * match on `externalId`, not on position — every caller today either passes a
   * single-item batch or ignores the result (Spec-024).
   */
  upsertMany(
    context: TenantContext,
    observed: readonly ObservedComment[],
  ): Promise<readonly Comment[]>;
}

/**
 * How much of a post's provider comment stream has been read into the local
 * snapshot (Spec-013).
 *
 * Without this, the service forgets what hydration learned and cannot tell an
 * exhausted provider from one it has simply never asked, so a caller starting
 * pagination fresh is told a post has fewer comments than it does.
 */
export interface PostSnapshotState {
  /** Continuation for the next unfetched provider page. */
  providerCursor: string | null;
  /** True once the provider stream has been read to its end. */
  exhausted: boolean;
  /**
   * When the stream was last read to its end, or null while incomplete.
   * Exhaustion without a lifetime is a one-way latch that hides every comment
   * published afterwards (Spec-014).
   */
  completedAt: string | null;
}

export interface PublishedPostRecord {
  post: PublishedPost;
  snapshot: PostSnapshotState;
}

export interface PostRepository {
  findPublishedById(context: TenantContext, postId: string): Promise<PublishedPostRecord | null>;
  /**
   * Advances the stored continuation, but only from the state the caller read.
   *
   * Returns false when someone else moved it first. Without the compare, two
   * concurrent hydrations write continuations in either order and the later
   * writer wins regardless of which is further along, so the snapshot can move
   * backwards (Spec-019).
   */
  saveSnapshotState(
    context: TenantContext,
    postId: string,
    state: PostSnapshotState,
    expected: PostSnapshotState,
  ): Promise<boolean>;
}

/**
 * Outcome of an idempotency-key claim. `claimed` is true only for the caller
 * that created the record, which is the caller allowed to contact the provider.
 */
export interface ReplyOperationClaim {
  operation: ReplyOperation;
  claimed: boolean;
}

export interface ReplyOperationRepository {
  findByIdempotencyKey(context: TenantContext, key: string): Promise<ReplyOperation | null>;
  claim(
    context: TenantContext,
    operation: Omit<ReplyOperation, 'accountId'>,
  ): Promise<ReplyOperationClaim>;
  /**
   * Records the provider's identifier for a reply that has just been published
   * but not yet stored. This is the only window in which the reply exists at
   * the provider and nowhere else, and this write is what makes it recoverable
   * (Spec-015).
   */
  recordPublished(
    context: TenantContext,
    operationId: string,
    externalReplyId: string,
  ): Promise<ReplyOperation>;
  complete(context: TenantContext, operationId: string, commentId: string): Promise<ReplyOperation>;
  fail(context: TenantContext, operationId: string, failureCode: string): Promise<ReplyOperation>;
  /**
   * Resolves an operation whose outcome at the provider cannot be established.
   * Only a pending operation moves, so a recovering caller can never overwrite
   * an outcome someone else already established.
   */
  markUnknown(
    context: TenantContext,
    operationId: string,
    failureCode: string,
  ): Promise<ReplyOperation | null>;
}

/**
 * Provider-facing query. The post carries both identities so adapters never
 * have to resolve internal identifiers themselves, and the connection says
 * which authorised account to act as (Spec-016). The service is the only place
 * either is constructed, so the two cannot disagree.
 */
export interface ProviderListCommentsQuery {
  post: PublishedPost;
  connection: SocialConnection;
  providerCursor?: string;
  limit: number;
}

export interface ProviderCommentPage {
  items: ObservedComment[];
  nextProviderCursor: string | null;
  hasMore: boolean;
}

export interface ProviderReplyCommand {
  post: PublishedPost;
  connection: SocialConnection;
  parentExternalCommentId: string;
  body: string;
}

export interface CommentPlatformProvider {
  listComments(query: ProviderListCommentsQuery): Promise<ProviderCommentPage>;
  replyToComment(command: ProviderReplyCommand): Promise<ObservedComment>;
}

export type ProviderCapability = 'list_comments' | 'reply_to_comment';

export interface AdaptiveProvider extends CommentPlatformProvider {
  readonly platform: Platform;
  readonly capabilities: ReadonlySet<ProviderCapability>;
}

export interface PlatformProviderRegistry {
  get(platform: Platform): AdaptiveProvider;
}
