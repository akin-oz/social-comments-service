import type {
  Comment,
  PageCursor,
  Pagination,
  Platform,
  PublishedPost,
  ReplyOperation,
  TenantContext,
} from '../shared/types.js';

export interface ListCommentsQuery {
  postId: string;
  platform: Platform;
  cursor?: PageCursor;
  limit: number;
}

export interface ListCommentsResult {
  items: Comment[];
  pagination: Pagination;
}

export interface ReplyToCommentCommand {
  commentId: string;
  body: string;
  idempotencyKey: string;
}

export interface CommentRepository {
  listByPost(context: TenantContext, query: ListCommentsQuery): Promise<ListCommentsResult>;
  findById(context: TenantContext, commentId: string): Promise<Comment | null>;
  upsert(context: TenantContext, comment: Comment): Promise<Comment>;
}

export interface PostRepository {
  findPublishedById(context: TenantContext, postId: string): Promise<PublishedPost | null>;
}

export interface ReplyOperationRepository {
  findByIdempotencyKey(context: TenantContext, key: string): Promise<ReplyOperation | null>;
  createPending(
    context: TenantContext,
    operation: Omit<ReplyOperation, 'accountId'>,
  ): Promise<ReplyOperation>;
  complete(context: TenantContext, operationId: string, commentId: string): Promise<ReplyOperation>;
  fail(context: TenantContext, operationId: string, failureCode: string): Promise<ReplyOperation>;
}

export interface CommentPlatformProvider {
  listComments(query: ListCommentsQuery): Promise<ListCommentsResult>;
  replyToComment(command: ReplyToCommentCommand): Promise<Comment>;
}

export type ProviderCapability = 'list_comments' | 'reply_to_comment';

export interface AdaptiveProvider extends CommentPlatformProvider {
  readonly platform: Platform;
  readonly capabilities: ReadonlySet<ProviderCapability>;
}

export interface PlatformProviderRegistry {
  get(platform: Platform): AdaptiveProvider;
}
