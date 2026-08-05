import {
  createDemoApplication,
  createPostgresApplication,
  demoAccountId,
  demoPost,
} from './index.js';
import type { Database } from './repositories/database.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';
const databaseUrl = process.env.DATABASE_URL;

// Falling back to the demo composition in production would start a service
// that passes its health check, accepts any account, and has no row-level
// security behind it. A missing or misspelled DATABASE_URL must stop the
// process, not silently downgrade it.
if (databaseUrl === undefined && process.env.NODE_ENV === 'production') {
  process.stderr.write(
    'DATABASE_URL is required when NODE_ENV=production: refusing to start the in-memory composition.\n',
  );
  process.exit(1);
}

// With DATABASE_URL the service runs on PostgreSQL; without it, on in-memory
// repositories so the demo needs nothing installed. Either way the provider is
// the deterministic fixture, since no live platform SDK is selected.
const composed = databaseUrl
  ? createPostgresApplication(databaseUrl)
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
    application.log.error({ event: 'service.start_failed', err: error }, 'service.start_failed');
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
