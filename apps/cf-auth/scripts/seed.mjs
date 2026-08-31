// Create the fixed development accounts against a running local auth service,
// and print what each one resolves to.
//
// Fixed rather than random so the credentials survive a restart and can be
// pasted into a client, and idempotent so re-running is not an error: an
// account that already exists is signed in rather than recreated.
//
// Talks HTTP to the running service instead of writing rows, so seeding
// exercises the same signup path a real user takes, including the hook that
// gives every user a personal organization.
const base = process.env.DSH_CF_AUTH_DEV_URL ?? 'http://localhost:8788'
const password = process.env.DSH_CF_AUTH_DEV_PASSWORD ?? 'dev-password-not-a-secret'

/** The accounts every local run can rely on being present. */
const ACCOUNTS = [
  { name: 'Alice Dev', email: 'alice@dev.invalid' },
  { name: 'Bob Dev', email: 'bob@dev.invalid' },
]

/** Collapse a Set-Cookie response header into a Cookie request header. */
function cookieHeader(response) {
  return (response.headers.get('set-cookie') ?? '')
    .split(',')
    .map(part => part.split(';')[0]?.trim() ?? '')
    .filter(part => part.length > 0)
    .join('; ')
}

// Better Auth rejects a state-changing request that carries no `Origin`, which
// is a header browsers always send and Node's fetch never does. Seeding sends
// the base URL, so it is checked against `trustedOrigins` exactly as a real
// client would be rather than through a weakened path.
const ORIGIN = { origin: base }

/** Post JSON to one of the auth service's routes. */
function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify(body),
  })
}

/**
 * Sign an account up, or sign it in when it already exists.
 * @returns the session cookie header.
 */
async function establish(account) {
  const signUp = await post('/api/auth/sign-up/email', { ...account, password })
  if (signUp.ok) return { cookie: cookieHeader(signUp), created: true }

  const signIn = await post('/api/auth/sign-in/email', { email: account.email, password })
  if (signIn.ok) return { cookie: cookieHeader(signIn), created: false }

  throw new Error(
    `seed: ${account.email} could neither sign up (${String(signUp.status)}: ${await signUp.text()})`
    + ` nor sign in (${String(signIn.status)}: ${await signIn.text()})`,
  )
}

/** Read the claims the harness edge addresses a Durable Object with. */
async function claims(cookie) {
  const issued = await fetch(`${base}/api/auth/token`, { headers: { cookie, ...ORIGIN } })
  if (!issued.ok) throw new Error(`seed: token request failed (${String(issued.status)}: ${await issued.text()})`)
  const { token } = await issued.json()
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  return { token, ...payload }
}

const rows = []
for (const account of ACCOUNTS) {
  const { cookie, created } = await establish(account)
  const { token, sub, org } = await claims(cookie)
  rows.push({ email: account.email, state: created ? 'created' : 'existing', org, sub })
  console.log(`${account.email}  ${created ? 'created ' : 'existing'}  org=${org}  sub=${sub}`)
  console.log(`  token: ${token}`)
}

console.log(`\npassword for all accounts: ${password}`)
const distinct = new Set(rows.map(row => `${row.org}:${row.sub}`))
if (distinct.size !== rows.length) throw new Error('seed: two accounts share one principal; addressing would collide')
console.log(`${String(rows.length)} accounts, ${String(distinct.size)} distinct principals`)
