import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Deliberately not `passWithNoTests`. With it, a broken glob or a renamed
    // directory produced a green build that ran zero tests — the one failure
    // mode a test suite must never have (Spec-020).
    passWithNoTests: false,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
