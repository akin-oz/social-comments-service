import { internalCommentId } from '../shared/identity.js';
import { ServiceError } from '../shared/errors.js';
import type { Database, SqlSession } from './database.js';
import type {
  Comment,
  NormalizedComment,
  Platform,
  ReplyOperation,
  ReplyOperationStatus,
  TenantContext,
} from '../shared/types.js';
import type {
  CommentPage,
  CommentRepository,
  ListCommentsQuery,
  PostRepository,
  PostSnapshotState,
  PublishedPostRecord,
  ReplyOperationClaim,
  ReplyOperationRepository,
} from '../comments/contracts.js';

interface CommentRow {
  id: string;
  post_id: string;
  platform: Platform;
  author_external_id: string;
  author_display_name: string;
  body: string;
  external_comment_id: string;
  external_parent_comment_id: string | null;
  published_at: string;
  updated_at: string;
}

interface PostRow {
  id: string;
  account_id: string;
  platform: Platform;
  external_post_id: string;
  published_at: string;
  provider_cursor: string | null;
  provider_exhausted: boolean;
}

interface OperationRow {
  id: string;
  account_id: string;
  comment_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: ReplyOperationStatus;
  resulting_comment_id: string | null;
  failure_code: string | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * PostgreSQL returns snake_case columns, so rows must be mapped rather than
 * cast. Casting silently yields `undefined` for every field, which made an
 * idempotent retry look like a different request.
 */
function toOperation(row: OperationRow): ReplyOperation {
  return {
    id: row.id,
    accountId: row.account_id,
    commentId: row.comment_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    resultingCommentId: row.resulting_comment_id,
    failureCode: row.failure_code,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  };
}

// Platform belongs to the social account, not the post, so every comment query
// reaches it through that join.
const commentColumns = `c.id, c.post_id, sa.platform, c.author_external_id, c.author_display_name,
         c.body, c.external_comment_id, c.external_parent_comment_id, c.published_at, c.updated_at`;

const commentSource = `from comments c
         join posts p on p.id = c.post_id
         join social_accounts sa on sa.id = p.social_account_id`;

const operationColumns = `id, account_id, comment_id, idempotency_key, request_fingerprint, status,
         resulting_comment_id, failure_code, created_at, completed_at`;

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    postId: row.post_id,
    platform: row.platform,
    author: { id: row.author_external_id, displayName: row.author_display_name },
    body: row.body,
    // The parent is stored as the provider's identifier; the internal identity
    // is derived from it rather than stored twice (ADR-0010).
    parentCommentId:
      row.external_parent_comment_id === null
        ? null
        : internalCommentId(row.platform, row.external_parent_comment_id),
    publishedAt: new Date(row.published_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresPostRepository implements PostRepository {
  public constructor(private readonly db: Database) {}

  public async findPublishedById(
    context: TenantContext,
    postId: string,
  ): Promise<PublishedPostRecord | null> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const result = await tx.query<PostRow>(
        `select p.id, p.account_id, sa.platform, p.external_post_id, p.published_at,
                p.provider_cursor, p.provider_exhausted
         from posts p
         join social_accounts sa on sa.id = p.social_account_id
         where p.id = $1 and p.account_id = $2 and p.status = 'published'`,
        [postId, context.accountId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        post: {
          id: row.id,
          accountId: row.account_id,
          platform: row.platform,
          externalPostId: row.external_post_id,
          publishedAt: new Date(row.published_at).toISOString(),
        },
        snapshot: {
          providerCursor: row.provider_cursor,
          exhausted: row.provider_exhausted,
        },
      };
    });
  }

  public async saveSnapshotState(
    context: TenantContext,
    postId: string,
    state: PostSnapshotState,
  ): Promise<void> {
    await this.db.withTenant(context.accountId, async (tx) => {
      await tx.query(
        `update posts set provider_cursor = $1, provider_exhausted = $2
         where id = $3 and account_id = $4`,
        [state.providerCursor, state.exhausted, postId, context.accountId],
      );
    });
  }
}

export class PostgresCommentRepository implements CommentRepository {
  public constructor(private readonly db: Database) {}

  public async listByPost(context: TenantContext, query: ListCommentsQuery): Promise<CommentPage> {
    return this.db.withTenant(context.accountId, async (tx) => {
      // One extra row decides `hasMore` without a second count query.
      const result = await tx.query<CommentRow>(
        `select ${commentColumns}
         ${commentSource}
         where c.account_id = $1 and c.post_id = $2 and sa.platform = $3
           and ($4::timestamptz is null
                or (c.published_at, c.id) > ($4::timestamptz, $5::uuid))
         order by c.published_at asc, c.id asc
         limit $6`,
        [
          context.accountId,
          query.postId,
          query.platform,
          query.after?.publishedAt ?? null,
          query.after?.id ?? null,
          query.limit + 1,
        ],
      );
      const hasMore = result.rows.length > query.limit;
      return { items: result.rows.slice(0, query.limit).map(toComment), hasMore };
    });
  }

  public async findById(context: TenantContext, commentId: string): Promise<Comment | null> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const result = await tx.query<CommentRow>(
        `select ${commentColumns}
         ${commentSource}
         where c.id = $1 and c.account_id = $2`,
        [commentId, context.accountId],
      );
      const row = result.rows[0];
      return row ? toComment(row) : null;
    });
  }

  public async resolveExternalId(
    context: TenantContext,
    commentId: string,
  ): Promise<string | null> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const result = await tx.query<{ external_comment_id: string }>(
        `select external_comment_id from comments where id = $1 and account_id = $2`,
        [commentId, context.accountId],
      );
      return result.rows[0]?.external_comment_id ?? null;
    });
  }

  public async upsertMany(
    context: TenantContext,
    records: readonly NormalizedComment[],
  ): Promise<readonly Comment[]> {
    if (records.length === 0) return [];
    return this.db.withTenant(context.accountId, async (tx) => {
      const stored: Comment[] = [];
      for (const record of records) stored.push(await upsertComment(tx, context, record));
      return stored;
    });
  }
}

async function upsertComment(
  tx: SqlSession,
  context: TenantContext,
  record: NormalizedComment,
): Promise<Comment> {
  const { comment } = record;
  const result = await tx.query<{ id: string }>(
    `insert into comments
       (id, account_id, post_id, social_account_id, external_comment_id,
        external_parent_comment_id, author_external_id, author_display_name,
        body, published_at, updated_at)
     select $1, $2, p.id, p.social_account_id, $3, $4, $5, $6, $7, $8, $9
     from posts p where p.id = $10 and p.account_id = $2
     on conflict (social_account_id, external_comment_id) do update set
       body = excluded.body,
       author_display_name = excluded.author_display_name,
       external_parent_comment_id = excluded.external_parent_comment_id,
       updated_at = excluded.updated_at,
       last_seen_at = now()
     returning id`,
    [
      comment.id,
      context.accountId,
      record.externalId,
      record.externalParentCommentId,
      comment.author.id,
      comment.author.displayName,
      comment.body,
      comment.publishedAt,
      comment.updatedAt,
      comment.postId,
    ],
  );
  if (!result.rows[0]) {
    throw new ServiceError('POST_NOT_FOUND', 'The comment post was not found.', 404);
  }
  return comment;
}

export class PostgresReplyOperationRepository implements ReplyOperationRepository {
  public constructor(private readonly db: Database) {}

  public async findByIdempotencyKey(
    context: TenantContext,
    key: string,
  ): Promise<ReplyOperation | null> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const result = await tx.query<OperationRow>(
        `select ${operationColumns}
         from reply_operations where account_id = $1 and idempotency_key = $2`,
        [context.accountId, key],
      );
      const row = result.rows[0];
      return row ? toOperation(row) : null;
    });
  }

  /**
   * Inserts the operation, or reports that another caller already owns the key.
   * `do nothing` makes the unique index the arbiter, so two concurrent requests
   * cannot both proceed to the provider.
   */
  public async claim(
    context: TenantContext,
    operation: Omit<ReplyOperation, 'accountId'>,
  ): Promise<ReplyOperationClaim> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const inserted = await tx.query<OperationRow>(
        `insert into reply_operations
           (id, account_id, comment_id, idempotency_key, request_fingerprint, status,
            resulting_comment_id, failure_code, created_at, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (account_id, idempotency_key) do nothing
         returning ${operationColumns}`,
        [
          operation.id,
          context.accountId,
          operation.commentId,
          operation.idempotencyKey,
          operation.requestFingerprint,
          operation.status,
          operation.resultingCommentId,
          operation.failureCode,
          operation.createdAt,
          operation.completedAt,
        ],
      );
      const row = inserted.rows[0];
      if (row) return { operation: toOperation(row), claimed: true };

      const existing = await tx.query<OperationRow>(
        `select ${operationColumns}
         from reply_operations where account_id = $1 and idempotency_key = $2`,
        [context.accountId, operation.idempotencyKey],
      );
      const current = existing.rows[0];
      if (!current) {
        throw new ServiceError('INTERNAL_ERROR', 'Reply operation could not be claimed.', 500);
      }
      return { operation: toOperation(current), claimed: false };
    });
  }

  public async complete(
    context: TenantContext,
    operationId: string,
    commentId: string,
  ): Promise<ReplyOperation> {
    return this.update(context, operationId, [
      commentId,
      'completed',
      null,
      new Date().toISOString(),
    ]);
  }

  public async fail(
    context: TenantContext,
    operationId: string,
    failureCode: string,
  ): Promise<ReplyOperation> {
    return this.update(context, operationId, [
      null,
      'failed',
      failureCode,
      new Date().toISOString(),
    ]);
  }

  private async update(
    context: TenantContext,
    operationId: string,
    values: readonly unknown[],
  ): Promise<ReplyOperation> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const result = await tx.query<OperationRow>(
        `update reply_operations set resulting_comment_id = $1, status = $2,
           failure_code = $3, completed_at = $4
         where id = $5 and account_id = $6
         returning ${operationColumns}`,
        [...values, operationId, context.accountId],
      );
      const row = result.rows[0];
      if (!row) throw new ServiceError('INTERNAL_ERROR', 'Reply operation was not found.', 500);
      return toOperation(row);
    });
  }
}
