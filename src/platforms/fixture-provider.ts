import type { ExternalCommentRecord, ProviderClient, ProviderPage } from './adaptive-provider.js';

export interface FixtureProviderOptions {
  /** External comments keyed by the provider's post identifier. */
  commentsByPost: ReadonlyMap<string, readonly ExternalCommentRecord[]>;
  /** Largest page the fake provider will return, mirroring a real page cap. */
  maxPageSize?: number;
  now?: () => string;
}

/**
 * A deterministic stand-in for a real provider SDK. It exists so the service
 * can be run and demonstrated end to end without selecting a live platform, and
 * so adapter behaviour has a stable fixture to test against.
 */
export class FixtureProviderClient implements ProviderClient {
  private readonly commentsByPost: ReadonlyMap<string, readonly ExternalCommentRecord[]>;
  private readonly maxPageSize: number;
  private readonly now: () => string;
  private replyCount = 0;

  public constructor(options: FixtureProviderOptions) {
    this.commentsByPost = options.commentsByPost;
    this.maxPageSize = options.maxPageSize ?? 25;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async listComments(query: {
    externalPostId: string;
    cursor?: string;
    limit: number;
  }): Promise<ProviderPage> {
    const all = this.commentsByPost.get(query.externalPostId) ?? [];
    const offset = decodeOffset(query.cursor);
    const size = Math.min(query.limit, this.maxPageSize);
    const items = all.slice(offset, offset + size);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < all.length;
    return { items: [...items], nextCursor: hasMore ? encodeOffset(nextOffset) : null, hasMore };
  }

  public async replyToComment(command: {
    externalPostId: string;
    externalCommentId: string;
    body: string;
  }): Promise<ExternalCommentRecord> {
    this.replyCount += 1;
    const timestamp = this.now();
    return {
      externalId: `${command.externalCommentId}-reply-${this.replyCount}`,
      authorId: 'fixture-account',
      authorName: 'Blotato',
      body: command.body,
      parentExternalId: command.externalCommentId,
      publishedAt: timestamp,
      updatedAt: timestamp,
    };
  }
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}
