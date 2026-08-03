import { createApplication } from './index.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';
const application = createApplication();

application.listen({ port, host }).catch((error: unknown) => {
  application.log.error(error, 'failed to start application');
  process.exitCode = 1;
});
