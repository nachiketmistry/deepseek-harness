/**
 * What the edge owes the deployment: one object per principal, and no object
 * at all for anyone the identity service did not vouch for.
 *
 * Every token here is signed the way the identity service signs — the real
 * service's keys and the run's own are published from one key set, so a real
 * token and a deliberately bad one meet the same verifier. `env` carries the
 * run's tokens as bindings (`tests/workerd/identity.setup.ts`).
 */

import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

/** The Worker under test: `wrangler.edge-test.jsonc`'s default export. */
const edge = exports.default
const ORIGIN = 'http://web.test'

/** What the recording Host object answers with. */
interface ObjectState {
  readonly objectName: string
  readonly visits: readonly { readonly objectName: string; readonly path: string }[]
}

/** Send one request through the edge as the holder of `token`. */
function as(token: string | undefined, path: string, init?: { method?: string; headers?: Record<string, string> }): Promise<Response> {
  return edge.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...init?.headers, ...token === undefined ? {} : { authorization: `Bearer ${token}` } },
  })
}

/** Read the object one token reaches, after asserting it was reached at all. */
async function objectFor(token: string, path = '/api/session.list', init?: { method?: string }): Promise<ObjectState> {
  const response = await as(token, path, init)
  expect(response.status, `${path} as a verified principal`).toBe(200)
  return await response.json() as ObjectState
}

describe('one object per principal', () => {
  it('sends two principals to two different objects', async () => {
    const one = await objectFor(env.TEST_MINTED_ONE)
    const two = await objectFor(env.TEST_MINTED_TWO)
    expect(one.objectName).toBe('dsh:1:org_minted_one:usr_minted_one')
    expect(two.objectName).toBe('dsh:1:org_minted_two:usr_minted_two')
    expect(one.objectName).not.toBe(two.objectName)
  })

  it('sends one principal to the same object every time', async () => {
    const first = await objectFor(env.TEST_MINTED_ONE)
    const again = await objectFor(env.TEST_MINTED_ONE)
    expect(again.objectName).toBe(first.objectName)
  })

  it('leaves state written as one principal unreadable as the other', async () => {
    const written = await objectFor(env.TEST_MINTED_ONE, '/api/session.create', { method: 'POST' })
    expect(written.visits.map(visit => visit.path)).toContain('/api/session.create')
    for (const visit of written.visits) expect(visit.objectName).toBe('dsh:1:org_minted_one:usr_minted_one')

    const other = await objectFor(env.TEST_MINTED_TWO)
    expect(other.visits.map(visit => visit.path)).not.toContain('/api/session.create')
    // The state is not hidden from the other principal, it is somewhere the
    // other principal has no way to address.
    expect(other.objectName).not.toBe(written.objectName)
  })

  it('accepts the token in the session cookie a browser carries', async () => {
    const exchanged = await edge.fetch(`${ORIGIN}/__dsh/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: env.TEST_MINTED_ONE }),
    })
    expect(exchanged.status).toBe(204)
    const cookie = exchanged.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^dsh-principal=/u)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')

    const carried = await edge.fetch(`${ORIGIN}/api/session.list`, {
      headers: { cookie: cookie.split(';', 1)[0] ?? '' },
    })
    expect(carried.status).toBe(200)
    const reached = await carried.json() as ObjectState
    expect(reached.objectName).toBe('dsh:1:org_minted_one:usr_minted_one')
  })
})

describe('no object for an unverified caller', () => {
  /** Every way a request can fail to name a principal this deployment verified. */
  const REFUSED: readonly (readonly [string, () => string | undefined])[] = [
    ['absent', () => undefined],
    ['tampered', () => env.TEST_TAMPERED],
    ['expired', () => env.TEST_EXPIRED],
    ['unsigned', () => env.TEST_UNSIGNED],
  ]

  it.each(REFUSED)('refuses a %s token', async (_kind, token) => {
    expect((await as(token(), '/api/session.list')).status).toBe(401)
  })

  // A refusal that reached an object would have booted a tenant's tree and
  // touched its storage, which is the thing edge verification exists to stop.
  it('reaches no object with any of them', async () => {
    // A path no accepted request in this run asks for, so finding it in an
    // object's state can only mean a refused request reached that object.
    const REFUSED_PATH = '/api/only-a-refused-request-asks-for-this'
    for (const [kind, token] of REFUSED) {
      const refused = await as(token(), REFUSED_PATH, { method: 'POST' })
      expect(refused.status, kind).toBe(401)
    }
    // Every object a refused token could have named, asked what it holds.
    for (const name of ['dsh:1:org_minted_one:usr_minted_one', 'dsh:1:org_minted_two:usr_minted_two']) {
      const stub = env.HOST.get(env.HOST.idFromName(name))
      const state = await (await stub.fetch(`${ORIGIN}/`)).json() as ObjectState
      expect(state.visits.map(visit => visit.path), name).not.toContain(REFUSED_PATH)
    }
  })

  it('answers a browser navigation with a page that can sign in', async () => {
    const navigation = await edge.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } })
    expect(navigation.status).toBe(401)
    expect(navigation.headers.get('content-type')).toContain('text/html')
    expect(await navigation.text()).toContain(env.TEST_ISSUER)
  })

  it('refuses to mint a session cookie from a token it does not accept', async () => {
    const refused = await edge.fetch(`${ORIGIN}/__dsh/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: env.TEST_TAMPERED }),
    })
    expect(refused.status).toBe(401)
    expect(refused.headers.get('set-cookie')).toBeNull()
  })

  it('gives up the session cookie on sign-out', async () => {
    const out = await edge.fetch(`${ORIGIN}/__dsh/signout`)
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

// The claims above hold for any correctly signed token. These hold for the
// tokens the identity service actually issues, which is the only way to know
// its `sub` and `org` reach the edge as the object name's two segments.
describe.skipIf(env.TEST_IDENTITY_LIVE !== 'yes')('tokens the identity service issued', () => {
  it('sends alice and bob to two different objects', async () => {
    const alice = await objectFor(env.TEST_ALICE_TOKEN)
    const bob = await objectFor(env.TEST_BOB_TOKEN)
    expect(alice.objectName).toBe(env.TEST_ALICE_OBJECT)
    expect(bob.objectName).toBe(env.TEST_BOB_OBJECT)
    expect(alice.objectName).not.toBe(bob.objectName)
  })

  it('leaves what alice wrote unreadable as bob', async () => {
    const alice = await objectFor(env.TEST_ALICE_TOKEN, '/api/alice-wrote-this', { method: 'POST' })
    expect(alice.visits.map(visit => visit.path)).toContain('/api/alice-wrote-this')
    const bob = await objectFor(env.TEST_BOB_TOKEN)
    expect(bob.visits.map(visit => visit.path)).not.toContain('/api/alice-wrote-this')
  })
})
