import { ProviderError } from '../shared/errors.js';
import { validateObservedComment } from '../shared/validation.js';
import {
  callProvider,
  noopLogger,
  providerRetryPolicies,
  type Logger,
  type ProviderRetryPolicies,
} from '../shared/observability.js';
import { toFailureCode } from '../shared/errors.js';
import type {
  ObservedComment,
  Platform,
  PublishedPost,
  SocialConnection,
} from '../shared/types.js';
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
    connection: SocialConnection;
    externalPostId: string;
    cursor?: string;
    limit: number;
  }): Promise<ProviderPage>;
  replyToComment(command: {
    connection: SocialConnection;
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
    const connection = this.authorised(query.connection);
    const page = await callProvider(
      () =>
        this.client.listComments({
          connection,
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
      items: page.items.map((item) => this.toObserved(item, query.post, null)),
      nextProviderCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  public async replyToComment(command: ProviderReplyCommand): Promise<ObservedComment> {
    const connection = this.authorised(command.connection);
    const item = await callProvider(
      () =>
        this.client.replyToComment({
          connection,
          externalPostId: command.post.externalPostId,
          externalCommentId: command.parentExternalCommentId,
          body: command.body,
        }),
      // Writes use the non-replaying policy: a timed-out publish may have
      // succeeded, so a retry here would duplicate a real reply.
      this.policies.write,
      (error, delayMs) => this.logRetry('reply_to_comment', error, delayMs),
    );
    return this.toObserved(item, command.post, command.parentExternalCommentId);
  }

  /**
   * Checks the call carries a usable connection before it reaches the client.
   *
   * One adapter instance serves every tenant, so a call without a connection is
   * a call with no account to act as. Failing here names the problem; letting it
   * through means an SDK error, or worse, a default credential.
   *
   * The message deliberately omits the reference itself: it names a secret
   * (ADR-0011).
   */
  private authorised(connection: SocialConnection): SocialConnection {
    if (connection.credentialReference.trim() === '' || connection.socialAccountId.trim() === '') {
      throw new ProviderError(
        `Provider ${this.platform} was called without an authorised connection.`,
      );
    }
    if (connection.platform !== this.platform) {
      throw new ProviderError(
        `Provider ${this.platform} was given a ${connection.platform} connection.`,
      );
    }
    return connection;
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

  /**
   * Maps a provider record onto an observation. It deliberately carries no
   * identity: persistence assigns that (ADR-0013), so the adapter cannot
   * invent one and cannot disagree with the constraint that enforces it.
   */
  private toObserved(
    item: ExternalCommentRecord,
    post: PublishedPost,
    fallbackParentExternalId: string | null,
  ): ObservedComment {
    const observed: ObservedComment = {
      postId: post.id,
      platform: this.platform,
      author: {
        id: item.authorId,
        displayName: item.authorName,
        ...(item.authorProfileUrl === undefined ? {} : { profileUrl: item.authorProfileUrl }),
      },
      body: item.body,
      publishedAt: item.publishedAt,
      updatedAt: item.updatedAt,
      externalId: item.externalId,
      externalParentCommentId: item.parentExternalId ?? fallbackParentExternalId,
    };
    validateObservedComment(observed);
    return observed;
  }
}
