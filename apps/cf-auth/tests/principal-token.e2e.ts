/**
 * Real-database checks that the token this service issues is one the harness
 * edge can address a Durable Object with.
 *
 * Requires a THROWAWAY migrated database, named by
 * `DSH_CF_AUTH_TEST_DATABASE_URL`, plus the `DSH_CF_AUTH_TEST_SECRET` its
 * `jwks` rows were minted with; it self-skips without both. It deliberately
 * does not read `DATABASE_URL`, so it cannot run against the deployment's own
 * database: Better Auth encrypts JWKS private keys with the signing secret,
 * so signing once under a test secret leaves a key the real deployment cannot
 * decrypt, and every later token request fails with a 500. A Neon branch is
 * the intended home for this.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { createAuth, type AuthService } from '../src/auth.ts'

const connectionString = process.env.DSH_CF_AUTH_TEST_DATABASE_URL
const secret = process.env.DSH_CF_AUTH_TEST_SECRET
const BASE = 'http://localhost:8787'
const PASSWORD = 'correct-horse-battery-staple'

/** Claims the harness edge reads out of an issued token. */
interface EdgeClaims {
  readonly sub: string
  readonly org: string
}

describe.skipIf(
  connectionString === undefined || connectionString.length === 0
  || secret === undefined || secret.length === 0,
)('issued tokens address one object per principal', () => {
  let auth: AuthService
  const created: string[] = []

  beforeAll(() => {
    auth = createAuth({
      connectionString: connectionString as string,
      secret: secret as string,
      baseUrl: BASE,
      trustedOrigins: [BASE],
      google: { clientId: 'unused-by-this-test', clientSecret: 'unused-by-this-test' },
    })
  })

  afterAll(async () => {
    if (created.length === 0) return
    // The test owns every row it made; membership and session rows cascade.
    const client = new Client({ connectionString })
    await client.connect()
    try {
      await client.query('delete from "organization" where "id" in (select "organizationId" from "member" where "userId" = any($1))', [created])
      await client.query('delete from "user" where "id" = any($1)', [created])
    } finally {
      await client.end()
    }
  })

  /** Sign one new account up and read the claims out of its issued token. */
  async function signUpAndClaim(label: string): Promise<EdgeClaims> {
    const email = `e2e-${label}-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}@example.invalid`
    const signUp = await auth.handler(new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: `E2E ${label}` }),
    }))
    expect(signUp.status, `sign-up for ${label}`).toBe(200)
    const cookie = (signUp.headers.get('set-cookie') ?? '')
      .split(',').map(part => part.split(';')[0]?.trim() ?? '').filter(part => part.length > 0).join('; ')

    const issued = await auth.handler(new Request(`${BASE}/api/auth/token`, { headers: { cookie } }))
    expect(issued.status, `token for ${label}`).toBe(200)
    const { token } = await issued.json() as { token: string }
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as EdgeClaims
    created.push(claims.sub)
    return claims
  }

  it('names an organization on the very first token, before any sign-in', async () => {
    // Signup creates the session ~1s before the personal organization exists,
    // so a token that read `activeOrganizationId` would carry null here.
    const claims = await signUpAndClaim('first')
    expect(claims.org).toEqual(expect.any(String))
    expect(claims.org.length).toBeGreaterThan(0)
    expect(claims.sub.length).toBeGreaterThan(0)
  })

  // What this service owes the edge is a distinct (org, sub) pair per user.
  // Turning one pair into a Durable Object name belongs to `hostObjectName`,
  // which `packages/identity/principal` unit-tests directly; asserting it here
  // too would duplicate that ownership across a package boundary.
  it('gives two principals two different identities', async () => {
    const [a, b] = await Promise.all([signUpAndClaim('a'), signUpAndClaim('b')])
    expect(a.sub).not.toBe(b.sub)
    expect(a.org).not.toBe(b.org)
    // Both segments must survive a colon-delimited object name unescaped.
    for (const claims of [a, b]) {
      expect(claims.sub).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(claims.org).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('serves a JWKS the edge can verify against', async () => {
    const jwks = await auth.handler(new Request(`${BASE}/api/auth/jwks`))
    expect(jwks.status).toBe(200)
    const { keys } = await jwks.json() as { keys: readonly { alg: string }[] }
    expect(keys.length).toBeGreaterThan(0)
    expect(keys[0]?.alg).toBe('EdDSA')
  })
})
