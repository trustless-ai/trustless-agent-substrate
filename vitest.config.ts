import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Manifest tests intentionally scan and hash complete installed package trees.
    // Keep files on one worker so cold-cache scans cannot starve each other's time budgets.
    maxWorkers: 1,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
        'src/core/profile/**': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/core/skill/**': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/core/repository/**': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/clients/repository/**': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/local/config/**': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/local/instance/**': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
})
