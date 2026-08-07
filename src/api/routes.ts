import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { DomainValidationError } from '../shared/validation.js';
import {
  ProviderRateLimitError,
  ServiceError,
  StoredRecordInvalidError,
  type ServiceErrorCode,
  type ServiceErrorReason,
} from '../shared/errors.js';
import { errorResponses, sharedSchemas } from './schemas.js';
import { isUuid } from '../shared/identifiers.js';
import type { CommentService } from '../comments/comment-service.js';
import type { Comment, RequestContext } from '../shared/types.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface ListParams {
  postId: string;
}

interface ListQuery {
  limit?: number;
  cursor?: string;
}

interface ReplyParams {
  commentId: string;
}

interface ReplyBody {
  body: string;
}

interface RequestWithContext extends FastifyRequest {
  requestContext: RequestContext;
}

/** Explicit projection so internal fields can never reach an API client. */
function serializeComment(comment: Comment) {
  return {
    id: comment.id,
    postId: comment.postId,
    platform: comment.platform,
    author: {
      id: comment.author.id,
      displayName: comment.author.displayName,
      ...(comment.author.profileUrl === undefined ? {} : { profileUrl: comment.author.profileUrl }),
    },
    body: comment.body,
    parentCommentId: comment.parentCommentId,
    publishedAt: comment.publishedAt,
    updatedAt: comment.updatedAt,
  };
}

export function registerCommentRoutes(app: FastifyInstance, service: CommentService): void {
  for (const schema of sharedSchemas) app.addSchema(schema);

  // Scoped to this plugin, which holds only the two /v2 routes. The health
  // probe and the documentation endpoints are registered on the root instance
  // and never reach this hook, so it carries no exemption list: an allowlist
  // that exempts nothing today is a bypass shape waiting for someone to add a
  // route inside this plugin. Every route here requires an account context.
  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    const accountId = request.headers['x-account-id'];
    if (typeof accountId !== 'string' || !isUuid(accountId)) {
      request.log.warn(
        { event: 'http.request.rejected', code: 'UNAUTHENTICATED', statusCode: 401 },
        'request rejected',
      );
      return reply
        .code(401)
        .send(
          errorResponse(
            'UNAUTHENTICATED',
            'missing_account_context',
            'Authentication is required.',
            request.id,
          ),
        );
    }
    (request as RequestWithContext).requestContext = { accountId, requestId: request.id };
  });

  app.get<{ Params: ListParams; Querystring: ListQuery }>(
    '/v2/posts/:postId/comments',
    {
      schema: {
        operationId: 'listComments',
        tags: ['comments'],
        summary: 'Retrieve comments for a published post',
        description:
          'Answers from the local snapshot of the post, fetching a page from the provider when the snapshot cannot satisfy the requested position.',
        params: {
          type: 'object',
          required: ['postId'],
          properties: { postId: { type: 'string', minLength: 1 } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_LIMIT,
              default: DEFAULT_LIMIT,
              description: 'Number of comments requested.',
            },
            cursor: {
              type: 'string',
              minLength: 1,
              description: 'Opaque cursor from a previous response.',
            },
          },
        },
        response: {
          200: {
            description: 'A page of comments.',
            type: 'object',
            required: ['data', 'pagination', 'snapshot'],
            additionalProperties: false,
            properties: {
              data: { type: 'array', items: { $ref: 'Comment#' } },
              pagination: { $ref: 'Pagination#' },
              snapshot: { $ref: 'Snapshot#' },
            },
          },
          ...errorResponses([400, 401, 404, 422, 429, 500, 502, 503]),
        },
      },
    },
    async (request: FastifyRequest<{ Params: ListParams; Querystring: ListQuery }>, reply) => {
      const { limit, cursor } = request.query;
      const result = await service.listComments(
        (request as RequestWithContext).requestContext,
        request.params.postId,
        { limit: limit ?? DEFAULT_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
      );
      return reply.code(200).send({
        data: result.items.map(serializeComment),
        pagination: result.pagination,
        snapshot: result.snapshot,
      });
    },
  );

  app.post<{ Params: ReplyParams; Body: ReplyBody }>(
    '/v2/comments/:commentId/replies',
    {
      schema: {
        operationId: 'replyToComment',
        tags: ['comments'],
        summary: 'Publish a reply to a comment',
        description:
          'Publishes a reply through the post provider. The idempotency key makes a retry safe: a repeated request returns the reply already published rather than publishing a second one.',
        params: {
          type: 'object',
          required: ['commentId'],
          properties: { commentId: { type: 'string', minLength: 1 } },
        },
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: {
            body: {
              type: 'string',
              minLength: 1,
              maxLength: 10000,
              // No C0 control characters except tab, newline, and carriage
              // return. JSON permits a NUL that PostgreSQL text does not, and
              // the reply reaches the provider before it reaches the insert —
              // so an unstorable body used to publish first and orphan second,
              // raising the one log record that always pages a human, on
              // demand (Spec-022).
              pattern: '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]*$',
            },
          },
        },
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': {
              type: 'string',
              // Stored in a unique btree index. Unbounded, an incompressible
              // 4000-character key overflowed the index row and surfaced as a
              // 500; a compressible one was accepted and stored without
              // ceiling (Spec-022).
              maxLength: 255,
              description:
                'Stable across retries of the same logical reply. At most 255 characters.',
            },
          },
        },
        response: {
          201: {
            description: 'The published reply.',
            type: 'object',
            required: ['data'],
            additionalProperties: false,
            properties: { data: { $ref: 'Comment#' } },
          },
          // 413 and 415 are reachable only here: this is the one route with a body.
          ...errorResponses([400, 401, 404, 409, 413, 415, 422, 429, 500, 502, 503]),
        },
      },
    },
    async (request: FastifyRequest<{ Params: ReplyParams; Body: ReplyBody }>, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
        return reply
          .code(400)
          .send(
            errorResponse(
              'INVALID_REQUEST',
              'idempotency_key_missing',
              'Idempotency-Key is required.',
              request.id,
            ),
          );
      }
      const result = await service.replyToComment(
        (request as RequestWithContext).requestContext,
        request.params.commentId,
        request.body.body,
        idempotencyKey,
      );
      return reply.code(201).send({ data: serializeComment(result) });
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if ((error as { validation?: unknown }).validation) {
      logRejection(request, 'INVALID_REQUEST', 400);
      return reply
        .code(400)
        .send(
          errorResponse(
            'INVALID_REQUEST',
            'request_validation_failed',
            'The request is invalid.',
            request.id,
          ),
        );
    }
    if (error instanceof DomainValidationError) {
      logRejection(request, 'INVALID_REQUEST', 400);
      return reply
        .code(400)
        .send(
          errorResponse('INVALID_REQUEST', 'request_validation_failed', error.message, request.id),
        );
    }
    if (error instanceof ServiceError) {
      applyRetryAfter(reply, error);
      logRejection(
        request,
        error.code,
        error.statusCode,
        // A stored-record fault names the row so an operator can find it. The
        // identifier is service-owned and carries no user content (Spec-025).
        error instanceof StoredRecordInvalidError
          ? { recordKind: error.recordKind, recordId: error.recordId }
          : undefined,
      );
      return reply
        .code(error.statusCode)
        .send(errorResponse(error.code, error.reason, error.message, request.id));
    }
    // Fastify's own failures — an oversized body, malformed JSON, an
    // unsupported media type — are none of the three above, but every one of
    // them carries the status it deserves. Reading it turns a client mistake
    // into a 4xx logged at warn, where before it fell through to
    // INTERNAL_ERROR with a stack trace at error level: a page-worthy signal
    // anyone could raise at will (Spec-022).
    const transport = transportFailure(error);
    if (transport) {
      logRejection(request, transport.code, transport.statusCode);
      return reply
        .code(transport.statusCode)
        .send(errorResponse(transport.code, transport.reason, transport.message, request.id));
    }

    // A driver error carries `detail`, `internalQuery`, and `constraint` values
    // that may quote row content, so the error object is never handed to the
    // serializer whole; those fields are what this list exists to leave out.
    //
    // The name, message, and stack are kept deliberately — an unhandled 500 is
    // undiagnosable without them, and they are the operator's only account of
    // what happened. So this is narrower than "only the shape": a message can
    // still carry whatever a thrown Error chose to put in it. That is the
    // accepted trade for a fault this severe, and it is why the driver's
    // content-bearing fields are excluded rather than the whole record being
    // trusted (ADR-0011).
    request.log.error(
      {
        event: 'http.request.failed',
        statusCode: 500,
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'unhandled request error',
    );
    return reply
      .code(500)
      .send(
        errorResponse(
          'INTERNAL_ERROR',
          'internal_error',
          'The request could not be completed.',
          request.id,
        ),
      );
  });
}

/**
 * Classifies a framework error the handler above does not otherwise recognise.
 *
 * Only sub-500 statuses are treated this way. A framework error carrying 500
 * is a genuine internal failure and must keep its stack trace and its error
 * level.
 */
function transportFailure(error: unknown): {
  statusCode: number;
  code: ServiceErrorCode;
  reason: ServiceErrorReason;
  message: string;
} | null {
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;

  const fastifyCode = (error as { code?: unknown }).code;
  if (status === 413) {
    return {
      statusCode: 413,
      code: 'INVALID_REQUEST',
      reason: 'request_body_too_large',
      message: 'The request body is larger than this service accepts.',
    };
  }
  if (status === 415) {
    return {
      statusCode: 415,
      code: 'INVALID_REQUEST',
      reason: 'request_body_malformed',
      message: 'The request content type is not supported.',
    };
  }
  // Every content-type-parser failure is a malformed or unreadable body:
  // FST_ERR_CTP_INVALID_JSON_BODY, FST_ERR_CTP_EMPTY_JSON_BODY, and the rest.
  // Matched by family rather than by one literal, because the exact code has
  // changed across Fastify versions and the classification has not.
  if (typeof fastifyCode === 'string' && fastifyCode.startsWith('FST_ERR_CTP_')) {
    return {
      statusCode: status,
      code: 'INVALID_REQUEST',
      reason: 'request_body_malformed',
      message: 'The request body could not be read.',
    };
  }
  return {
    statusCode: status,
    code: 'INVALID_REQUEST',
    reason: 'request_validation_failed',
    message: 'The request is invalid.',
  };
}

/**
 * Records why a request was refused. Client mistakes are not errors, so they
 * are logged at warn and above only when the service itself is at fault
 * (ADR-0011).
 */
function logRejection(
  request: FastifyRequest,
  code: string,
  statusCode: number,
  extra?: Readonly<Record<string, unknown>>,
): void {
  const fields = { event: 'http.request.rejected', code, statusCode, ...extra };
  if (statusCode >= 500) request.log.error(fields, 'request failed');
  else request.log.warn(fields, 'request rejected');
}

function applyRetryAfter(reply: FastifyReply, error: ServiceError): void {
  if (error instanceof ProviderRateLimitError && error.retryAfterMs !== null) {
    reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
  }
}

function errorResponse(
  code: ServiceErrorCode,
  reason: ServiceErrorReason,
  message: string,
  requestId: string,
) {
  return { error: { code, reason, message, requestId } };
}
