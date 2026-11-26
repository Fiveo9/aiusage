import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Explicit remote acceptance only. The normal suite keeps its PGlite adapter.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^.*\/helpers\/pglite-sql\.(?:js|ts)$/, replacement: path.resolve('tests/helpers/postgres-sql.ts') },
      { find: '$lib', replacement: path.resolve('src/lib') },
      { find: '$env/dynamic/private', replacement: path.resolve('tests/mocks/env.ts') },
      { find: '@aiusage/core', replacement: path.resolve('../core/src/index.ts') },
    ],
  },
  test: {
    include: ['tests/cloud/performance-20261122.pg.test.ts', 'tests/cloud/sync-consistency.pg.test.ts', 'tests/pricing/litellm-sync.pg.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
})
