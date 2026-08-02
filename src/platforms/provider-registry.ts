import type { CommentPlatformProvider } from '../comments/contracts.js';
import type { Platform } from '../shared/types.js';

/**
 * Placeholder for provider selection.
 * Future responsibility: resolve a platform adapter from configuration and supported capabilities.
 */
export interface PlatformProviderRegistry {
  get(platform: Platform): CommentPlatformProvider;
}
