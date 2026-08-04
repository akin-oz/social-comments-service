import { createDemoApplication, demoAccountId, demoPost } from './index.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

// No live provider or database is selected, so the demo composition (fixture
// provider, in-memory repositories) is the only runnable one. See docs/operations.md.
const application = createDemoApplication();

application
  .listen({ port, host })
  .then((address) => {
    application.log.info(
      {
        event: 'service.started',
        address,
        logLevel: process.env.LOG_LEVEL ?? 'info',
        composition: 'demo',
        provider: 'fixture',
        persistence: 'in-memory',
        accountId: demoAccountId,
        postId: demoPost.id,
      },
      'service.started',
    );
    application.log.info(
      {
        event: 'service.demo_hint',
        listComments: `curl '${address}/v2/posts/${demoPost.id}/comments?limit=2' -H 'X-Account-Id: ${demoAccountId}'`,
      },
      'service.demo_hint',
    );
  })
  .catch((error: unknown) => {
    application.log.error({ event: 'service.start_failed', err: error }, 'service.start_failed');
    process.exitCode = 1;
  });
