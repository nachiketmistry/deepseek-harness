/**
 * Stands the identity half of the workerd acceptance run up, in Node, before
 * the Worker starts.
 *
 * Two things the Worker needs and a test inside workerd cannot make for
 * itself. Tokens the real identity service issued, so the deployment is
 * verified against what it will actually be given; and tokens no service will
 * ever issue — expired, unsigned, rewritten — which have to be minted from a
 * key the run controls. Both are served from one key set: this setup publishes
 * the identity service's own keys alongside the run's key, so a real token and
 * a deliberately bad one are refused or accepted by the same verifier for the
 * same reasons a deployment would.
 *
 * Everything is handed to the Worker as bindings (`vitest.workerd.config.ts`),
 * because a value provided here is available to the pool's configuration but a
 * key generated here cannot cross into workerd.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestProject } from 'vitest/node'
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'

/** Where the identity service `apps/cf-auth`'s own `pnpm run dev` serves. */
const IDENTITY_URL = process.env.DSH_CF_AUTH_DEV_URL ?? 'http://localhost:8788'
/** The seeded development accounts, and the password `apps/cf-auth`'s seed gives them. */
const ACCOUNTS = { alice: 'alice@dev.invalid', bob: 'bob@dev.invalid' }
const PASSWORD = process.env.DSH_CF_AUTH_DEV_PASSWORD ?? 'dev-password-not-a-secret'
const ALGORITHM = 'EdDSA'
/** `kid` of the run's own key, which the identity service never publishes. */
const RUN_KID = 'acceptance-run'

/** What the Worker and the tests are given, as string bindings. */
export interface IdentityFixture {
  /** Key set merging the identity service's keys with this run's own. */
  TEST_JWKS_URL: string
  /** Issuer both real and minted tokens name. */
  TEST_ISSUER: string
  /** Whether the identity service answered; `''` when it did not. */
  TEST_IDENTITY_LIVE: string
  /** A token the identity service issued for alice, or `''`. */
  TEST_ALICE_TOKEN: string
  /** A token the identity service issued for bob, or `''`. */
  TEST_BOB_TOKEN: string
  /** Object name alice's real token addresses, or `''`. */
  TEST_ALICE_OBJECT: string
  /** Object name bob's real token addresses, or `''`. */
  TEST_BOB_OBJECT: string
  /** A token this run signed for one principal, always present. */
  TEST_MINTED_ONE: string
  /** A token this run signed for a second principal, always present. */
  TEST_MINTED_TWO: string
  /** A token this run signed whose lifetime has already run out. */
  TEST_EXPIRED: string
  /** A token whose claims were rewritten under a signature that no longer covers them. */
  TEST_TAMPERED: string
  /** A token carrying `alg: none` and no signature at all. */
  TEST_UNSIGNED: string
}

/** Collapse a Set-Cookie response header into a Cookie request header. */
function cookieHeader(response: Response): string {
  return (response.headers.get('set-cookie') ?? '')
    .split(',').map(part => part.split(';')[0]?.trim() ?? '').filter(part => part.length > 0).join('; ')
}

/** Sign one seeded account in and read the token the harness edge would receive. */
async function realToken(email: string): Promise<string> {
  const signIn = await fetch(`${IDENTITY_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: IDENTITY_URL },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!signIn.ok) throw new Error(`identity setup: ${email} could not sign in (${String(signIn.status)}: ${await signIn.text()})`)
  const issued = await fetch(`${IDENTITY_URL}/api/auth/token`, {
    headers: { cookie: cookieHeader(signIn), origin: IDENTITY_URL },
  })
  if (!issued.ok) throw new Error(`identity setup: ${email} was issued no token (${String(issued.status)}: ${await issued.text()})`)
  const body = await issued.json() as { token: string }
  return body.token
}

/** The object name one token's claims address, computed the way the Worker computes it. */
function objectNameOf(token: string): string {
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { org: string; sub: string }
  return `dsh:1:${claims.org}:${claims.sub}`
}

let server: Server | undefined

/**
 * Start the merged key set and mint this run's tokens.
 * @param project - the Vitest project the values are provided to.
 */
export default async function setup(project: TestProject): Promise<void> {
  const run = await generateKeyPair(ALGORITHM)
  const runKey: JWK = { ...await exportJWK(run.publicKey), alg: ALGORITHM, kid: RUN_KID }

  let identityKeys: JWK[] = []
  let alice = ''
  let bob = ''
  try {
    const served = await fetch(`${IDENTITY_URL}/api/auth/jwks`)
    if (!served.ok) throw new Error(`jwks ${String(served.status)}`)
    const set = await served.json() as { keys: JWK[] }
    identityKeys = set.keys
    ;[alice, bob] = await Promise.all([realToken(ACCOUNTS.alice), realToken(ACCOUNTS.bob)])
  } catch (error) {
    // The identity service is not running. The minted half of the run still
    // covers every claim about addressing and refusal; the real-token cases
    // say so and skip rather than passing without having verified anything.
    console.warn(`identity setup: ${IDENTITY_URL} is unreachable (${String(error)}); real-token cases will skip`)
  }

  const merged = { keys: [...identityKeys, runKey] }
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(merged))
  })
  await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', resolve) })
  const jwksUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/jwks`

  /** Mint one token with this run's key, which the merged key set publishes. */
  const mint = (claims: Record<string, string>, expiry: string): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITHM, kid: RUN_KID })
      .setIssuedAt().setIssuer(IDENTITY_URL).setAudience(IDENTITY_URL).setExpirationTime(expiry)
      .sign(run.privateKey)

  const one = await mint({ sub: 'usr_minted_one', org: 'org_minted_one' }, '10m')
  const two = await mint({ sub: 'usr_minted_two', org: 'org_minted_two' }, '10m')
  const [header, payload, signature] = one.split('.')
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
  const rewritten = Buffer.from(JSON.stringify({ ...claims, org: 'org_minted_two' })).toString('base64url')
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')

  const fixture: IdentityFixture = {
    TEST_JWKS_URL: jwksUrl,
    TEST_ISSUER: IDENTITY_URL,
    TEST_IDENTITY_LIVE: alice === '' ? '' : 'yes',
    TEST_ALICE_TOKEN: alice,
    TEST_BOB_TOKEN: bob,
    TEST_ALICE_OBJECT: alice === '' ? '' : objectNameOf(alice),
    TEST_BOB_OBJECT: bob === '' ? '' : objectNameOf(bob),
    TEST_MINTED_ONE: one,
    TEST_MINTED_TWO: two,
    TEST_EXPIRED: await mint({ sub: 'usr_minted_one', org: 'org_minted_one' }, '-1m'),
    TEST_TAMPERED: `${String(header)}.${rewritten}.${String(signature)}`,
    TEST_UNSIGNED: `${encode({ alg: 'none' })}.${encode({ sub: 'usr_minted_one', org: 'org_minted_one', iss: IDENTITY_URL, exp: Math.floor(Date.now() / 1000) + 600 })}.`,
  }
  project.provide('identityFixture', fixture)
}

/** Stop the key set once the run is over. */
export async function teardown(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve()
    else server.close(() => { resolve() })
  })
}

declare module 'vitest' {
  interface ProvidedContext {
    identityFixture: IdentityFixture
  }
}
