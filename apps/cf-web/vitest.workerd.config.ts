/**
 * workerd-hosted tests for the CF app: they run inside the Cloudflare runtime
 * through vitest-pool-workers, never under Node, so they are excluded from the
 * repository's Node vitest globs by their `.workerd.ts` suffix.
 *
 * Two projects, because they need two deployments. `deployment` carries the
 * real `wrangler.jsonc` and holds the checks that are about it. `edge` carries
 * `wrangler.edge-test.jsonc`, whose Worker is the shipped edge module over a
 * recording Host object, and whose identity bindings name the key set
 * `tests/workerd/identity.setup.ts` serves rather than the deployed identity
 * service a local run must not verify against.
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            isolatedStorage: false,
            singleWorker: true,
            wrangler: { configPath: './wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'deployment',
          include: ['tests/workerd/*.workerd.ts'],
          testTimeout: 60_000,
        },
      },
      {
        plugins: [
          cloudflareTest(({ inject }) => {
            const identity = inject('identityFixture')
            return {
              isolatedStorage: false,
              singleWorker: true,
              wrangler: { configPath: './wrangler.edge-test.jsonc' },
              miniflare: {
                bindings: {
                  ...identity,
                  AUTH_BASE_URL: identity.TEST_ISSUER,
                  AUTH_JWKS_URL: identity.TEST_JWKS_URL,
                  AUTH_ISSUER: identity.TEST_ISSUER,
                },
              },
            }
          }),
        ],
        test: {
          name: 'edge',
          include: ['tests/workerd/edge/*.workerd.ts'],
          testTimeout: 60_000,
          globalSetup: ['./tests/workerd/identity.setup.ts'],
        },
      },
    ],
  },
})
