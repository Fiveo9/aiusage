import { defineConfig } from 'vitest/config'

// The review regressions use synthetic in-memory input and no deletion-based fixtures.
export default defineConfig({
  test: { include: ['tests/review/**/*.test.ts'], pool: 'forks' },
})
