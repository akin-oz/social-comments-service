import { ServiceError } from '../shared/errors.js';
import { assertStoredComment, assertStoredReplyOperation } from '../shared/validation.js';
import { isIssuedTimestamp, isUuid } from '../shared/identifiers.js';
import type { Database, SqlSession } from './database.js';
import type {
  Comment,
  ObservedComment,
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
  /** The join's answer: which stored row is the parent, if one is stored. */
  parent_comment_id: string | null;
  /** What the provider said the parent is, whether or not it is stored. */
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
  social_account_id: string;
  credential_reference: string;
  provider_cursor: string | null;
  provider_exhausted: boolean;
  provider_completed_at: string | null;
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
  lease_expires_at: string;
  external_reply_id: string | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * PostgreSQL returns snake_case columns, so rows must be mapped rather than
 * cast. Casting silently yields `undefined` for every field, which made an
 * idempotent retry look like a different request.
 */
function toOperation(row: OperationRow): ReplyOperation {
  return assertStoredReplyOperation({
    id: row.id,
    accountId: row.account_id,
    commentId: row.comment_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    resultingCommentId: row.resulting_comment_id,
    failureCode: row.failure_code,
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    externalReplyId: row.external_reply_id,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  });
}

// Platform belongs to the social account, not the post, so every comment query
// reaches it through that join.
// `external_parent_comment_id` is selected alongside the resolved `parent.id`
// because the two together are what distinguish "no parent" from "parent not
// stored yet" — the join alone collapses them into one null (ADR-0016).
const commentColumns = `c.id, c.post_id, sa.platform, c.author_external_id, c.author_display_name,
         c.body, c.external_comment_id, parent.id as parent_comment_id,
         c.external_parent_comment_id, c.published_at, c.updated_at`;

// The parent is the row holding that provider identifier, resolved by the key
// that actually identifies it, rather than computed from it (ADR-0013).
const commentSource = `from comments c
         join posts p on p.id = c.post_id
         join social_accounts sa on sa.id = p.social_account_id
         left join comments parent
           on parent.social_account_id = c.social_account_id
          and parent.external_comment_id = c.external_parent_comment_id`;

const operationColumns = `id, account_id, comment_id, idempotency_key, request_fingerprint, status,
         resulting_comment_id, failure_code, lease_expires_at, external_reply_id,
         created_at, completed_at`;

function toComment(row: CommentRow): Comment {
  // Every comment this adapter returns passes through here, whichever query
  // produced it, which is why the guard belongs at the mapper rather than at
  // each call site (Spec-025).
  return assertStoredComment({
    id: row.id,
    postId: row.post_id,
    platform: row.platform,
    author: { id: row.author_external_id, displayName: row.author_display_name },
    body: row.body,
    parentCommentId: row.parent_comment_id,
    // The provider named a parent and the join found no row holding it.
    parentUnresolved: row.external_parent_comment_id !== null && row.parent_comment_id === null,
    publishedAt: new Date(row.published_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export class PostgresPostRepository implements PostRepository {
  public constructor(private readonly db: Database) {}

  public async findPublishedById(
    context: TenantContext,
    postId: string,
  ): Promise<PublishedPostRecord | null> {
    if (!isUuid(postId)) return null;
    return this.db.withTenant(context.accountId, async (tx) => {
      const result = await tx.query<PostRow>(
        // The social account is the authorised connection a provider call acts
        // as (Spec-016). The join was already here; only the columns are new.
        `select p.id, p.account_id, sa.platform, p.external_post_id, p.published_at,
                sa.id as social_account_id, sa.credential_reference,
                p.provider_cursor, p.provider_exhausted, p.provider_completed_at
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
          connection: {
            socialAccountId: row.social_account_id,
            platform: row.platform,
            credentialReference: row.credential_reference,
          },
        },
        snapshot: {
          providerCursor: row.provider_cursor,
          exhausted: row.provider_exhausted,
          completedAt:
            row.provider_completed_at === null
              ? null
              : new Date(row.provider_completed_at).toISOString(),
        },
      };
    });
  }

  public async saveSnapshotState(
    context: TenantContext,
    postId: string,
    state: PostSnapshotState,
    expected: PostSnapshotState,
  ): Promise<boolean> {
    return this.db.withTenant(context.accountId, async (tx) => {
      // `is not distinct from` rather than `=`, because the continuation is
      // null both before the first page and after the last, and `= null` never
      // matches.
      // `returning` rather than a row count, so the port stays a rows-only
      // contract and the caller still learns whether the compare matched.
      const result = await tx.query<{ id: string }>(
        `update posts set provider_cursor = $1, provider_exhausted = $2,
           provider_completed_at = $3
         where id = $4 and account_id = $5
           and provider_cursor is not distinct from $6
           and provider_exhausted = $7
         returning id`,
        [
          state.providerCursor,
          state.exhausted,
          state.completedAt,
          postId,
          context.accountId,
          expected.providerCursor,
          expected.exhausted,
        ],
      );
      return result.rows.length > 0;
    });
  }
}

export class PostgresCommentRepository implements CommentRepository {
  public constructor(private readonly db: Database) {}

  public async listByPost(context: TenantContext, query: ListCommentsQuery): Promise<CommentPage> {
    // A cursor the service issued always holds a UUID and the exact ISO instant
    // this service emits; a keyset holding neither cannot name a row, so the
    // page is empty rather than a failed cast. Both halves reach a typed cast,
    // and the timestamp is checked against the issued shape rather than
    // Date.parse, which accepts far more than ::timestamptz does (Spec-022,
    // second sweep).
    if (
      query.after !== undefined &&
      (!isUuid(query.after.id) || !isIssuedTimestamp(query.after.publishedAt))
    ) {
      return { items: [], hasMore: false };
    }
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
    if (!isUuid(commentId)) return null;
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

  public async findReplyByExternalId(
    context: TenantContext,
    siblingCommentId: string,
    externalId: string,
  ): Promise<Comment | null> {
    if (!isUuid(siblingCommentId)) return null;
    return this.db.withTenant(context.accountId, async (tx) => {
      // Scoped to the sibling's social account, which is the scope
      // `unique (social_account_id, external_comment_id)` guarantees. Scoping
      // by account alone returned an arbitrary row when a tenant held the same
      // provider identifier under two connections (Spec-024).
      const result = await tx.query<CommentRow>(
        `select ${commentColumns}
         ${commentSource}
         where c.account_id = $1
           and c.external_comment_id = $2
           and c.social_account_id = (
             select sibling.social_account_id from comments sibling
             where sibling.id = $3 and sibling.account_id = $1
           )`,
        [context.accountId, externalId, siblingCommentId],
      );
      const row = result.rows[0];
      return row ? toComment(row) : null;
    });
  }

  public async resolveExternalId(
    context: TenantContext,
    commentId: string,
  ): Promise<string | null> {
    if (!isUuid(commentId)) return null;
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
    observed: readonly ObservedComment[],
  ): Promise<readonly Comment[]> {
    if (observed.length === 0) return [];
    return this.db.withTenant(context.accountId, async (tx) => {
      for (const item of observed) await upsertComment(tx, context, item);
      // Read back after the whole batch is stored, so a reply that arrives
      // alongside its parent resolves against it, and so the identities are
      // the ones the database assigned rather than any the caller supplied.
      // Scoped to the post's social account as well as the account. Every
      // observation in a batch comes from one provider call and therefore one
      // connection, so this is currently safe either way — but "safe because
      // of how it happens to be called" is exactly what the parent-join
      // predicate looked like before a two-connection fixture made it
      // reachable (Spec-024).
      const result = await tx.query<CommentRow>(
        `select ${commentColumns}
         ${commentSource}
         where c.account_id = $1
           and c.external_comment_id = any($2::text[])
           and c.social_account_id = (
             select target.social_account_id from posts target
             where target.id = $3 and target.account_id = $1
           )`,
        [context.accountId, observed.map((item) => item.externalId), observed[0]!.postId],
      );
      return result.rows.map(toComment);
    });
  }

  public async storePublishedReply(
    context: TenantContext,
    reply: ObservedComment,
  ): Promise<Comment> {
    return this.db.withTenant(context.accountId, async (tx) => {
      // `do nothing` rather than hydration's `do update`: this call is creating
      // a row, so a conflict is never an edit to absorb (Spec-027).
      const inserted = await tx.query<{ id: string }>(
        `insert into comments
           (account_id, post_id, social_account_id, external_comment_id,
            external_parent_comment_id, author_external_id, author_display_name,
            body, published_at, updated_at)
         select $1, p.id, p.social_account_id, $2, $3, $4, $5, $6, $7, $8
         from posts p where p.id = $9 and p.account_id = $1
         on conflict (social_account_id, external_comment_id) do nothing
         returning id`,
        [
          context.accountId,
          reply.externalId,
          reply.externalParentCommentId,
          reply.author.id,
          reply.author.displayName,
          reply.body,
          reply.publishedAt,
          reply.updatedAt,
          reply.postId,
        ],
      );

      const readBack = async (id: string | null) => {
        const found = await tx.query<CommentRow>(
          `select ${commentColumns}
           ${commentSource}
           where c.account_id = $1
             ${id === null ? 'and c.external_comment_id = $2' : 'and c.id = $2'}
             and c.social_account_id = (
               select target.social_account_id from posts target
               where target.id = $3 and target.account_id = $1
             )`,
          [context.accountId, id ?? reply.externalId, reply.postId],
        );
        return found.rows[0];
      };

      const insertedId = inserted.rows[0]?.id;
      if (insertedId !== undefined) {
        const row = await readBack(insertedId);
        if (row) return toComment(row);
      }

      // Either the identifier was already present, or the post predicate
      // matched nothing. Which one decides the error the caller gets.
      const existing = await readBack(null);
      if (!existing) {
        throw new ServiceError(
          'POST_NOT_FOUND',
          'post_not_found',
          'The comment post was not found.',
          404,
        );
      }
      if (existing.body === reply.body) {
        // The same reply, stored twice — the recovery path doing its job.
        return toComment(existing);
      }
      // A published reply whose identifier names somebody else's comment. The
      // reply exists at the provider and cannot be stored coherently, which is
      // exactly what the operation's `unknown` outcome is for. Refusing here is
      // what keeps the customer's body intact.
      // Shares `reply_not_stored` with the service's own guard: same client
      // situation, same action, and the reason vocabulary should not grow a
      // member per internal cause (Spec-017).
      throw new ServiceError(
        'INTERNAL_ERROR',
        'reply_not_stored',
        'The published reply could not be stored.',
        500,
      );
    });
  }
}

async function upsertComment(
  tx: SqlSession,
  context: TenantContext,
  observed: ObservedComment,
): Promise<void> {
  // No identity is supplied: the column defaults to gen_random_uuid(), so two
  // tenants observing the same provider comment get two rows (ADR-0013).
  const result = await tx.query<{ id: string }>(
    `insert into comments
       (account_id, post_id, social_account_id, external_comment_id,
        external_parent_comment_id, author_external_id, author_display_name,
        body, published_at, updated_at)
     select $1, p.id, p.social_account_id, $2, $3, $4, $5, $6, $7, $8
     from posts p where p.id = $9 and p.account_id = $1
     on conflict (social_account_id, external_comment_id) do update set
       body = excluded.body,
       author_display_name = excluded.author_display_name,
       external_parent_comment_id = excluded.external_parent_comment_id,
       updated_at = excluded.updated_at,
       last_seen_at = now()
     returning id`,
    [
      context.accountId,
      observed.externalId,
      observed.externalParentCommentId,
      observed.author.id,
      observed.author.displayName,
      observed.body,
      observed.publishedAt,
      observed.updatedAt,
      observed.postId,
    ],
  );
  if (!result.rows[0]) {
    throw new ServiceError(
      'POST_NOT_FOUND',
      'post_not_found',
      'The comment post was not found.',
      404,
    );
  }
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
            resulting_comment_id, failure_code, lease_expires_at, external_reply_id,
            created_at, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
          operation.leaseExpiresAt,
          operation.externalReplyId,
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
        throw new ServiceError(
          'INTERNAL_ERROR',
          'internal_error',
          'Reply operation could not be claimed.',
          500,
        );
      }
      return { operation: toOperation(current), claimed: false };
    });
  }

  public async recordPublished(
    context: TenantContext,
    operationId: string,
    externalReplyId: string,
  ): Promise<ReplyOperation> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const result = await tx.query<OperationRow>(
        // Annotates an operation still in flight rather than moving it, so a
        // terminal row must not accept it either (Spec-028).
        `update reply_operations set external_reply_id = $1
         where id = $2 and account_id = $3 and status = 'pending'
         returning ${operationColumns}`,
        [externalReplyId, operationId, context.accountId],
      );
      const row = result.rows[0];
      if (!row)
        throw new ServiceError(
          'INTERNAL_ERROR',
          'internal_error',
          'Reply operation was not found.',
          500,
        );
      return toOperation(row);
    });
  }

  /**
   * Resolves an operation to the reply it published.
   *
   * `unknown` is an accepted starting point on purpose: reconciling an unknown
   * operation to its stored reply is the self-healing path Spec-015 exists for.
   * What the predicate excludes is a *terminal* outcome being overwritten by a
   * writer that finished late — without it, an operation that had already told
   * a client `unknown` was silently rewritten to `completed`, and the runbook
   * query for unknown operations then returned nothing while the customer who
   * raised the ticket was still holding it (Spec-028).
   *
   * `failure_code` is preserved rather than nulled, for the same reason: it is
   * the only remaining evidence of what the client was originally told.
   */
  public async complete(
    context: TenantContext,
    operationId: string,
    commentId: string,
  ): Promise<ReplyOperation> {
    return this.update(
      context,
      operationId,
      `set resulting_comment_id = $1, status = 'completed', completed_at = $2`,
      [commentId, new Date().toISOString()],
      ['pending', 'unknown'],
    );
  }

  /**
   * Only a pending operation may be failed. An operation that already reached
   * `unknown` must not be downgraded to `failed`, because `failed` is what
   * tells a client to retry with a new key — the one instruction that turns an
   * ambiguous outcome into a duplicate reply (ADR-0015).
   */
  public async fail(
    context: TenantContext,
    operationId: string,
    failureCode: string,
  ): Promise<ReplyOperation> {
    return this.update(
      context,
      operationId,
      `set resulting_comment_id = null, status = 'failed', failure_code = $1, completed_at = $2`,
      [failureCode, new Date().toISOString()],
      ['pending'],
    );
  }

  /**
   * Only a pending operation moves. Two callers may recover the same abandoned
   * operation at once, and neither may overwrite an outcome the other has
   * already established.
   */
  public async markUnknown(
    context: TenantContext,
    operationId: string,
    failureCode: string,
  ): Promise<ReplyOperation | null> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const result = await tx.query<OperationRow>(
        `update reply_operations set status = 'unknown', failure_code = $1, completed_at = $2
         where id = $3 and account_id = $4 and status = 'pending'
         returning ${operationColumns}`,
        [failureCode, new Date().toISOString(), operationId, context.accountId],
      );
      const row = result.rows[0];
      return row ? toOperation(row) : null;
    });
  }

  /**
   * Applies a state transition, refusing it unless the row is in one of the
   * statuses the transition accepts.
   *
   * The predicate used to be `id` and `account_id` only, which made every
   * transition a last-writer-wins overwrite of whatever outcome was already
   * recorded (Spec-028).
   */
  private async update(
    context: TenantContext,
    operationId: string,
    assignments: string,
    values: readonly unknown[],
    fromStatuses: readonly string[],
  ): Promise<ReplyOperation> {
    return this.db.withTenant(context.accountId, async (tx) => {
      const next = values.length;
      const result = await tx.query<OperationRow>(
        `update reply_operations ${assignments}
         where id = $${String(next + 1)} and account_id = $${String(next + 2)}
           and status = any($${String(next + 3)}::text[])
         returning ${operationColumns}`,
        [...values, operationId, context.accountId, fromStatuses],
      );
      const row = result.rows[0];
      if (!row) {
        // Either the operation does not exist, or it is already in a status
        // this transition may not leave. Both are this service disagreeing with
        // its own state machine, so both are internal faults.
        throw new ServiceError(
          'INTERNAL_ERROR',
          'internal_error',
          'Reply operation was not found in a state this transition accepts.',
          500,
        );
      }
      return toOperation(row);
    });
  }
}
