import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['js/**/*.test.js', 'js/**/*.spec.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['js/modules/*.js'],
      exclude: [
        'js/**/*.test.js',
        'js/**/*.spec.js',
        'js/lib/**',
      ],
      thresholds: {
        statements: 4,
        branches: 3,
        functions: 3,
        lines: 3,
      },
    },
  },
});
