import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'
import { PrincipalTokenError, PrincipalTokenVerifier, VerifierConfig } from '@deepseek-ai/dsh-principal-jwt'

const ISSUER = 'http://identity.invalid'
const AUDIENCE = 'http://identity.invalid'
const ALGORITHM = 'EdDSA'

let keys: Awaited<ReturnType<typeof generateKeyPair>>
/** A second key the served JWKS never publishes, for a signature no key verifies. */
let foreign: Awaited<ReturnType<typeof generateKeyPair>>
let jwks: { keys: JWK[] }
let server: Server
let jwksUrl: string
/** How many times the verifier has fetched the key set, for the refresh floor. */
let fetches = 0

/** Sign one token with the published key, with claims overridden per case. */
async function sign(claims: Record<string, unknown>, options?: { key?: CryptoKey; expiresIn?: string }): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM, kid: 'published' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(options?.expiresIn ?? '5m')
    .sign(options?.key ?? keys.privateKey)
}

function verifier(overrides?: Partial<VerifierConfig>): PrincipalTokenVerifier {
  return new PrincipalTokenVerifier(VerifierConfig({ jwksUrl, issuer: ISSUER, ...overrides } as VerifierConfig))
}

beforeAll(async () => {
  keys = await generateKeyPair(ALGORITHM)
  foreign = await generateKeyPair(ALGORITHM)
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), alg: ALGORITHM, kid: 'published' }] }
  server = createServer((_request, response) => {
    fetches += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(jwks))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  jwksUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/auth/jwks`
})

afterAll(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))

describe('PrincipalTokenVerifier', () => {
  it('reads the principal out of a token the identity service signed', async () => {
    const before = Math.floor(Date.now() / 1000)
    const verified = await verifier().verify(await sign({ sub: 'usr_1', org: 'org_a' }))
    expect(verified.principal).toStrictEqual({ org: 'org_a', subject: { kind: 'user', user: 'usr_1' } })
    expect(verified.expiresAt).toBeGreaterThan(before)
  })

  it('accepts a token naming the audience the deployment scopes to', async () => {
    const scoped = verifier({ audience: AUDIENCE })
    expect((await scoped.verify(await sign({ sub: 'usr_1', org: 'org_a' }))).principal).toStrictEqual({
      org: 'org_a',
      subject: { kind: 'user', user: 'usr_1' },
    })
  })

  // A session cookie lasts as long as the token in it, so a token with no
  // expiry would be a session the identity service can no longer end.
  it('refuses a token that never expires', async () => {
    const endless = await new SignJWT({ sub: 'usr_1', org: 'org_a' })
      .setProtectedHeader({ alg: ALGORITHM, kid: 'published' })
      .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE)
      .sign(keys.privateKey)
    await expect(verifier().verify(endless)).rejects.toThrow(PrincipalTokenError)
  })

  it('refuses a token naming another audience than the one configured', async () => {
    const scoped = verifier({ audience: 'http://elsewhere.invalid' })
    await expect(scoped.verify(await sign({ sub: 'usr_1', org: 'org_a' }))).rejects.toThrow(PrincipalTokenError)
  })

  // The attack the object name exists to defeat: keep a token that verified
  // and rewrite the organization it names.
  it('refuses a token whose claims were rewritten under its signature', async () => {
    const token = await sign({ sub: 'usr_1', org: 'org_a' })
    const [header, payload, signature] = token.split('.') as [string, string, string]
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const rewritten = Buffer.from(JSON.stringify({ ...claims, org: 'org_b' })).toString('base64url')
    await expect(verifier().verify(`${header}.${rewritten}.${signature}`)).rejects.toThrow(PrincipalTokenError)
  })

  it('refuses a token whose signature was altered', async () => {
    const token = await sign({ sub: 'usr_1', org: 'org_a' })
    const [header, payload, signature] = token.split('.') as [string, string, string]
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
    await expect(verifier().verify(`${header}.${payload}.${flipped}`)).rejects.toThrow(PrincipalTokenError)
  })

  it('refuses a token signed by a key the identity service does not publish', async () => {
    await expect(verifier().verify(await sign({ sub: 'usr_1', org: 'org_a' }, { key: foreign.privateKey })))
      .rejects.toThrow(PrincipalTokenError)
  })

  it('refuses a token whose lifetime has run out', async () => {
    const expired = await sign({ sub: 'usr_1', org: 'org_a' }, { expiresIn: '-1m' })
    await expect(verifier().verify(expired)).rejects.toThrow(PrincipalTokenError)
  })

  it('refuses an unsigned token', async () => {
    const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = `${encode({ alg: 'none' })}.${encode({ sub: 'usr_1', org: 'org_a', iss: ISSUER })}.`
    await expect(verifier().verify(unsigned)).rejects.toThrow(PrincipalTokenError)
  })

  it('refuses a token issued by another service', async () => {
    const elsewhere = await new SignJWT({ sub: 'usr_1', org: 'org_a' })
      .setProtectedHeader({ alg: ALGORITHM, kid: 'published' })
      .setIssuedAt().setIssuer('http://elsewhere.invalid').setExpirationTime('5m')
      .sign(keys.privateKey)
    await expect(verifier().verify(elsewhere)).rejects.toThrow(PrincipalTokenError)
  })

  it('refuses text that is not a token at all', async () => {
    await expect(verifier().verify('not-a-token')).rejects.toThrow(PrincipalTokenError)
  })

  // Both claims land in a permanent Durable Object name, so a token that
  // verified but names something the name cannot hold is still refused.
  it.each([
    [{ sub: 'usr_1' }, 'no organization'],
    [{ org: 'org_a' }, 'no subject'],
    [{ sub: 'usr_1', org: 42 }, 'an organization that is not a string'],
    [{ sub: 'usr_1', org: 'org:a' }, 'an organization holding the name separator'],
    [{ sub: '', org: 'org_a' }, 'an empty subject'],
  ])('refuses a verified token with %j (%s)', async (claims, _why) => {
    await expect(verifier().verify(await sign(claims))).rejects.toThrow(/identity-service identifier/)
  })

  it('does not refetch the key set for an unknown kid inside the refresh floor', async () => {
    const floored = verifier({ refreshFloorSeconds: 3600 })
    await floored.verify(await sign({ sub: 'usr_1', org: 'org_a' }))
    const afterFirst = fetches
    const unknownKid = await new SignJWT({ sub: 'usr_1', org: 'org_a' })
      .setProtectedHeader({ alg: ALGORITHM, kid: 'never-published' })
      .setIssuedAt().setIssuer(ISSUER).setExpirationTime('5m')
      .sign(keys.privateKey)
    await expect(floored.verify(unknownKid)).rejects.toThrow(PrincipalTokenError)
    expect(fetches).toBe(afterFirst)
  })
})

describe('VerifierConfig', () => {
  // wrangler vars supply this, so a deployment that named no identity service
  // is reachable input rather than a value the static interface excludes.
  it.each([
    [{}, 'neither the key set nor the issuer'],
    [{ jwksUrl: 'http://identity.invalid/api/auth/jwks' }, 'no issuer'],
    [{ issuer: ISSUER }, 'no key set'],
  ])('refuses a deployment naming %j (%s)', (config, _why) => {
    expect(() => VerifierConfig(config as VerifierConfig)).toThrow()
  })

  it('defaults the cache tunables the deployment did not choose', () => {
    const config = VerifierConfig({ jwksUrl: 'http://identity.invalid/api/auth/jwks', issuer: ISSUER } as VerifierConfig)
    expect(config.refreshFloorSeconds).toBeGreaterThan(0)
    expect(config.cacheMaxAgeSeconds).toBeGreaterThan(config.refreshFloorSeconds)
    expect(config.clockToleranceSeconds).toBeGreaterThanOrEqual(0)
  })
})
