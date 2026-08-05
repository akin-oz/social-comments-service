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
});
