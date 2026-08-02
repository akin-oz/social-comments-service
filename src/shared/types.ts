/** Supported provider families. Add a value only when the provider contract is understood. */
export type Platform = 'facebook' | 'instagram' | 'linkedin' | 'x' | 'youtube';

export type PageCursor = string;

export interface Pagination {
  nextCursor: PageCursor | null;
  hasMore: boolean;
}

export interface ExternalAuthor {
  id: string;
  displayName: string;
  profileUrl?: string;
}

export interface Comment {
  id: string;
  postId: string;
  platform: Platform;
  author: ExternalAuthor;
  body: string;
  parentCommentId: string | null;
  publishedAt: string;
  updatedAt: string;
}
