import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from './index.js';

/**
 * Writes the OpenAPI document derived from the route schemas (Spec-011).
 *
 * The committed file is regenerated in CI and compared, so a route change that
 * is not reflected in the contract fails the build instead of drifting quietly.
 */
async function generate(): Promise<void> {
  const target = path.join('docs', 'openapi.json');
  const application = createApplication({ logger: false, apiDocs: true });
  await application.ready();
  const document = application.swagger();
  await application.close();

  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${target}\n`);
}

generate().catch((error: unknown) => {
  process.stderr.write(`failed to generate the OpenAPI document: ${String(error)}\n`);
  process.exitCode = 1;
});
