import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Database-backed files share one cluster, and one of them deliberately
    // elevates the service role to SUPERUSER for a few milliseconds to prove
    // the migration corrects it. Running that concurrently with a cross-tenant
    // probe in another file would make the probe pass for the wrong reason.
    // Sequencing files costs a little wall clock and removes the race
    // (Spec-020).
    fileParallelism: false,
    // Deliberately not `passWithNoTests`. With it, a broken glob or a renamed
    // directory produced a green build that ran zero tests — the one failure
    // mode a test suite must never have (Spec-020).
    passWithNoTests: false,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
