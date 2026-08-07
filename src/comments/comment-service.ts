import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  NotFoundError,
  ProviderCursorRejectedError,
  ReplyDepthExceededError,
  ReplyOutcomeUnknownError,
  ServiceError,
  toFailureCode,
} from '../shared/errors.js';
import { decodeCursor, encodeCursor } from '../shared/cursor.js';
import {
  validateListCommentsQuery,
  validatePagination,
  validateReplyToCommentCommand,
} from '../shared/validation.js';
import {
  noopLogger,
  noopMetrics,
  type LogFields,
  type Logger,
  type Metrics,
} from '../shared/observability.js';
import { requireCapability } from '../platforms/provider-registry.js';
import type { Comment, PageCursor, PublishedPost, RequestContext } from '../shared/types.js';
import type { ReplyOperation } from '../shared/types.js';
import type {
  CommentRepository,
  ListCommentsQuery,
  ListCommentsResult,
  PlatformProviderRegistry,
  PostRepository,
  PostSnapshotState,
  ReplyOperationRepository,
  ReplyToCommentCommand,
} from './contracts.js';

export interface ListCommentsRequest {
  limit: number;
  cursor?: PageCursor;
}

/**
 * Bounds how many provider calls one request may make. Completing a snapshot is
 * what makes pagination stable, but it must not become unbounded work inside a
 * single read: past the bound the caller is told there is more and the next
 * request continues (Spec-014).
 */
const MAX_HYDRATIONS_PER_REQUEST = 20;

/** Page size requested from a provider while completing a snapshot. */
const PROVIDER_PAGE_LIMIT = 100;

const DEFAULT_SNAPSHOT_LIFETIME_SECONDS = 300;

/**
 * How long a claimed idempotency key stays claimed (Spec-015).
 *
 * This used to be justified by "the HTTP request timeout is 30 seconds, so
 * nothing can outlive it." That bound does not hold: Fastify's `requestTimeout`
 * destroys the socket, it does not stop the handler, which keeps running with
 * nobody left to answer. A lease that expires while its holder is still working
 * lets a second caller take the claim over and publish a duplicate reply, which
 * is the one outcome the claim exists to prevent.
 *
 * The bound that does hold is the work after the claim:
 *
 *   - one provider publish, bounded by the write policy's `timeoutMs`. One,
 *     not three — the write policy replays nothing at all (ADR-0015).
 *   - `recordPublished`, `storePublishedReply`, and `complete`: three database
 *     calls, each bounded by the pool's connection and query timeouts.
 *
 * The arithmetic is not done here, because it needs the provider policy and the
 * pool's budget and this module must not reach into persistence to get them
 * (ADR-0002). It is asserted in a test that may import both, so the relation
 * fails loudly if any of the three numbers moves (Spec-033).
 *
 * Too long and a crashed process blocks its key for that long, so the margin is
 * deliberate rather than generous.
 */
export const REPLY_LEASE_MS = 120_000;

/**
 * How long a request will wait for a hydration someone else started
 * (Spec-019).
 *
 * Bounded by what the joiner can afford rather than by what the work it joined
 * might take: the HTTP request timeout is thirty seconds, so a joiner that
 * waited for a full twenty-call run would time out having helped nobody. Past
 * this it answers from the snapshot it has, reporting `hasMore`.
 */
const HYDRATION_JOIN_WAIT_MS = 10_000;

/**
 * Whether a provider failure proves the reply was never published.
 *
 * Nothing observable on the reply path proves that any more.
 *
 * A rate limit used to qualify, on the reading that the provider declined to
 * process the request, so nothing went out and the key could be cleanly failed.
 * That holds for a 429 raised by the write handler itself. It does not hold for
 * a 429 raised by anything in front of it — a platform limiter, a CDN, a
 * gateway refusing on its own retry budget — any of which can answer 429 after
 * the origin already accepted and published the reply. The status code does not
 * say which happened.
 *
 * The consequence of guessing wrong ran in one direction only: `fail` makes
 * `replay` answer a retry with `idempotency_key_failed`, which tells the client
 * *retry with a new key*, and if the reply did go out that publishes a second
 * one under a customer's name. `unknown` tells the client not to retry, which
 * is wrong only in the cheap direction — a reply that was genuinely refused
 * needs an operator or a reconciliation pass rather than an automatic retry.
 *
 * So the list is empty, and is kept as a list rather than deleted into an
 * unexplained `markUnknown` at the call site: a provider adapter that can
 * genuinely prove a refusal — a 4xx raised by the write handler itself, with
 * the platform's own error code attached — adds one entry here, and the
 * reasoning it has to satisfy is written directly above it (ADR-0015,
 * Spec-026).
 */
const CODES_PROVING_REJECTION: readonly string[] = [];

function provesRejection(code: string): boolean {
  return CODES_PROVING_REJECTION.includes(code);
}

function snapshotLifetimeMs(): number {
  const configured = Number(process.env.SNAPSHOT_LIFETIME_SECONDS);
  const seconds =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SNAPSHOT_LIFETIME_SECONDS;
  return seconds * 1000;
}

/**
 * Binds an idempotency key to one request without storing the request.
 *
 * The body is user content and an audit row is the wrong place to keep it
 * (ADR-0011), so the row holds a digest instead. Unkeyed, that digest was a
 * weaker version of storing the body dressed as a stronger one: it sits beside
 * `comment_id` in the same row, so anyone who can read the table — a support
 * engineer, a backup, an analytics export — could confirm a guess at a short
 * reply with one hash, and "Thanks!" is a very small dictionary. Keying it
 * makes that impossible without the secret (Spec-023).
 *
 * Exported because it defines how a key binds to a request, which a test
 * constructing a realistic claim needs to reproduce rather than guess.
 */
export function requestFingerprint(commentId: string, body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${commentId}:${body}`, 'utf8').digest('hex');
}

/**
 * Compares two fingerprints without leaking where they diverge.
 *
 * One side is derived from attacker-influenced input, so the comparison is
 * timing-safe. Lengths are equal by construction; an unequal length means a
 * value that did not come from this function, which is a mismatch.
 */
function fingerprintsMatch(stored: string, computed: string): boolean {
  const left = Buffer.from(stored, 'utf8');
  const right = Buffer.from(computed, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Used when no secret is configured, which only happens outside production —
 * the composition refuses to start otherwise. Fixed and obviously fake, so
 * nobody can mistake it for a real one, and named in the startup log.
 */
export const developmentFingerprintSecret = 'development-only-unsafe-fingerprint-key';

const emptySnapshotState: PostSnapshotState = {
  providerCursor: null,
  exhausted: false,
  completedAt: null,
};

export class CommentService {
  /**
   * Hydrations running right now, keyed by tenant and post (Spec-019).
   *
   * Process-local mutable state, which this service otherwise has none of. It
   * belongs to the instance rather than the module so two compositions — two
   * tests, most often — cannot see each other's in-flight work. Deduplication
   * is therefore per replica: N replicas can still issue N hydrations, which is
   * judged good enough until there is evidence otherwise, because the factor
   * that matters is concurrent readers of one popular post and they mostly land
   * on the same process at once.
   */
  private readonly inFlight = new Map<
    string,
    Promise<{ state: PostSnapshotState; hydrations: number }>
  >();

  public constructor(
    private readonly comments: CommentRepository,
    private readonly posts: PostRepository,
    private readonly operations: ReplyOperationRepository,
    private readonly providers: PlatformProviderRegistry,
    private readonly metrics: Metrics = noopMetrics,
    private readonly logger: Logger = noopLogger,
    /**
     * Keys the idempotency fingerprint (Spec-023). Supplied by the
     * composition, which refuses to start in production without one.
     */
    private readonly fingerprintSecret: string = developmentFingerprintSecret,
  ) {}

  /**
   * Serves comments from the local snapshot, hydrating from the provider when
   * the snapshot cannot answer the requested position (Spec-008).
   */
  public async listComments(
    context: RequestContext,
    postId: string,
    request: ListCommentsRequest,
  ): Promise<ListCommentsResult> {
    const found = await this.posts.findPublishedById(context, postId);
    if (!found) throw new NotFoundError('POST_NOT_FOUND', 'The requested post was not found.');
    const { post, snapshot } = found;

    const cursor = decodeCursor(request.cursor);
    const query: ListCommentsQuery = {
      postId,
      platform: post.platform,
      limit: request.limit,
      ...(cursor.after === null ? {} : { after: cursor.after }),
    };
    validateListCommentsQuery(query);

    const startedAt = Date.now();
    try {
      // A snapshot completed long enough ago is read again from the start:
      // exhaustion without a lifetime hides every comment published since.
      let state = this.stale(snapshot) ? emptySnapshotState : snapshot;
      let page = await this.comments.listByPost(context, query);
      let hydrations = 0;
      let joined = false;

      // A pagination run must read a snapshot that does not move underneath it.
      // Provider order is not the service's order — Meta, X, and YouTube return
      // newest first, so later provider pages land behind an ascending keyset
      // and become unreachable for the rest of the run. Starting a run
      // therefore completes the snapshot first; continuing one only tops it up
      // when the page is short (Spec-014).
      const startingRun = cursor.after === null;
      if (this.needsHydration(state, startingRun, page.items.length, request.limit)) {
        // K readers arriving together on a cold post used to run K copies of
        // the whole loop, which against a rate-limited provider is the shape of
        // an outage: the first burst on a popular post is exactly when load is
        // highest (Spec-019).
        const inFlight = this.inFlight.get(this.postKey(context, postId));
        if (inFlight) {
          joined = true;
          state = await this.joinHydration(context, post, inFlight, state);
        } else {
          const run = this.runHydration(context, post, state, snapshot, {
            startingRun,
            limit: request.limit,
            query,
          });
          this.inFlight.set(this.postKey(context, postId), run);
          try {
            const outcome = await run;
            state = outcome.state;
            hydrations = outcome.hydrations;
          } finally {
            // Cleared whatever happened, so a failed hydration does not leave
            // the post marked in flight forever.
            this.inFlight.delete(this.postKey(context, postId));
          }
          this.metrics.increment('comments.list.hydration_started', { platform: post.platform });
        }
        page = await this.comments.listByPost(context, query);
      }

      const last = page.items[page.items.length - 1];
      // Completeness decides this, not whether this page happened to fill.
      const hasMore = page.hasMore || !state.exhausted;

      // A run that began before the snapshot was complete can never see what
      // the snapshot backfills behind its cursor. Providers return newest
      // first, so a bounded hydration leaves this run holding the newest
      // comments and every later page lands *older* — behind an ascending
      // keyset, and therefore unreachable for the rest of the run (Spec-021).
      //
      // The flag rides the cursor because it describes the run, not the post:
      // by the time the run ends the snapshot is usually complete, and the run
      // has still missed everything that arrived behind it.
      const partialRun = startingRun ? !state.exhausted : cursor.partialRun;

      const pagination = {
        hasMore,
        nextCursor: hasMore
          ? encodeCursor({
              // With nothing returned, the caller keeps its position and comes
              // back; each request advances the snapshot.
              after: last ? { publishedAt: last.publishedAt, id: last.id } : cursor.after,
              partialRun,
            })
          : null,
      };
      // A defensive assertion no test can kill, deliberately kept (Spec-025).
      // `hasMore` and `nextCursor` are built from one expression above, so the
      // service cannot currently produce the inconsistent pair this rejects —
      // which means removing it breaks nothing and no test can prove
      // otherwise. It stays because the pair is easy to separate in a later
      // edit, and because a client that receives `hasMore: true` with a null
      // cursor ends its run silently. Recorded here rather than left as an
      // unexplained line, and noted in docs/testing.md.
      validatePagination(pagination);

      const durationMs = Date.now() - startedAt;
      this.metrics.increment('comments.list.success', { platform: post.platform });
      this.metrics.observe('comments.list.duration_ms', durationMs, { platform: post.platform });
      this.logger.info(
        hydrations > 0 || joined ? 'comments.list.hydrated' : 'comments.list.served_from_cache',
        {
          ...this.trace(context),
          postId,
          platform: post.platform,
          returned: page.items.length,
          hasMore,
          hydrations,
          joined,
          partialRun,
          durationMs,
        },
      );
      return {
        items: page.items,
        pagination,
        // Reported as of this run, not as of the post. A partial run keeps
        // reporting `null` even once the snapshot finishes underneath it,
        // because the run itself was never served a complete one — and a run
        // that ends on `null` is the contract's signal to start again.
        snapshot: { syncedAt: partialRun ? null : state.completedAt },
      };
    } catch (error) {
      const code = toFailureCode(error);
      this.metrics.increment('comments.list.failure', { platform: post.platform, code });
      this.logger.warn('comments.list.failed', {
        ...this.trace(context),
        postId,
        platform: post.platform,
        code,
      });
      throw error;
    }
  }

  public async replyToComment(
    context: RequestContext,
    commentId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Comment> {
    const command: ReplyToCommentCommand = { commentId, body, idempotencyKey };
    validateReplyToCommentCommand(command);
    const fingerprint = requestFingerprint(commentId, body, this.fingerprintSecret);

    const previous = await this.operations.findByIdempotencyKey(context, idempotencyKey);
    if (previous) {
      const replayed = await this.replay(context, previous, fingerprint);
      if (replayed) {
        this.metrics.increment('comments.reply.replayed', { platform: replayed.platform });
        this.logger.info('comments.reply.replayed', {
          ...this.trace(context),
          commentId,
          replyId: replayed.id,
        });
        return replayed;
      }
    }

    const comment = await this.comments.findById(context, commentId);
    if (!comment) {
      // Counted here too: a dashboard that only sees post-claim failures
      // undercounts exactly the outage worth alerting on.
      this.metrics.increment('comments.reply.failure', { code: 'COMMENT_NOT_FOUND' });
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The requested comment was not found.');
    }
    // One level is a normalisation this service chose, not a platform rule
    // (ADR-0014): X and Facebook nest arbitrarily. The stored parent already
    // says whether it is itself a reply, so enforcing it costs no round trip.
    //
    // `parentUnresolved` is the third answer. The provider said this comment
    // answers something, and the service has not stored that something yet — so
    // it *is* a reply, and replying to it would publish the two-level thread
    // this rule exists to prevent. Reading the join's null as "no parent" let
    // exactly that through, and systematically rather than rarely: newest-first
    // providers deliver replies before their parents, so on any post large
    // enough to paginate this was the common case, not the rare one (ADR-0016).
    if (comment.parentCommentId !== null || comment.parentUnresolved) {
      this.metrics.increment('comments.reply.failure', {
        platform: comment.platform,
        code: 'REPLY_DEPTH_EXCEEDED',
      });
      throw new ReplyDepthExceededError();
    }

    const postRecord = await this.posts.findPublishedById(context, comment.postId);
    if (!postRecord) {
      throw new NotFoundError('POST_NOT_FOUND', 'The post for this comment was not found.');
    }
    const post = postRecord.post;
    const parentExternalCommentId = await this.comments.resolveExternalId(context, commentId);
    if (parentExternalCommentId === null) {
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The requested comment was not found.');
    }

    const provider = this.providers.get(comment.platform);
    requireCapability(provider, 'reply_to_comment');

    const now = Date.now();
    const claim = await this.operations.claim(context, {
      id: crypto.randomUUID(),
      commentId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      status: 'pending',
      resultingCommentId: null,
      failureCode: null,
      leaseExpiresAt: new Date(now + REPLY_LEASE_MS).toISOString(),
      externalReplyId: null,
      createdAt: new Date(now).toISOString(),
      completedAt: null,
    });
    if (!claim.claimed) {
      const replayed = await this.replay(context, claim.operation, fingerprint);
      if (replayed) {
        this.metrics.increment('comments.reply.replayed', { platform: comment.platform });
        this.logger.info('comments.reply.replayed', {
          ...this.trace(context),
          commentId,
          replyId: replayed.id,
          reason: 'concurrent',
        });
        return replayed;
      }
      this.metrics.increment('comments.reply.duplicate_attempted', { platform: comment.platform });
      this.logger.warn('comments.reply.conflict', {
        ...this.trace(context),
        commentId,
        platform: comment.platform,
        reason: 'in_progress',
      });
      throw new ServiceError(
        'IDEMPOTENCY_CONFLICT',
        'idempotency_key_in_flight',
        'A reply for this idempotency key is already in progress.',
        409,
      );
    }

    const startedAt = Date.now();

    // Only a provider failure may mark the operation failed. Everything after
    // this point has a published reply behind it, and recording that as failed
    // would tell the client to retry with a new key and publish a second reply
    // under someone else's name.
    let reply;
    try {
      reply = await provider.replyToComment({
        post,
        connection: post.connection,
        parentExternalCommentId,
        body,
      });
    } catch (error) {
      const failureCode = toFailureCode(error);
      // A refusal is failed and a silence is unknown. They ask the client for
      // different things, and before they were the same state (Spec-015).
      if (provesRejection(failureCode)) {
        await this.operations.fail(context, claim.operation.id, failureCode);
      } else {
        await this.operations.markUnknown(context, claim.operation.id, failureCode);
      }
      this.metrics.increment('comments.reply.failure', {
        platform: comment.platform,
        code: failureCode,
      });
      if (failureCode === 'PROVIDER_UNAVAILABLE') {
        this.metrics.increment('comments.reply.timeout', { platform: comment.platform });
      }
      if (failureCode === 'PROVIDER_RATE_LIMITED') {
        this.metrics.increment('comments.reply.rate_limited', { platform: comment.platform });
      }
      this.logger.warn('comments.reply.failed', {
        ...this.trace(context),
        commentId,
        platform: comment.platform,
        code: failureCode,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    // From here the reply exists at the provider. Record where, before doing
    // anything that can fail: this is the only thing that later distinguishes
    // "published and stored, completion lost" — which recovers — from
    // "published and gone", which does not.
    let stored;
    try {
      await this.operations.recordPublished(context, claim.operation.id, reply.externalId);
      // Not `upsertMany`: hydration's conflict clause overwrites `body`, which
      // on an identifier collision replaced a customer's own comment with the
      // reply text (Spec-027).
      stored = await this.comments.storePublishedReply(context, reply);
      if (!stored) {
        throw new ServiceError(
          'INTERNAL_ERROR',
          'reply_not_stored',
          'The published reply could not be stored.',
          500,
        );
      }
    } catch (error) {
      // Nothing was stored. The outcome is not failed — a reply was published —
      // and not pending, because no later request can resolve it. It is
      // unknown, which is the state that says a human should look.
      await this.operations
        .markUnknown(context, claim.operation.id, 'REPLY_OUTCOME_UNKNOWN')
        .catch(() => undefined);
      this.metrics.increment('comments.reply.orphaned', { platform: comment.platform });
      this.logger.error('comments.reply.orphaned', {
        ...this.trace(context),
        commentId,
        platform: comment.platform,
        // The provider's own identifier, so an operator can find the reply that
        // exists without having to guess.
        externalReplyId: reply.externalId,
        code: toFailureCode(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    try {
      await this.operations.complete(context, claim.operation.id, stored.id);
    } catch (error) {
      // The reply is published and stored; only the record of that is missing.
      // The operation stays pending on purpose, because the next request for
      // this key can reconcile it from the stored reply.
      this.metrics.increment('comments.reply.unreconciled', { platform: comment.platform });
      this.logger.error('comments.reply.unreconciled', {
        ...this.trace(context),
        commentId,
        platform: comment.platform,
        replyId: stored.id,
        code: toFailureCode(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    this.metrics.increment('comments.reply.success', { platform: comment.platform });
    this.logger.info('comments.reply.published', {
      ...this.trace(context),
      commentId,
      replyId: stored.id,
      platform: comment.platform,
      // Length rather than content: reply bodies are user data (ADR-0011).
      bodyLength: body.length,
      durationMs: Date.now() - startedAt,
    });
    return stored;
  }

  /**
   * Key for the in-flight map. The delimiter is written as an escape rather
   * than as a literal control character: a raw NUL byte in the source makes git
   * and grep classify this file as binary, which silently excludes the largest
   * file in the repository from every text search, including secret scans over
   * `git log -p`. NUL is still the right delimiter — it cannot occur in an
   * account identifier or a post identifier, so the key cannot be forged by
   * one value ending where the next begins.
   */
  private postKey(context: RequestContext, postId: string): string {
    return `${context.accountId}\u0000${postId}`;
  }

  /** Whether this request would read the provider if nothing else were. */
  private needsHydration(
    state: PostSnapshotState,
    startingRun: boolean,
    returned: number,
    limit: number,
  ): boolean {
    return !state.exhausted && (startingRun || returned < limit);
  }

  /**
   * Completes the snapshot, bounded, and reports how far it got.
   *
   * `expected` is what the database held when this request read it, which is
   * not always the state hydration starts from: a stale snapshot restarts the
   * stream while the stored row still says exhausted. The compare-and-set has
   * to be against what is stored, not against where this run began.
   */
  private async runHydration(
    context: RequestContext,
    post: PublishedPost,
    from: PostSnapshotState,
    stored: PostSnapshotState,
    request: { startingRun: boolean; limit: number; query: ListCommentsQuery },
  ): Promise<{ state: PostSnapshotState; hydrations: number }> {
    let state = from;
    let expected = stored;
    let hydrations = 0;
    let returned = (await this.comments.listByPost(context, request.query)).items.length;

    while (
      this.needsHydration(state, request.startingRun, returned, request.limit) &&
      hydrations < MAX_HYDRATIONS_PER_REQUEST
    ) {
      const next = await this.hydrate(context, post, state);
      const won = await this.posts.saveSnapshotState(context, post.id, next, expected);
      hydrations += 1;
      if (!won) {
        // Another hydration advanced the snapshot first. Keeping the newer
        // state and stopping is deliberate: retrying against a moving target
        // loops under sustained concurrency, and the rows this run fetched are
        // already stored either way.
        this.metrics.increment('comments.list.snapshot_conflict', { platform: post.platform });
        this.logger.info('comments.snapshot.conflict', {
          ...this.trace(context),
          postId: post.id,
          platform: post.platform,
        });
        const current = await this.posts.findPublishedById(context, post.id);
        return { state: current?.snapshot ?? next, hydrations };
      }
      state = next;
      expected = next;
      returned = (await this.comments.listByPost(context, request.query)).items.length;
    }

    return { state, hydrations };
  }

  /**
   * Waits for a hydration already running for this post, but not longer than a
   * caller can afford.
   *
   * Past the bound the joiner answers from the snapshot it has. That is a
   * knowingly incomplete page, reported as such by `hasMore` — which is a
   * better outcome than holding a request until its own timeout, having helped
   * nobody.
   *
   * The originator's *failure* is treated the same way, and used not to be. The
   * joined promise was raced with no `catch`, so a provider error reached every
   * reader waiting on it: K readers arriving on a cold post all received 503,
   * each while holding a perfectly serviceable snapshot they could have been
   * served from. Single-flight is a load optimisation, and it had quietly turned
   * one upstream failure into a fan-out of them. A joiner did not make the call
   * that failed and has no more reason to fail than it does to wait forever
   * (Spec-029).
   */
  private async joinHydration(
    context: RequestContext,
    post: PublishedPost,
    inFlight: Promise<{ state: PostSnapshotState; hydrations: number }>,
    fallback: PostSnapshotState,
  ): Promise<PostSnapshotState> {
    const waitedFrom = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<PostSnapshotState>((resolve) => {
      timer = setTimeout(() => resolve(fallback), HYDRATION_JOIN_WAIT_MS);
    });
    let joinFailed = false;
    try {
      const state = await Promise.race([
        inFlight.then(
          (outcome) => outcome.state,
          (error: unknown) => {
            // The originator's failure ends this joiner's wait; it does not
            // become this joiner's failure.
            joinFailed = true;
            this.metrics.increment('comments.list.hydration_join_failed', {
              platform: post.platform,
            });
            this.logger.warn('comments.list.hydration_join_failed', {
              ...this.trace(context),
              postId: post.id,
              platform: post.platform,
              code: toFailureCode(error),
              waitedMs: Date.now() - waitedFrom,
            });
            return fallback;
          },
        ),
        bounded,
      ]);
      if (joinFailed) return state;
      this.metrics.increment('comments.list.hydration_joined', { platform: post.platform });
      this.metrics.observe('comments.list.hydration_wait_ms', Date.now() - waitedFrom, {
        platform: post.platform,
      });
      this.logger.info('comments.list.hydration_joined', {
        ...this.trace(context),
        postId: post.id,
        platform: post.platform,
        waitedMs: Date.now() - waitedFrom,
      });
      return state;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Reads the next provider page into the snapshot and reports how far the
   * stream has been consumed.
   *
   * A stored continuation is best-effort: vendors document that cursors must
   * not be stored, because one is invalidated when the item it points at is
   * deleted. A rejected cursor therefore restarts the stream rather than
   * failing the read, which is safe because re-reading deduplicates on
   * `(social_account_id, external_comment_id)` (Spec-014).
   */
  private async hydrate(
    context: RequestContext,
    post: PublishedPost,
    state: PostSnapshotState,
  ): Promise<PostSnapshotState> {
    const provider = this.providers.get(post.platform);
    requireCapability(provider, 'list_comments');
    const startedAt = Date.now();

    let page;
    try {
      page = await this.fetchPage(provider, post, state.providerCursor);
    } catch (error) {
      if (!(error instanceof ProviderCursorRejectedError)) throw error;
      this.metrics.increment('comments.list.cursor_rejected', { platform: post.platform });
      this.logger.warn('provider.cursor.rejected', {
        ...this.trace(context),
        platform: post.platform,
        postId: post.id,
      });
      page = await this.fetchPage(provider, post, null);
    }

    if (page.items.length > 0) await this.comments.upsertMany(context, page.items);
    this.metrics.increment('comments.list.hydrated', { platform: post.platform });
    this.logger.info('provider.list.completed', {
      ...this.trace(context),
      platform: post.platform,
      postId: post.id,
      fetched: page.items.length,
      hasMore: page.hasMore,
      durationMs: Date.now() - startedAt,
    });

    return page.hasMore
      ? { providerCursor: page.nextProviderCursor, exhausted: false, completedAt: null }
      : { providerCursor: null, exhausted: true, completedAt: new Date().toISOString() };
  }

  private async fetchPage(
    provider: ReturnType<PlatformProviderRegistry['get']>,
    post: PublishedPost,
    providerCursor: string | null,
  ) {
    return provider.listComments({
      post,
      connection: post.connection,
      limit: PROVIDER_PAGE_LIMIT,
      ...(providerCursor === null ? {} : { providerCursor }),
    });
  }

  /** True when a completed snapshot is old enough to be worth reading again. */
  private stale(state: PostSnapshotState): boolean {
    if (!state.exhausted || state.completedAt === null) return false;
    return Date.now() - Date.parse(state.completedAt) > snapshotLifetimeMs();
  }

  private trace(context: RequestContext): LogFields {
    return { requestId: context.requestId, accountId: context.accountId };
  }

  /**
   * Resolves a repeated idempotency key, recovering the operation where it can.
   *
   * A key is bound to one request body. A failed key is terminal because the
   * provider refused it; an unknown key is terminal because nobody knows what
   * the provider did. Returning null means the key is genuinely in flight and
   * the caller should be told so.
   */
  private async replay(
    context: RequestContext,
    operation: ReplyOperation,
    fingerprint: string,
  ): Promise<Comment | null> {
    if (!fingerprintsMatch(operation.requestFingerprint, fingerprint)) {
      throw new ServiceError(
        'IDEMPOTENCY_CONFLICT',
        'idempotency_key_body_mismatch',
        'The idempotency key was already used for a different request.',
        409,
      );
    }
    if (operation.status === 'completed' && operation.resultingCommentId !== null) {
      const stored = await this.comments.findById(context, operation.resultingCommentId);
      if (stored) return stored;
    }
    if (operation.status === 'failed') {
      throw new ServiceError(
        'IDEMPOTENCY_CONFLICT',
        'idempotency_key_failed',
        'This idempotency key already failed; retry with a new key.',
        409,
      );
    }
    if (operation.status === 'unknown') throw unknownOutcome();
    if (operation.status === 'pending') return this.recover(context, operation);
    return null;
  }

  /**
   * Decides what a pending operation actually is.
   *
   * Three cases hide behind `pending`. The reply was published and stored and
   * only the completion was lost, which self-heals here without touching the
   * provider. The lease has expired, so the process that held it is gone and
   * the outcome cannot be established — that becomes `unknown` rather than
   * being retried, because an expired lease does not prove the provider was
   * never reached. Or the work is genuinely in flight, which is the only case
   * that returns null.
   */
  private async recover(
    context: RequestContext,
    operation: ReplyOperation,
  ): Promise<Comment | null> {
    if (operation.externalReplyId !== null) {
      // The operation's parent comment names the connection the reply went out
      // through, which is the scope the provider identifier is unique within
      // (Spec-024).
      const stored = await this.comments.findReplyByExternalId(
        context,
        operation.commentId,
        operation.externalReplyId,
      );
      if (stored) {
        await this.operations.complete(context, operation.id, stored.id);
        this.metrics.increment('comments.reply.reconciled');
        this.logger.info('comments.reply.reconciled', {
          ...this.trace(context),
          commentId: operation.commentId,
          replyId: stored.id,
        });
        return stored;
      }
    }

    // Checked only once the reply is known not to be stored: a live request may
    // be between its publish and its write, and resolving it from underneath
    // would be worse than making its caller wait.
    if (Date.parse(operation.leaseExpiresAt) > Date.now()) return null;

    await this.operations.markUnknown(context, operation.id, 'REPLY_OUTCOME_UNKNOWN');
    this.metrics.increment('comments.reply.lease_expired');
    this.logger.warn('comments.reply.lease_expired', {
      ...this.trace(context),
      commentId: operation.commentId,
      ...(operation.externalReplyId === null ? {} : { externalReplyId: operation.externalReplyId }),
    });
    throw unknownOutcome();
  }
}

function unknownOutcome(): ReplyOutcomeUnknownError {
  return new ReplyOutcomeUnknownError(
    'The outcome of this reply could not be established; a reply may have been published. Do not retry with a new key.',
  );
}
