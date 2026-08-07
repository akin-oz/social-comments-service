import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * The entry point, run as a process.
 *
 * `chooseComposition` decides the fail-closed rule and six tests cover it, but
 * `src/server.ts` is what *actuates* that decision, and nothing executed this
 * file: no test imported it, and CI never ran `pnpm build`, so the
 * `dist/src/server.js` the Dockerfile launches was never even produced in the
 * pipeline. Deleting `process.exit(1)` left the whole suite green while a
 * misspelled DATABASE_URL booted the in-memory composition in production —
 * passing its health check, accepting any account, with no row-level security
 * behind it. That is precisely the outcome the rule exists to prevent, so the
 * assertion has to be made from outside the process (Spec-020).
 *
 * Spawned like `tests/suite-integrity.test.ts`, for the same reason: an exit
 * code is not observable from inside the run it would terminate.
 */
function startServer(env: Record<string, string>) {
  return run('node', ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      // A port that is never bound: refusal must happen before listen, so a
      // process that reaches this value has already failed the test.
      PORT: '0',
      ...env,
    },
    timeout: 30_000,
  }).then(
    () => ({ code: 0, stderr: '' }),
    (error: { code?: number; stderr?: string; killed?: boolean }) => ({
      code: error.killed === true ? 'timed-out' : (error.code ?? 'no-code'),
      stderr: error.stderr ?? '',
    }),
  );
}

describe('the server entry point', () => {
  it('exits non-zero rather than downgrading to in-memory in production', async () => {
    const result = await startServer({ NODE_ENV: 'production' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL is required when NODE_ENV=production');
  }, 40_000);

  it('exits non-zero rather than starting on the development fingerprint key', async () => {
    // The second refusal shares the first's shape, so a guard that handled only
    // the database URL would still look correct from the outside.
    const result = await startServer({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'IDEMPOTENCY_FINGERPRINT_SECRET is required when NODE_ENV=production',
    );
  }, 40_000);
});
