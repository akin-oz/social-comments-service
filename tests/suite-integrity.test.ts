import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * The failure mode a test suite must never have: reporting success while
 * running nothing.
 *
 * `passWithNoTests: true` meant a broken glob, a renamed directory, or a
 * mistyped `include` produced a green build with zero tests collected — and
 * every other test in this repository would have been silently uninvolved
 * (Spec-020). This is the one assertion that cannot be made from inside a test
 * run, so it spawns one.
 */
describe('the suite itself', () => {
  it('fails a run that collects no tests', async () => {
    const result = await run(
      'node',
      ['node_modules/vitest/vitest.mjs', 'run', 'tests/no-such-directory/**/*.test.ts'],
      { cwd: process.cwd() },
    ).then(
      () => ({ failed: false, stderr: '' }),
      (error: { code?: number; stderr?: string }) => ({
        failed: true,
        stderr: error.stderr ?? '',
      }),
    );

    expect(result.failed).toBe(true);
    expect(result.stderr).toMatch(/No test files found/i);
  }, 60_000);

  it('runs the database-backed tests wherever a database is expected', () => {
    // The near neighbour of the failure above: not a suite that collects no
    // tests, but one that collects them and skips the half that proves the
    // thing hardest to prove. The integration files are gated on
    // `DATABASE_URL`/`APP_DATABASE_URL` so a contributor needs no Docker — and
    // that same gate means deleting the `env:` block from the CI workflow makes
    // every tenant-isolation test skip in silence while the build stays green.
    // Tenant isolation would then be claimed by a suite that never checked it.
    //
    // CI is the one environment where skipping is never legitimate, so that is
    // where the gate is asserted rather than merely relied upon (Spec-020,
    // docs/testing.md).
    if (process.env.CI === undefined) return;

    expect(process.env.DATABASE_URL, 'CI must provide DATABASE_URL').toBeDefined();
    expect(process.env.APP_DATABASE_URL, 'CI must provide APP_DATABASE_URL').toBeDefined();
    expect(process.env.DATABASE_URL).not.toBe('');
    expect(process.env.APP_DATABASE_URL).not.toBe('');
  });
});
