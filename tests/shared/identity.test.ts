import { describe, expect, it } from 'vitest';

import { internalCommentId } from '../../src/shared/identity.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('provider identity mapping', () => {
  it('derives a version 5 UUID so persistence accepts the identifier', () => {
    expect(internalCommentId('instagram', 'ig-comment-1')).toMatch(uuidPattern);
  });

  it('is deterministic so re-observing a provider comment converges on one row', () => {
    expect(internalCommentId('instagram', 'ig-comment-1')).toBe(
      internalCommentId('instagram', 'ig-comment-1'),
    );
  });

  it('separates identical external identifiers across platforms', () => {
    expect(internalCommentId('instagram', 'shared-id')).not.toBe(
      internalCommentId('facebook', 'shared-id'),
    );
  });
});
