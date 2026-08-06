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

  it('rejects a cursor position that is not the exact ISO instant it issues', () => {
    // Both halves of the keyset reach a typed cast, so both are guarded. The
    // timestamp is checked strictly, not with Date.parse: these all parse to a
    // finite number yet fail ::timestamptz with a 500, and the calendar-invalid
    // one even passes the shape regex, so the round-trip is what rejects it
    // (Spec-022, second readiness sweep).
    const uuid = '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001';
    const positions = [
      'CANARY-ATTACKER-VALUE',
      'CANARY-ATTACKER-VALUE 2026',
      '2026',
      '2026-8',
      '1',
      '2026-02-30T00:00:00.000Z', // shaped like an instant, but no such day
      '2026-08-01T10:00:00Z', // valid ISO, but not the millisecond form issued
    ];
    for (const publishedAt of positions) {
      const forged = Buffer.from(JSON.stringify({ a: [publishedAt, uuid] }), 'utf8').toString(
        'base64url',
      );
      expect(
        () => decodeCursor(forged),
        `position ${JSON.stringify(publishedAt)} must be rejected`,
      ).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR', statusCode: 400 }));
    }
  });

  it('accepts the exact ISO instant it issues', () => {
    const issued = {
      after: { publishedAt: '2026-08-01T10:00:00.000Z', id: crypto.randomUUID() },
      partialRun: false,
    };
    expect(decodeCursor(encodeCursor(issued))).toEqual(issued);
  });

  it('rejects a structurally valid cursor with an incomplete keyset', () => {
    const payload = Buffer.from(JSON.stringify({ a: ['2026-08-01'] }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(payload)).toThrowError('The pagination cursor is invalid.');
  });
});
