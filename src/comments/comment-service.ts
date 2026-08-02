import type { CommentRepository } from './contracts.js';

/**
 * Placeholder for application-level comment use cases.
 * Future responsibility: coordinate repositories and platform providers without owning transport details.
 */
export class CommentService {
  public constructor(private readonly repository: CommentRepository) {
    void this.repository;
  }
}
