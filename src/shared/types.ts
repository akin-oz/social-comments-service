/** Supported provider families. Add a value only when the provider contract is understood. */
export type Platform = 'facebook' | 'instagram' | 'linkedin' | 'x' | 'youtube';

export type PageCursor = string;

export type AccountId = string;

export interface Pagination {
  nextCursor: PageCursor | null;
  hasMore: boolean;
}

export interface ExternalAuthor {
  id: string;
  displayName: string;
  profileUrl?: string;
}

export interface Comment {
  id: string;
  postId: string;
  platform: Platform;
  author: ExternalAuthor;
  body: string;
  parentCommentId: string | null;
  publishedAt: string;
  updatedAt: string;
}

/**
 * A comment plus the provider identity used to deduplicate it. Provider
 * identifiers stay out of {@link Comment} so they are never serialized to
 * API clients (ADR-0010).
 */
export interface NormalizedComment {
  comment: Comment;
  externalId: string;
  externalParentCommentId: string | null;
}

/** Ordering position used for keyset pagination (Spec-009). */
export interface CommentKeyset {
  publishedAt: string;
  id: string;
}

export interface TenantContext {
  accountId: AccountId;
}

export interface PublishedPost {
  id: string;
  accountId: AccountId;
  platform: Platform;
  externalPostId: string;
  publishedAt: string;
}

export type ReplyOperationStatus = 'pending' | 'completed' | 'failed';

export interface ReplyOperation {
  id: string;
  accountId: AccountId;
  commentId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: ReplyOperationStatus;
  resultingCommentId: string | null;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
}
