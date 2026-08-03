import type {
  CommentRepository,
  ListCommentsQuery,
  ListCommentsResult,
  PostRepository,
  ReplyOperationRepository,
} from '../comments/contracts.js';
import type { Comment, PublishedPost, ReplyOperation, TenantContext } from '../shared/types.js';
import { ServiceError } from '../shared/errors.js';

export interface SqlResult<Row> {
  rows: Row[];
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}

export interface TransactionalSqlExecutor extends SqlExecutor {
  transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
}

interface CommentRow {
  id: string;
  post_id: string;
  platform: Comment['platform'];
  author_external_id: string;
  author_display_name: string;
  body: string;
  external_parent_comment_id: string | null;
  published_at: string;
  updated_at: string;
}

interface PostRow {
  id: string;
  account_id: string;
  platform: PublishedPost['platform'];
  external_post_id: string;
  published_at: string;
}

type OperationRow = ReplyOperation;

const encodeCursor = (offset: number): string =>
  Buffer.from(String(offset), 'utf8').toString('base64url');

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  if (!Number.isInteger(offset) || offset < 0)
    throw new ServiceError('INVALID_REQUEST', 'The cursor is invalid.', 400);
  return offset;
}

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    postId: row.post_id,
    platform: row.platform,
    author: { id: row.author_external_id, displayName: row.author_display_name },
    body: row.body,
    parentCommentId: row.external_parent_comment_id,
    publishedAt: new Date(row.published_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresPostRepository implements PostRepository {
  public constructor(private readonly db: SqlExecutor) {}

  public async findPublishedById(
    context: TenantContext,
    postId: string,
  ): Promise<PublishedPost | null> {
    const result = await this.db.query<PostRow>(
      `select id, account_id, platform, external_post_id, published_at
       from posts where id = $1 and account_id = $2 and status = 'published'`,
      [postId, context.accountId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          platform: row.platform,
          externalPostId: row.external_post_id,
          publishedAt: new Date(row.published_at).toISOString(),
        }
      : null;
  }
}

export class PostgresCommentRepository implements CommentRepository {
  public constructor(private readonly db: SqlExecutor) {}

  public async listByPost(
    context: TenantContext,
    query: ListCommentsQuery,
  ): Promise<ListCommentsResult> {
    const offset = decodeCursor(query.cursor);
    const result = await this.db.query<CommentRow>(
      `select c.id, c.post_id, p.platform, c.author_external_id, c.author_display_name,
              c.body, c.external_parent_comment_id, c.published_at, c.updated_at
       from comments c join posts p on p.id = c.post_id
       where c.account_id = $1 and c.post_id = $2 and p.platform = $3
       order by c.published_at asc, c.id asc
       limit $4 offset $5`,
      [context.accountId, query.postId, query.platform, query.limit + 1, offset],
    );
    const rows = result.rows.slice(0, query.limit);
    const hasMore = result.rows.length > query.limit;
    return {
      items: rows.map(toComment),
      pagination: { hasMore, nextCursor: hasMore ? encodeCursor(offset + query.limit) : null },
    };
  }

  public async findById(context: TenantContext, commentId: string): Promise<Comment | null> {
    const result = await this.db.query<CommentRow>(
      `select c.id, c.post_id, p.platform, c.author_external_id, c.author_display_name,
              c.body, c.external_parent_comment_id, c.published_at, c.updated_at
       from comments c join posts p on p.id = c.post_id
       where c.id = $1 and c.account_id = $2`,
      [commentId, context.accountId],
    );
    const row = result.rows[0];
    return row ? toComment(row) : null;
  }

  public async upsert(context: TenantContext, comment: Comment): Promise<Comment> {
    const result = await this.db.query<CommentRow>(
      `insert into comments
         (id, account_id, post_id, social_account_id, external_comment_id,
          external_parent_comment_id, author_external_id, author_display_name,
          body, published_at, updated_at)
       select $1, $2, p.id, p.social_account_id, $3, $4, $5, $6, $7, $8, $9
       from posts p where p.id = $10 and p.account_id = $2
       on conflict (social_account_id, external_comment_id) do update set
         body = excluded.body, author_display_name = excluded.author_display_name,
         external_parent_comment_id = excluded.external_parent_comment_id,
         updated_at = excluded.updated_at, last_seen_at = now()
       returning id, post_id, (select platform from posts where id = post_id) as platform,
         author_external_id, author_display_name, body, external_parent_comment_id,
         published_at, updated_at`,
      [
        comment.id,
        context.accountId,
        comment.id,
        comment.parentCommentId,
        comment.author.id,
        comment.author.displayName,
        comment.body,
        comment.publishedAt,
        comment.updatedAt,
        comment.postId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new ServiceError('POST_NOT_FOUND', 'The comment post was not found.', 404);
    return toComment(row);
  }
}

export class PostgresReplyOperationRepository implements ReplyOperationRepository {
  public constructor(private readonly db: TransactionalSqlExecutor) {}

  public async findByIdempotencyKey(
    context: TenantContext,
    key: string,
  ): Promise<ReplyOperation | null> {
    const result = await this.db.query<OperationRow>(
      `select id, account_id, comment_id, idempotency_key, request_fingerprint, status,
              resulting_comment_id, failure_code, created_at, completed_at
       from reply_operations where account_id = $1 and idempotency_key = $2`,
      [context.accountId, key],
    );
    return result.rows[0] ?? null;
  }

  public async createPending(
    context: TenantContext,
    operation: Omit<ReplyOperation, 'accountId'>,
  ): Promise<ReplyOperation> {
    const result = await this.db.query<OperationRow>(
      `insert into reply_operations
         (id, account_id, comment_id, idempotency_key, request_fingerprint, status,
          resulting_comment_id, failure_code, created_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (account_id, idempotency_key) do update set id = reply_operations.id
       returning id, account_id, comment_id, idempotency_key, request_fingerprint, status,
         resulting_comment_id, failure_code, created_at, completed_at`,
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
    const row = result.rows[0];
    if (!row)
      throw new ServiceError('INVALID_REQUEST', 'Reply operation could not be created.', 500);
    return row;
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
    return this.update(context, operationId, [null, 'failed', failureCode, null]);
  }

  private async update(
    context: TenantContext,
    operationId: string,
    values: readonly unknown[],
  ): Promise<ReplyOperation> {
    const result = await this.db.query<OperationRow>(
      `update reply_operations set resulting_comment_id = $1, status = $2,
         failure_code = $3, completed_at = $4
       where id = $5 and account_id = $6
       returning id, account_id, comment_id, idempotency_key, request_fingerprint, status,
         resulting_comment_id, failure_code, created_at, completed_at`,
      [...values, operationId, context.accountId],
    );
    const row = result.rows[0];
    if (!row) throw new ServiceError('INVALID_REQUEST', 'Reply operation was not found.', 500);
    return row;
  }
}
