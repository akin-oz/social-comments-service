export type ServiceErrorCode =
  | 'UNAUTHENTICATED'
  // Reserved, not produced. A resource outside the caller's scope is a 404, so
  // that the caller is not told something exists which they may not see — which
  // leaves no situation that yields a 403. Kept declared because removing an
  // enum member is the one change the /v2 compatibility policy forbids.
  | 'FORBIDDEN'
  | 'POST_NOT_FOUND'
  | 'COMMENT_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REPLY_OUTCOME_UNKNOWN'
  | 'REPLY_DEPTH_EXCEEDED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_CURSOR'
  | 'INVALID_REQUEST'
  | 'ROUTE_NOT_FOUND'
  | 'INTERNAL_ERROR';

/**
 * What a client should do about an error, in a value rather than in prose
 * (Spec-017).
 *
 * The code says what happened; the reason says which of several situations
 * behind that code this is, and therefore what to do next. `IDEMPOTENCY_CONFLICT`
 * is the case that forced this: it covers a client bug, a request in flight, and
 * a terminal failure, and the only thing distinguishing them was English a
 * copy-edit could silently change.
 *
 * Reasons are globally unique, so a dashboard can group on reason alone. Once a
 * client branches on one, renaming it is a breaking change.
 */
export const serviceErrorReasons = [
  'missing_account_context',
  /** Reserved alongside `FORBIDDEN`; see the note on that code. */
  'account_not_permitted',
  'post_not_found',
  'comment_not_found',
  // The four idempotency situations, which is the point of the whole field.
  'idempotency_key_body_mismatch',
  'idempotency_key_in_flight',
  'idempotency_key_failed',
  'reply_outcome_unknown',
  'reply_depth_exceeded',
  'capability_unsupported',
  'platform_not_configured',
  'provider_rate_limited',
  'provider_upstream_error',
  'provider_cursor_rejected',
  'provider_unavailable',
  'cursor_not_issued_by_service',
  'request_validation_failed',
  'idempotency_key_missing',
  // Transport-level refusals. Separate from `request_validation_failed`
  // because the client action differs: shrink the body, or fix the encoding,
  // rather than fix a field (Spec-022).
  'request_body_too_large',
  'request_body_malformed',
  'route_not_found',
  'reply_not_stored',
  'internal_error',
] as const;

export type ServiceErrorReason = (typeof serviceErrorReasons)[number];

export class ServiceError extends Error {
  public constructor(
    public readonly code: ServiceErrorCode,
    public readonly reason: ServiceErrorReason,
    message: string,
    public readonly statusCode = 500,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class NotFoundError extends ServiceError {
  public constructor(code: 'POST_NOT_FOUND' | 'COMMENT_NOT_FOUND', message: string) {
    super(code, code === 'POST_NOT_FOUND' ? 'post_not_found' : 'comment_not_found', message, 404);
  }
}

/**
 * The reply may or may not exist at the provider, and this service cannot tell
 * (Spec-015).
 *
 * Deliberately not `IDEMPOTENCY_CONFLICT`: that code invites a retry with a new
 * key, and here a retry may publish a second reply under a customer's name. It
 * shares 409 with the other idempotency outcomes because it is one — the key is
 * terminal — but the action it asks for is different, so the code is different.
 */
export class ReplyOutcomeUnknownError extends ServiceError {
  public constructor(message: string) {
    super('REPLY_OUTCOME_UNKNOWN', 'reply_outcome_unknown', message, 409);
    this.name = 'ReplyOutcomeUnknownError';
  }
}

/**
 * The parent named by the request is itself a reply. One level is this
 * service's normalisation rather than any platform's rule (ADR-0014), so the
 * refusal is the service's own and is reported as such.
 */
export class ReplyDepthExceededError extends ServiceError {
  public constructor() {
    super(
      'REPLY_DEPTH_EXCEEDED',
      'reply_depth_exceeded',
      'This service models one level of replies; the requested parent is itself a reply.',
      422,
    );
    this.name = 'ReplyDepthExceededError';
  }
}

/** The provider did not answer within its call budget, or refused the connection. */
export class ProviderUnavailableError extends ServiceError {
  public constructor(message: string) {
    super('PROVIDER_UNAVAILABLE', 'provider_unavailable', message, 503);
    this.name = 'ProviderUnavailableError';
  }
}

/** The provider returned an upstream failure that is not safe to retry blindly. */
export class ProviderError extends ServiceError {
  public constructor(message: string) {
    super('PROVIDER_ERROR', 'provider_upstream_error', message, 502);
    this.name = 'ProviderError';
  }
}

/**
 * The provider refused a continuation token the service had stored. Vendors
 * document that cursors must not be stored, so this is expected rather than
 * exceptional: the stream restarts (Spec-014).
 */
export class ProviderCursorRejectedError extends ServiceError {
  public constructor(message: string) {
    super('PROVIDER_ERROR', 'provider_cursor_rejected', message, 502);
    this.name = 'ProviderCursorRejectedError';
  }
}

/**
 * The provider applied a rate limit. `retryAfterMs` carries the provider's own
 * guidance when it supplies one, so the caller is never told to guess.
 */
export class ProviderRateLimitError extends ServiceError {
  public constructor(
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super('PROVIDER_RATE_LIMITED', 'provider_rate_limited', message, 429);
    this.name = 'ProviderRateLimitError';
  }
}

/**
 * Maps an arbitrary failure to the documented error taxonomy so that audit
 * records store contract codes rather than class names.
 */
export function toFailureCode(error: unknown): ServiceErrorCode {
  if (error instanceof ServiceError) return error.code;
  return 'PROVIDER_ERROR';
}
