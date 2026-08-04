import { createHash } from 'node:crypto';

import type { Platform } from './types.js';

/**
 * Fixed namespace for provider comment identity. Changing it re-keys every
 * derived identifier, so it must remain stable across releases.
 */
const COMMENT_NAMESPACE = 'f3b0c9d2-5a41-4c7e-9b83-1d6e2a7f40c5';

/**
 * Derives an RFC 4122 version 5 UUID from a namespace and name.
 */
function uuidV5(namespace: string, name: string): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(namespace.replace(/-/g, ''), 'hex'));
  hash.update(Buffer.from(name, 'utf8'));
  const bytes = hash.digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Maps a provider comment identifier to the service's internal identity.
 *
 * Derivation is deterministic so that observing the same provider comment
 * twice converges on one row. It assumes provider comment identifiers are
 * unique within a platform, which every currently modelled provider satisfies.
 */
export function internalCommentId(platform: Platform, externalCommentId: string): string {
  return uuidV5(COMMENT_NAMESPACE, `${platform}:${externalCommentId}`);
}
