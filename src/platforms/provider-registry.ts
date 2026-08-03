import { ServiceError } from '../shared/errors.js';
import type { AdaptiveProvider } from '../comments/contracts.js';
import type { Platform } from '../shared/types.js';

/**
 * Resolves adapters without exposing provider SDKs to application code.
 */
export interface PlatformProviderRegistry {
  get(platform: Platform): AdaptiveProvider;
}

export class InMemoryPlatformProviderRegistry implements PlatformProviderRegistry {
  public constructor(private readonly providers: ReadonlyMap<Platform, AdaptiveProvider>) {}

  public get(platform: Platform): AdaptiveProvider {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw new ServiceError(
        'UNSUPPORTED_CAPABILITY',
        `No provider adapter is configured for ${platform}.`,
        422,
      );
    }
    return provider;
  }
}

export function requireCapability(
  provider: AdaptiveProvider,
  capability: 'list_comments' | 'reply_to_comment',
): void {
  if (!provider.capabilities.has(capability)) {
    throw new ServiceError(
      'UNSUPPORTED_CAPABILITY',
      `Provider ${provider.platform} does not support ${capability}.`,
      422,
    );
  }
}
