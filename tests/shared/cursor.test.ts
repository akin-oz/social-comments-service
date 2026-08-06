import { describe, expect, it } from 'vitest';

import { decodeCursor, emptyCursor, encodeCursor } from '../../src/shared/cursor.js';
import { ServiceError } from '../../src/shared/errors.js';

describe('opaque pagination cursor', () => {
  it('round-trips a keyset position', () => {
    const cursor = {
      after: { publishedAt: '2026-08-01T10:00:00.000Z', id: 'comment-1' },
      partialRun: false,
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips the partial-run flag a run carries with it', () => {
    // The flag says this run began before the snapshot was complete, which
    // outlives the snapshot becoming complete underneath it (Spec-021).
    const cursor = {
      after: { publishedAt: '2026-08-01T10:00:00.000Z', id: 'comment-1' },
      partialRun: true,
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('never carries a provider continuation token to a client', () => {
    // Vendors document that their cursors must not be stored, so the service
    // must not hand one out either (Spec-014).
    const encoded = encodeCursor({
      after: { publishedAt: '2026-08-01T10:00:00.000Z', id: 'comment-1' },
      partialRun: false,
    });
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toContain('provider');
  });

  it('ignores the provider field on a previously issued cursor', () => {
    const legacy = Buffer.from(
      JSON.stringify({ a: ['2026-08-01T10:00:00.000Z', 'comment-1'], p: 'old-token' }),
      'utf8',
    ).toString('base64url');
    expect(decodeCursor(legacy)).toEqual({
      after: { publishedAt: '2026-08-01T10:00:00.000Z', id: 'comment-1' },
      partialRun: false,
    });
  });

  it('treats a missing cursor as the first page', () => {
    expect(decodeCursor(undefined)).toEqual(emptyCursor);
  });

  it('rejects cursors the service did not produce', () => {
    const invalid = ['not-base64-json', Buffer.from('{}', 'utf8').toString('base64url')];
    for (const value of invalid) {
      expect(() => decodeCursor(value)).toThrowError(
        new ServiceError(
          'INVALID_CURSOR',
          'cursor_not_issued_by_service',
          'The pagination cursor is invalid.',
          400,
        ),
      );
    }
  });

  it('rejects a structurally valid cursor with an incomplete keyset', () => {
    const payload = Buffer.from(JSON.stringify({ a: ['2026-08-01'] }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(payload)).toThrowError('The pagination cursor is invalid.');
  });
});
