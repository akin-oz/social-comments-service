import type { FastifyInstance, FastifyRequest } from 'fastify';

import { DomainValidationError } from '../shared/validation.js';
import { ServiceError } from '../shared/errors.js';
import type { CommentService } from '../comments/comment-service.js';
import type { TenantContext } from '../shared/types.js';

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
  requestContext: TenantContext;
}

export function registerCommentRoutes(app: FastifyInstance, service: CommentService): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    const accountId = request.headers['x-account-id'];
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      return reply
        .code(401)
        .send(errorResponse('UNAUTHENTICATED', 'Authentication is required.', request.id));
    }
    (request as RequestWithContext).requestContext = { accountId };
  });

  app.get<{ Params: ListParams; Querystring: ListQuery }>(
    '/v2/posts/:postId/comments',
    {
      schema: {
        params: {
          type: 'object',
          required: ['postId'],
          properties: { postId: { type: 'string', minLength: 1 } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ListParams; Querystring: ListQuery }>, reply) => {
      const query = request.query;
      const result = await service.listComments(
        (request as RequestWithContext).requestContext,
        request.params.postId,
        { limit: query.limit ?? 25, ...(query.cursor ? { cursor: query.cursor } : {}) },
      );
      return reply.code(200).send({ data: result.items, pagination: result.pagination });
    },
  );

  app.post<{ Params: ReplyParams; Body: ReplyBody }>(
    '/v2/comments/:commentId/replies',
    {
      schema: {
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
        headers: { type: 'object', required: ['idempotency-key'] },
      },
    },
    async (request: FastifyRequest<{ Params: ReplyParams; Body: ReplyBody }>, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
        return reply
          .code(400)
          .send(errorResponse('INVALID_REQUEST', 'Idempotency-Key is required.', request.id));
      }
      const result = await service.replyToComment(
        (request as RequestWithContext).requestContext,
        request.params.commentId,
        request.body.body,
        idempotencyKey,
      );
      return reply.code(201).send({ data: result });
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if ((error as { validation?: unknown }).validation) {
      return reply
        .code(400)
        .send(errorResponse('INVALID_REQUEST', 'The request is invalid.', request.id));
    }
    if (error instanceof DomainValidationError) {
      return reply.code(400).send(errorResponse('INVALID_REQUEST', error.message, request.id));
    }
    if (error instanceof ServiceError) {
      return reply
        .code(error.statusCode)
        .send(errorResponse(error.code, error.message, request.id));
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply
      .code(500)
      .send(errorResponse('PROVIDER_ERROR', 'The request could not be completed.', request.id));
  });
}

function errorResponse(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}
