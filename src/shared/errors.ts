export type ServiceErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'POST_NOT_FOUND'
  | 'COMMENT_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REPLY_DEPTH_EXCEEDED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_CURSOR'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR';

export class ServiceError extends Error {
  public constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    public readonly statusCode = 500,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class NotFoundError extends ServiceError {
  public constructor(code: 'POST_NOT_FOUND' | 'COMMENT_NOT_FOUND', message: string) {
    super(code, message, 404);
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
      'This service models one level of replies; the requested parent is itself a reply.',
      422,
    );
    this.name = 'ReplyDepthExceededError';
  }
}

/** The provider did not answer within its call budget, or refused the connection. */
export class ProviderUnavailableError extends ServiceError {
  public constructor(message: string) {
    super('PROVIDER_UNAVAILABLE', message, 503);
    this.name = 'ProviderUnavailableError';
  }
}

/** The provider returned an upstream failure that is not safe to retry blindly. */
export class ProviderError extends ServiceError {
  public constructor(message: string) {
    super('PROVIDER_ERROR', message, 502);
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
    super('PROVIDER_ERROR', message, 502);
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
    super('PROVIDER_RATE_LIMITED', message, 429);
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
