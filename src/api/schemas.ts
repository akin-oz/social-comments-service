/**
 * JSON Schema for the public REST contract.
 *
 * These are the source the OpenAPI document is generated from (Spec-011), and
 * Fastify also uses the response entries to serialize. A property absent here
 * is absent from the response, which is what keeps provider identifiers from
 * reaching a client even if one is added to the domain model later.
 */

import { serviceErrorReasons } from '../shared/errors.js';

export const platformValues = ['facebook', 'instagram', 'linkedin', 'x', 'youtube'] as const;

export const errorCodeValues = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'POST_NOT_FOUND',
  'COMMENT_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'REPLY_OUTCOME_UNKNOWN',
  'REPLY_DEPTH_EXCEEDED',
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
  description:
    'A cursor is present exactly when there is more to read. Keep going while hasMore is true; a page may hold fewer items than the requested limit, and may hold none, without meaning the run is over.',
  required: ['nextCursor', 'hasMore'],
  additionalProperties: false,
  properties: {
    nextCursor: {
      type: ['string', 'null'],
      description:
        'Opaque cursor for the next page, non-null exactly when hasMore is true. Clients must not decode or construct it.',
    },
    hasMore: {
      type: 'boolean',
      description: 'Whether more comments exist, not whether this page happened to fill.',
    },
  },
  // Stated in the schema, not only in prose, so a generated client can see the
  // relationship rather than infer it (Spec-017). `oneOf` rather than
  // `allOf`/`if`/`then` because the response serializer resolves a `oneOf` by
  // validating the value against each branch, and cannot merge conditionals.
  oneOf: [
    {
      type: 'object',
      title: 'More to read',
      required: ['nextCursor', 'hasMore'],
      additionalProperties: false,
      properties: {
        nextCursor: { type: 'string' },
        hasMore: { const: true },
      },
    },
    {
      type: 'object',
      title: 'End of the run',
      required: ['nextCursor', 'hasMore'],
      additionalProperties: false,
      properties: {
        nextCursor: { type: 'null' },
        hasMore: { const: false },
      },
    },
  ],
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
  description:
    'Branch on code and reason. The message is for humans and its wording is not part of the contract.',
  required: ['error'],
  additionalProperties: false,
  properties: {
    error: {
      type: 'object',
      required: ['code', 'reason', 'message', 'requestId'],
      additionalProperties: false,
      properties: {
        code: { type: 'string', enum: errorCodeValues },
        reason: {
          type: 'string',
          enum: serviceErrorReasons,
          description:
            'Which situation behind the code this is, and therefore what to do next. Reasons are globally unique. A client must tolerate a reason it does not know: new members may be added within /v2.',
        },
        message: { type: 'string' },
        requestId: {
          type: 'string',
          description: 'Correlates the response with the service log record.',
        },
      },
    },
  },
  examples: [
    {
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        reason: 'idempotency_key_failed',
        message: 'This idempotency key already failed; retry with a new key.',
        requestId: 'req_abc123',
      },
    },
    {
      error: {
        code: 'REPLY_OUTCOME_UNKNOWN',
        reason: 'reply_outcome_unknown',
        message:
          'The outcome of this reply could not be established; a reply may have been published. Do not retry with a new key.',
        requestId: 'req_abc124',
      },
    },
  ],
} as const;

export const sharedSchemas = [commentSchema, paginationSchema, snapshotSchema, errorSchema];

const errorDescriptions: Readonly<Record<number, string>> = {
  400: 'The request cannot be parsed or validated.',
  401: 'Caller credentials are missing or invalid.',
  403: 'The caller cannot access the account or post.',
  404: 'The resource is not visible in the caller scope.',
  409: 'The idempotency key cannot be honoured.',
  422: 'The request is well formed but cannot be performed on this resource.',
  429: 'A provider or service rate limit was reached.',
  500: 'An unexpected failure occurred inside the service.',
  502: 'The provider returned an upstream failure.',
  503: 'The provider is temporarily unavailable.',
};

/**
 * `Retry-After` was described in prose and absent from the document, so a
 * generated client could not see it. Declared here it reaches both.
 */
const retryAfterHeader = {
  'retry-after': {
    type: 'string',
    description:
      "Seconds to wait before retrying, carrying the provider's own guidance when it supplied any.",
  },
} as const;

/** Builds the response map for the documented failure statuses of an operation. */
export function errorResponses(statuses: readonly number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: errorDescriptions[status] ?? 'Request failed.',
        $ref: 'Error#',
        ...(status === 429 ? { headers: retryAfterHeader } : {}),
      },
    ]),
  );
}
