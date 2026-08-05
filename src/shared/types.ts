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
 * A comment as the provider reported it, before it has an identity.
 *
 * Identity is assigned by persistence (ADR-0013), so an adapter cannot produce
 * a {@link Comment} — only the observation that becomes one. Provider
 * identifiers live here and never reach an API client.
 */
export interface ObservedComment {
  postId: string;
  platform: Platform;
  author: ExternalAuthor;
  body: string;
  publishedAt: string;
  updatedAt: string;
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

/**
 * Tenancy plus the correlation identifier for the request that caused the work
 * (ADR-0011). Application services take this; repositories keep taking
 * {@link TenantContext}, since tenancy is all they need.
 */
export interface RequestContext extends TenantContext {
  requestId: string;
}

/**
 * The authorised connection a provider call acts as (A-002, Spec-016).
 *
 * `credentialReference` names a secret held by platform infrastructure; it is
 * never the secret itself. An adapter resolves it through infrastructure it
 * owns, so nothing secret enters the domain, a response, or a log record.
 */
export interface SocialConnection {
  socialAccountId: string;
  platform: Platform;
  credentialReference: string;
}

export interface PublishedPost {
  id: string;
  accountId: AccountId;
  platform: Platform;
  externalPostId: string;
  publishedAt: string;
  /**
   * The connection this post was published through. One adapter instance per
   * platform is shared across tenants, so the connection has to travel with the
   * call rather than with the adapter.
   */
  connection: SocialConnection;
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
