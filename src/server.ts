import { createDemoApplication, demoAccountId, demoPost } from './index.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

// No live provider or database is selected, so the demo composition (fixture
// provider, in-memory repositories) is the only runnable one. See docs/operations.md.
const application = createDemoApplication();

application
  .listen({ port, host })
  .then(() => {
    application.log.info(
      { accountId: demoAccountId, postId: demoPost.id },
      'started with the fixture provider composition',
    );
  })
  .catch((error: unknown) => {
    application.log.error(error, 'failed to start application');
    process.exitCode = 1;
  });
