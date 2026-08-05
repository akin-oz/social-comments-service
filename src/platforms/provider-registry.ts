import { ServiceError } from '../shared/errors.js';
import type {
  AdaptiveProvider,
  PlatformProviderRegistry,
  ProviderCapability,
} from '../comments/contracts.js';
import type { Platform } from '../shared/types.js';

export type { PlatformProviderRegistry };

/**
 * Resolves adapters without exposing provider SDKs to application code.
 */
export class InMemoryPlatformProviderRegistry implements PlatformProviderRegistry {
  public constructor(private readonly providers: ReadonlyMap<Platform, AdaptiveProvider>) {}

  public get(platform: Platform): AdaptiveProvider {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw new ServiceError(
        'UNSUPPORTED_CAPABILITY',
        'platform_not_configured',
        `No provider adapter is configured for ${platform}.`,
        422,
      );
    }
    return provider;
  }
}

export function requireCapability(
  provider: AdaptiveProvider,
  capability: ProviderCapability,
): void {
  if (!provider.capabilities.has(capability)) {
    throw new ServiceError(
      'UNSUPPORTED_CAPABILITY',
      'capability_unsupported',
      `Provider ${provider.platform} does not support ${capability}.`,
      422,
    );
  }
}
