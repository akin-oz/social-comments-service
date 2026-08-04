# Provider capability matrix

No live provider adapter is selected for this assignment. The adaptive provider contract is implemented and tested with deterministic fixtures; a production adapter must be added only after its API and credential integration are explicitly selected.

| Provider  | List comments | Reply to comment | Pagination    | Provider adapter |
| --------- | ------------- | ---------------- | ------------- | ---------------- |
| Fixture   | Yes           | Yes              | Opaque offset | Implemented      |
| Facebook  | Not selected  | Not selected     | Not selected  | Planned          |
| Instagram | Not selected  | Not selected     | Not selected  | Planned          |
| LinkedIn  | Not selected  | Not selected     | Not selected  | Planned          |
| X         | Not selected  | Not selected     | Not selected  | Planned          |
| YouTube   | Not selected  | Not selected     | Not selected  | Planned          |

The fixture provider is a deterministic stand-in, not a social platform. It exists so the service can be run, demonstrated, and tested end to end without committing to a live API, and so the adapter contract has a stable implementation to verify against. It is registered only in the demo composition.

A capability a provider does not have is a typed `UNSUPPORTED_CAPABILITY` error, never a silent emulation: the registry rejects an unconfigured platform, and the adapter's declared capability set is checked before any write reaches the provider.

## Adapter onboarding

1. Confirm the provider's comment and reply capabilities and record any difference in this matrix.
2. Implement a `ProviderClient` in `src/platforms/` that owns SDK types and external identifiers.
3. Wrap it with `AdaptiveProviderAdapter` and map every external record into the normalized `Comment` contract.
4. Register the adapter in composition code and add deterministic mapping and failure tests.
5. Document pagination, timestamps, rate limits, timeout behavior, and credential references before enabling production traffic.
