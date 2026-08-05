import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { DomainValidationError } from '../shared/validation.js';
import {
  ProviderRateLimitError,
  ServiceError,
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

/**
 * Paths that carry no tenant data and therefore no account context: the process
 * health probe and the API documentation (Spec-011).
 */
function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return (
    path === '/health' ||
    path === '/openapi.json' ||
    path === '/documentation' ||
    path.startsWith('/documentation/')
  );
}

export function registerCommentRoutes(app: FastifyInstance, service: CommentService): void {
  for (const schema of sharedSchemas) app.addSchema(schema);

  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    if (isPublicPath(request.url)) return;
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
          properties: { body: { type: 'string', minLength: 1, maxLength: 10000 } },
        },
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': {
              type: 'string',
              description: 'Stable across retries of the same logical reply.',
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
          ...errorResponses([400, 401, 404, 409, 422, 429, 500, 502, 503]),
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
      logRejection(request, error.code, error.statusCode);
      return reply
        .code(error.statusCode)
        .send(errorResponse(error.code, error.reason, error.message, request.id));
    }
    // A driver error carries detail, internalQuery, and constraint values that
    // may quote row content. Only the shape is logged (ADR-0011).
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
 * Records why a request was refused. Client mistakes are not errors, so they
 * are logged at warn and above only when the service itself is at fault
 * (ADR-0011).
 */
function logRejection(request: FastifyRequest, code: string, statusCode: number): void {
  const fields = { event: 'http.request.rejected', code, statusCode };
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
