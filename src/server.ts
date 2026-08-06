import {
  chooseComposition,
  createDemoApplication,
  createPostgresApplication,
  demoAccountId,
  demoPost,
} from './index.js';
import type { Database } from './repositories/database.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

// The rule itself lives in index.ts so a test can reach it; this is only the
// part that has to touch the process.
const choice = chooseComposition(process.env);
if (choice.kind === 'refuse') {
  process.stderr.write(`${choice.reason}\n`);
  process.exit(1);
}

// With DATABASE_URL the service runs on PostgreSQL; without it, on in-memory
// repositories so the demo needs nothing installed. Either way the provider is
// the deterministic fixture, since no live platform SDK is selected.
const databaseUrl = choice.kind === 'postgres' ? choice.databaseUrl : undefined;
const composed =
  choice.kind === 'postgres'
    ? createPostgresApplication(choice.databaseUrl)
    : { application: createDemoApplication(), database: undefined as Database | undefined };

const { application, database } = composed;

application
  .listen({ port, host })
  .then((address) => {
    application.log.info(
      {
        event: 'service.started',
        address,
        logLevel: process.env.LOG_LEVEL ?? 'info',
        composition: databaseUrl ? 'postgres' : 'demo',
        provider: 'fixture',
        persistence: databaseUrl ? 'postgres' : 'in-memory',
        accountId: demoAccountId,
        postId: demoPost.id,
      },
      'service.started',
    );
    application.log.info(
      {
        event: 'service.demo_hint',
        listComments: `curl '${address}/v2/posts/${demoPost.id}/comments?limit=2' -H 'X-Account-Id: ${demoAccountId}'`,
        documentation: `${address}/documentation`,
      },
      'service.demo_hint',
    );
  })
  .catch((error: unknown) => {
    // Shape only, like every other error record (ADR-0011). `err: error` hands
    // the serializer an arbitrary object; a listen failure carries the address
    // and port it tried, which is the one place a config value could leak.
    application.log.error(
      {
        event: 'service.start_failed',
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'service.start_failed',
    );
    process.exitCode = 1;
  });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // Close the server first so in-flight requests finish before the pool goes.
    void application
      .close()
      .then(() => database?.close())
      .catch(() => undefined);
  });
}
