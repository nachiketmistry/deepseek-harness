/**
 * The browser acceptance lane for this app. It drives a real `wrangler dev`
 * over the built Worker and a real identity service, so it is outside every
 * repository-wide vitest lane and is run by this package's `test:browser`
 * script; without those servers its cases skip and say so.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/browser/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
