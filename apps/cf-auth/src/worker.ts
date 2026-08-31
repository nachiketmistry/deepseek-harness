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

/**
 * Cross-origin headers for one trusted caller.
 *
 * Better Auth's `trustedOrigins` decides which origins may start a flow; it
 * does not answer a browser's cross-origin checks, so this service answers
 * them itself. The harness web GUI is served from another origin and signs in
 * against this one, which is a cross-origin request carrying credentials:
 * without these headers the browser discards the response before the page sees
 * it. `Access-Control-Allow-Origin` echoes the caller rather than `*`, because
 * a credentialed request refuses the wildcard.
 * @param origin - the request's `Origin`, absent for a non-browser caller.
 * @param trusted - origins this deployment admits.
 * @returns the headers to add, empty for any caller not on the list.
 */
function corsHeaders(origin: string | null, trusted: readonly string[]): Record<string, string> {
  if (origin === null || !trusted.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    // The response differs per caller, so a shared cache must not serve one
    // origin's headers to another.
    'vary': 'Origin',
  }
}

/** What the sign-in flow's preflight asks about: a JSON POST and a credentialed GET. */
const PREFLIGHT_HEADERS = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const trusted = trustedOrigins(env.AUTH_TRUSTED_ORIGINS)
    const cors = corsHeaders(request.headers.get('origin'), trusted)
    // A preflight carries no credentials and reaches no route, so it is
    // answered before the service is built and before Postgres is touched.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, ...PREFLIGHT_HEADERS } })
    }
    const [secret, clientId, clientSecret] = await Promise.all([
      env.BETTER_AUTH_SECRET.get(),
      env.GOOGLE_CLIENT_ID.get(),
      env.GOOGLE_CLIENT_SECRET.get(),
    ])
    const auth = createAuth({
      connectionString: env.HYPERDRIVE.connectionString,
      secret,
      baseUrl: env.AUTH_BASE_URL,
      trustedOrigins: trusted,
      google: { clientId, clientSecret },
    })
    const answered = await auth.handler(request)
    if (Object.keys(cors).length === 0) return answered
    // Rebuilt rather than mutated: a Response the handler returns has
    // immutable headers, and its `set-cookie` must survive the copy.
    const headers = new Headers(answered.headers)
    for (const [name, value] of Object.entries(cors)) headers.set(name, value)
    return new Response(answered.body, { status: answered.status, statusText: answered.statusText, headers })
  },
} satisfies ExportedHandler<Env>
