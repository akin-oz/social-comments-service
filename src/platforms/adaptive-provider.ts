import { ProviderError } from '../shared/errors.js';
import { internalCommentId } from '../shared/identity.js';
import { validateNormalizedComment } from '../shared/validation.js';
import {
  callProvider,
  noopLogger,
  providerRetryPolicies,
  type Logger,
  type ProviderRetryPolicies,
} from '../shared/observability.js';
import { toFailureCode } from '../shared/errors.js';
import type { Comment, NormalizedComment, Platform, PublishedPost } from '../shared/types.js';
import type {
  AdaptiveProvider,
  ProviderCapability,
  ProviderCommentPage,
  ProviderListCommentsQuery,
  ProviderReplyCommand,
} from '../comments/contracts.js';

/** A comment exactly as the provider reports it, before normalization. */
export interface ExternalCommentRecord {
  externalId: string;
  authorId: string;
  authorName: string;
  authorProfileUrl?: string;
  body: string;
  parentExternalId?: string;
  publishedAt: string;
  updatedAt: string;
}

export interface ProviderPage {
  items: ExternalCommentRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The provider-owned surface. Implementations hold SDK types and speak only in
 * external identifiers; nothing above this interface sees provider internals.
 */
export interface ProviderClient {
  listComments(query: {
    externalPostId: string;
    cursor?: string;
    limit: number;
  }): Promise<ProviderPage>;
  replyToComment(command: {
    externalPostId: string;
    externalCommentId: string;
    body: string;
  }): Promise<ExternalCommentRecord>;
}

export class AdaptiveProviderAdapter implements AdaptiveProvider {
  public constructor(
    public readonly platform: Platform,
    private readonly client: ProviderClient,
    public readonly capabilities: ReadonlySet<ProviderCapability>,
    private readonly policies: ProviderRetryPolicies = providerRetryPolicies,
    private readonly logger: Logger = noopLogger,
  ) {}

  public async listComments(query: ProviderListCommentsQuery): Promise<ProviderCommentPage> {
    const page = await callProvider(
      () =>
        this.client.listComments({
          externalPostId: query.post.externalPostId,
          ...(query.providerCursor === undefined ? {} : { cursor: query.providerCursor }),
          limit: query.limit,
        }),
      this.policies.read,
      (error, delayMs) => this.logRetry('list_comments', error, delayMs),
    );
    if (page.hasMore && page.nextCursor === null) {
      throw new ProviderError(
        `Provider ${this.platform} reported more comments without a continuation cursor.`,
      );
    }
    return {
      items: page.items.map((item) => this.toNormalized(item, query.post, null)),
      nextProviderCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  public async replyToComment(command: ProviderReplyCommand): Promise<NormalizedComment> {
    const item = await callProvider(
      () =>
        this.client.replyToComment({
          externalPostId: command.post.externalPostId,
          externalCommentId: command.parentExternalCommentId,
          body: command.body,
        }),
      // Writes use the non-replaying policy: a timed-out publish may have
      // succeeded, so a retry here would duplicate a real reply.
      this.policies.write,
      (error, delayMs) => this.logRetry('reply_to_comment', error, delayMs),
    );
    return this.toNormalized(item, command.post, command.parentExternalCommentId);
  }

  /**
   * Retries are the one provider detail the application layer cannot see, since
   * they happen inside a single call. Records carry no request identifier
   * because the adapter outlives any one request; correlate by platform and
   * time against the `provider.*` record the service emits.
   */
  private logRetry(operation: ProviderCapability, error: unknown, delayMs: number): void {
    this.logger.warn('provider.call.retried', {
      platform: this.platform,
      operation,
      code: toFailureCode(error),
      delayMs,
    });
  }

  private toNormalized(
    item: ExternalCommentRecord,
    post: PublishedPost,
    fallbackParentExternalId: string | null,
  ): NormalizedComment {
    const externalParentCommentId = item.parentExternalId ?? fallbackParentExternalId;
    const comment: Comment = {
      id: internalCommentId(this.platform, item.externalId),
      postId: post.id,
      platform: this.platform,
      author: {
        id: item.authorId,
        displayName: item.authorName,
        ...(item.authorProfileUrl === undefined ? {} : { profileUrl: item.authorProfileUrl }),
      },
      body: item.body,
      parentCommentId:
        externalParentCommentId === null
          ? null
          : internalCommentId(this.platform, externalParentCommentId),
      publishedAt: item.publishedAt,
      updatedAt: item.updatedAt,
    };
    const record: NormalizedComment = {
      comment,
      externalId: item.externalId,
      externalParentCommentId,
    };
    validateNormalizedComment(record);
    return record;
  }
}
