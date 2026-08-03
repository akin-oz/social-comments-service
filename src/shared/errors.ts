export type ServiceErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'POST_NOT_FOUND'
  | 'COMMENT_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_REQUEST';

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
