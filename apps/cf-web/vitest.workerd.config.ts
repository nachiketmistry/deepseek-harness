/**
 * workerd-hosted tests for the CF app: they run inside the Cloudflare runtime
 * through vitest-pool-workers, never under Node, so they are excluded from the
 * repository's Node vitest globs by their `.workerd.ts` suffix.
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/workerd/**/*.workerd.ts'], testTimeout: 60_000 },
  plugins: [
    cloudflareTest({
      isolatedStorage: false,
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
})
