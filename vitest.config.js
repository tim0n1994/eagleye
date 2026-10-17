import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['js/**/*.test.js', 'js/**/*.spec.js', 'server/**/*.test.js', 'mcp/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['js/modules/**/*.js'],
      exclude: [
        'js/**/*.test.js',
        'js/**/*.spec.js',
        'js/lib/**',
      ],
      // Ratchet, not an aspiration: set just under the measured value so
      // coverage cannot silently regress. Raise these as tests are added.
      // Measured 2026-07-27 after the pages/tools split was included:
      // 8.25 stmts / 4.87 branch / 10.36 funcs / 8.87 lines.
      thresholds: {
        statements: 8,
        branches: 4.5,
        functions: 10,
        lines: 8.5,
      },
    },
  },
});
