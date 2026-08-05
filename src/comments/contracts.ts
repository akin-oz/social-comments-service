import type {
  Comment,
  CommentKeyset,
  ObservedComment,
  Pagination,
  Platform,
  PublishedPost,
  ReplyOperation,
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
  /** Translates an internal identity back to the provider identifier (ADR-0010). */
  resolveExternalId(context: TenantContext, commentId: string): Promise<string | null>;
  /** Stores observations and returns them with the identities persistence assigned. */
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
  saveSnapshotState(
    context: TenantContext,
    postId: string,
    state: PostSnapshotState,
  ): Promise<void>;
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
  complete(context: TenantContext, operationId: string, commentId: string): Promise<ReplyOperation>;
  fail(context: TenantContext, operationId: string, failureCode: string): Promise<ReplyOperation>;
}

/**
 * Provider-facing query. The post carries both identities so adapters never
 * have to resolve internal identifiers themselves.
 */
export interface ProviderListCommentsQuery {
  post: PublishedPost;
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
