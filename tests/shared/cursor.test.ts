import { describe, expect, it } from 'vitest';

import { decodeCursor, emptyCursor, encodeCursor } from '../../src/shared/cursor.js';
import { ServiceError } from '../../src/shared/errors.js';

describe('opaque pagination cursor', () => {
  it('round-trips a keyset position and provider continuation', () => {
    const cursor = {
      after: { publishedAt: '2026-08-01T10:00:00.000Z', id: 'comment-1' },
      providerCursor: 'provider-page-2',
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('treats a missing cursor as the first page', () => {
    expect(decodeCursor(undefined)).toEqual(emptyCursor);
  });

  it('encodes a first page that only carries provider continuation', () => {
    const encoded = encodeCursor({ after: null, providerCursor: 'provider-page-2' });
    expect(decodeCursor(encoded)).toEqual({ after: null, providerCursor: 'provider-page-2' });
  });

  it('rejects cursors the service did not produce', () => {
    const invalid = ['not-base64-json', Buffer.from('{}', 'utf8').toString('base64url')];
    for (const value of invalid) {
      expect(() => decodeCursor(value)).toThrowError(
        new ServiceError('INVALID_CURSOR', 'The pagination cursor is invalid.', 400),
      );
    }
  });

  it('rejects a structurally valid cursor with an incomplete keyset', () => {
    const payload = Buffer.from(JSON.stringify({ a: ['2026-08-01'], p: null }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(payload)).toThrowError('The pagination cursor is invalid.');
  });
});
