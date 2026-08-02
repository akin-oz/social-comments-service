import type { Comment, PageCursor, Pagination, Platform } from '../shared/types.js';

export interface ListCommentsQuery {
  postId: string;
  platform: Platform;
  cursor?: PageCursor;
  limit: number;
}

export interface ListCommentsResult {
  items: Comment[];
  pagination: Pagination;
}

export interface ReplyToCommentCommand {
  commentId: string;
  body: string;
  idempotencyKey: string;
}

export interface CommentRepository {
  /** Future responsibility: read normalized comments from application persistence. */
  listByPost(query: ListCommentsQuery): Promise<ListCommentsResult>;
}

export interface CommentPlatformProvider {
  /** Future responsibility: fetch provider comments and map them to the domain contract. */
  listComments(query: ListCommentsQuery): Promise<ListCommentsResult>;

  /** Future responsibility: publish a reply using the provider API. */
  replyToComment(command: ReplyToCommentCommand): Promise<Comment>;
}
