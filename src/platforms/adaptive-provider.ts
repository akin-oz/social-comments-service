import { validateComment, validatePagination } from '../shared/validation.js';
import type { Comment, Platform } from '../shared/types.js';
import type {
  AdaptiveProvider,
  ListCommentsQuery,
  ListCommentsResult,
  ProviderCapability,
  ReplyToCommentCommand,
} from '../comments/contracts.js';
import { providerRetryPolicy, withRetry } from '../shared/observability.js';

export interface ExternalCommentRecord {
  externalId: string;
  externalPostId: string;
  authorId: string;
  authorName: string;
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

export interface ProviderClient {
  listComments(query: {
    externalPostId: string;
    cursor?: string;
    limit: number;
  }): Promise<ProviderPage>;
  replyToComment(command: {
    externalCommentId: string;
    body: string;
  }): Promise<ExternalCommentRecord>;
}

export class AdaptiveProviderAdapter implements AdaptiveProvider {
  public constructor(
    public readonly platform: Platform,
    private readonly client: ProviderClient,
    public readonly capabilities: ReadonlySet<ProviderCapability>,
    private readonly postIdResolver: (postId: string) => string,
  ) {}

  public async listComments(query: ListCommentsQuery): Promise<ListCommentsResult> {
    const page = await withRetry(
      () =>
        this.client.listComments({
          externalPostId: this.postIdResolver(query.postId),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit,
        }),
      providerRetryPolicy,
    );
    const result = {
      items: page.items.map((item) => this.toDomain(item, query)),
      pagination: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    };
    validatePagination(result.pagination);
    return result;
  }

  public async replyToComment(command: ReplyToCommentCommand): Promise<Comment> {
    const item = await withRetry(
      () =>
        this.client.replyToComment({
          externalCommentId: command.commentId,
          body: command.body,
        }),
      providerRetryPolicy,
    );
    return this.toDomain(item, {
      postId: item.externalPostId,
      platform: this.platform,
      limit: 1,
    });
  }

  private toDomain(item: ExternalCommentRecord, query: ListCommentsQuery): Comment {
    const comment: Comment = {
      id: `${this.platform}:${item.externalId}`,
      postId: query.postId,
      platform: this.platform,
      author: {
        id: item.authorId,
        displayName: item.authorName,
      },
      body: item.body,
      parentCommentId: item.parentExternalId ? `${this.platform}:${item.parentExternalId}` : null,
      publishedAt: item.publishedAt,
      updatedAt: item.updatedAt,
    };
    validateComment(comment);
    return comment;
  }
}
