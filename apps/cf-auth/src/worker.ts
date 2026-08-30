/**
 * The dsh identity service on Cloudflare. Every request is delegated to Better
 * Auth, which owns its own routes under the configured base path. This Worker
 * holds no state: the database is Neon behind Hyperdrive, and the JWKS private
 * keys live in that database, which is what makes this service's runtime host a
 * movable decision rather than a migration.
 */

import { createAuth } from './auth.ts'

/** Bindings this Worker is deployed with (wrangler.jsonc). */
interface Env {
  HYPERDRIVE: Hyperdrive
  BETTER_AUTH_SECRET: SecretsStoreSecret
  GOOGLE_CLIENT_ID: SecretsStoreSecret
  GOOGLE_CLIENT_SECRET: SecretsStoreSecret
  AUTH_BASE_URL: string
  AUTH_TRUSTED_ORIGINS: string
}

/** Split the configured trusted-origin list; an empty entry is a configuration slip, not an origin. */
function trustedOrigins(configured: string): readonly string[] {
  return configured.split(',').map(origin => origin.trim()).filter(origin => origin.length > 0)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [secret, clientId, clientSecret] = await Promise.all([
      env.BETTER_AUTH_SECRET.get(),
      env.GOOGLE_CLIENT_ID.get(),
      env.GOOGLE_CLIENT_SECRET.get(),
    ])
    const auth = createAuth({
      connectionString: env.HYPERDRIVE.connectionString,
      secret,
      baseUrl: env.AUTH_BASE_URL,
      trustedOrigins: trustedOrigins(env.AUTH_TRUSTED_ORIGINS),
      google: { clientId, clientSecret },
    })
    return auth.handler(request)
  },
} satisfies ExportedHandler<Env>
