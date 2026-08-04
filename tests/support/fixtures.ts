import { internalCommentId } from '../../src/shared/identity.js';
import type { ExternalCommentRecord } from '../../src/platforms/adaptive-provider.js';
import type { LogFields, Logger } from '../../src/shared/observability.js';
import type { NormalizedComment, PublishedPost, RequestContext } from '../../src/shared/types.js';

export const tenant: RequestContext = { accountId: 'account-1', requestId: 'req-1' };
export const otherTenant: RequestContext = { accountId: 'account-2', requestId: 'req-2' };

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  fields: LogFields;
}

/** Captures log records so tests can assert on the observability contract. */
export class RecordingLogger implements Logger {
  public readonly records: LogRecord[] = [];

  public debug(event: string, fields: LogFields = {}) {
    this.records.push({ level: 'debug', event, fields });
  }
  public info(event: string, fields: LogFields = {}) {
    this.records.push({ level: 'info', event, fields });
  }
  public warn(event: string, fields: LogFields = {}) {
    this.records.push({ level: 'warn', event, fields });
  }
  public error(event: string, fields: LogFields = {}) {
    this.records.push({ level: 'error', event, fields });
  }

  public events(): string[] {
    return this.records.map((record) => record.event);
  }

  public find(event: string): LogRecord | undefined {
    return this.records.find((record) => record.event === event);
  }
}

export const post: PublishedPost = {
  id: 'post-1',
  accountId: tenant.accountId,
  platform: 'instagram',
  externalPostId: 'external-post-1',
  publishedAt: '2026-08-01T09:00:00.000Z',
};

export function externalComment(externalId: string, publishedAt: string): ExternalCommentRecord {
  return {
    externalId,
    authorId: `author-${externalId}`,
    authorName: 'Ada Lovelace',
    body: `body of ${externalId}`,
    publishedAt,
    updatedAt: publishedAt,
  };
}

/** Builds the persisted form of a provider comment, mirroring adapter output. */
export function normalizedComment(externalId: string, publishedAt: string): NormalizedComment {
  return {
    comment: {
      id: internalCommentId(post.platform, externalId),
      postId: post.id,
      platform: post.platform,
      author: { id: `author-${externalId}`, displayName: 'Ada Lovelace' },
      body: `body of ${externalId}`,
      parentCommentId: null,
      publishedAt,
      updatedAt: publishedAt,
    },
    externalId,
    externalParentCommentId: null,
  };
}
