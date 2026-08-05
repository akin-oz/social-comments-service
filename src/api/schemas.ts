/**
 * JSON Schema for the public REST contract.
 *
 * These are the source the OpenAPI document is generated from (Spec-011), and
 * Fastify also uses the response entries to serialize. A property absent here
 * is absent from the response, which is what keeps provider identifiers from
 * reaching a client even if one is added to the domain model later.
 */

export const platformValues = ['facebook', 'instagram', 'linkedin', 'x', 'youtube'] as const;

export const errorCodeValues = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'POST_NOT_FOUND',
  'COMMENT_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'UNSUPPORTED_CAPABILITY',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_ERROR',
  'PROVIDER_UNAVAILABLE',
  'INVALID_CURSOR',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
] as const;

export const commentSchema = {
  $id: 'Comment',
  type: 'object',
  title: 'Comment',
  description: 'A normalized comment. Provider identifiers are never exposed.',
  required: [
    'id',
    'postId',
    'platform',
    'author',
    'body',
    'parentCommentId',
    'publishedAt',
    'updatedAt',
  ],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description: 'Service-owned identifier, assigned by persistence (ADR-0013).',
    },
    postId: { type: 'string', description: 'Internal identifier of the published post.' },
    platform: { type: 'string', enum: platformValues },
    author: {
      type: 'object',
      required: ['id', 'displayName'],
      additionalProperties: false,
      properties: {
        id: {
          type: 'string',
          description:
            "The provider's author identifier. Authors are not resources this service owns, so this is the one provider-issued value the contract exposes.",
        },
        displayName: { type: 'string' },
        profileUrl: { type: 'string' },
      },
    },
    body: { type: 'string' },
    parentCommentId: {
      type: ['string', 'null'],
      description: 'Parent comment, or null for a top-level comment.',
    },
    publishedAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const paginationSchema = {
  $id: 'Pagination',
  type: 'object',
  title: 'Pagination',
  required: ['nextCursor', 'hasMore'],
  additionalProperties: false,
  properties: {
    nextCursor: {
      type: ['string', 'null'],
      description: 'Opaque cursor for the next page. Clients must not decode or construct it.',
    },
    hasMore: { type: 'boolean' },
  },
} as const;

export const snapshotSchema = {
  $id: 'Snapshot',
  type: 'object',
  title: 'Snapshot',
  description: 'How current the local snapshot of this post is.',
  required: ['syncedAt'],
  additionalProperties: false,
  properties: {
    syncedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      description:
        'When this post was last read through to the end at the provider, or null if it never has been. Comments published since may not be present.',
    },
  },
} as const;

export const errorSchema = {
  $id: 'Error',
  type: 'object',
  title: 'Error',
  required: ['error'],
  additionalProperties: false,
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      additionalProperties: false,
      properties: {
        code: { type: 'string', enum: errorCodeValues },
        message: { type: 'string' },
        requestId: {
          type: 'string',
          description: 'Correlates the response with the service log record.',
        },
      },
    },
  },
} as const;

export const sharedSchemas = [commentSchema, paginationSchema, snapshotSchema, errorSchema];

const errorDescriptions: Readonly<Record<number, string>> = {
  400: 'The request cannot be parsed or validated.',
  401: 'Caller credentials are missing or invalid.',
  403: 'The caller cannot access the account or post.',
  404: 'The resource is not visible in the caller scope.',
  409: 'The idempotency key cannot be honoured.',
  422: 'The provider cannot perform the requested operation.',
  429: 'A provider or service rate limit was reached.',
  500: 'An unexpected failure occurred inside the service.',
  502: 'The provider returned an upstream failure.',
  503: 'The provider is temporarily unavailable.',
};

/** Builds the response map for the documented failure statuses of an operation. */
export function errorResponses(statuses: readonly number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      { description: errorDescriptions[status] ?? 'Request failed.', $ref: 'Error#' },
    ]),
  );
}
