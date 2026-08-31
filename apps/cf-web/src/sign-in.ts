/**
 * The sign-in surface the Worker serves before any Durable Object is addressed.
 *
 * It is deliberately the smallest page that can obtain a token: the browser
 * talks to the identity service directly, so this deployment never sees a
 * password, and hands back only the token it received. The page is served as
 * the body of the 401 that refuses an unauthenticated navigation, so a person
 * who opens the application sees how to sign in without the refusal itself
 * becoming a redirect that hides which requests were refused.
 * @module
 */

/** Better Auth's own routes on the identity service; fixed by that service, not by this deployment. */
const IDENTITY_ROUTES = {
  token: '/api/auth/token',
  signIn: '/api/auth/sign-in/email',
  signOut: '/api/auth/sign-out',
} as const

/** Where this Worker exchanges a token for a session cookie, and gives one up. */
export const EDGE_ROUTES = {
  session: '/__dsh/session',
  signOut: '/__dsh/signout',
} as const

/** Escape a deployment value for a `<script>` body, where `</script>` would end the element. */
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

const STYLE = `
  :root { color-scheme: light dark }
  body { font: 15px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0 }
  form { display: grid; gap: .75rem; width: min(22rem, 90vw) }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem }
  input, button { font: inherit; padding: .5rem .6rem }
  p { margin: 0; min-height: 1.5em; color: #b00 }
  [hidden] { display: none !important }
`

/**
 * The sign-in page.
 *
 * The page tries the identity service's token route first: a browser that
 * still holds an identity session is signed in again without being asked for a
 * password, which is what makes an expired token a reload rather than a
 * prompt. Only when that fails is the form shown.
 * @param identityBaseUrl - public origin of the identity service.
 * @returns the complete HTML document.
 */
export function signInPage(identityBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>${STYLE}</style>
<form id="f" hidden>
  <h1>Sign in</h1>
  <input id="email" type="email" name="email" placeholder="email" autocomplete="username" required>
  <input id="password" type="password" name="password" placeholder="password" autocomplete="current-password" required>
  <button id="submit" type="submit">Sign in</button>
  <p id="error" role="alert"></p>
</form>
<script type="module">
const identity = ${scriptLiteral(identityBaseUrl)}
const form = document.getElementById('f')
const error = document.getElementById('error')

/**
 * Ask the identity service for a token this deployment can verify.
 * Answering undefined covers an unreachable service as well as a browser
 * holding no identity session: either way the only way on is the form.
 */
async function token() {
  try {
    const response = await fetch(identity + ${scriptLiteral(IDENTITY_ROUTES.token)}, { credentials: 'include' })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body.token === 'string' ? body.token : undefined
  } catch {
    return undefined
  }
}

/** Exchange a token for this deployment's session cookie, then load the application. */
async function start(value) {
  const response = await fetch(${scriptLiteral(EDGE_ROUTES.session)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: value }),
  })
  if (!response.ok) throw new Error(await response.text())
  location.replace('/')
}

const existing = await token()
if (existing === undefined) form.hidden = false
else {
  try {
    await start(existing)
  } catch (failure) {
    // The identity session is live but this deployment refused its token.
    // Showing the form is the only remaining way in.
    form.hidden = false
    error.textContent = failure instanceof Error ? failure.message : String(failure)
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  error.textContent = ''
  try {
    const response = await fetch(identity + ${scriptLiteral(IDENTITY_ROUTES.signIn)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    })
    if (!response.ok) throw new Error('That email and password did not sign in.')
    const issued = await token()
    if (issued === undefined) throw new Error('Signed in, but the identity service issued no token.')
    await start(issued)
  } catch (failure) {
    error.textContent = failure instanceof Error ? failure.message : String(failure)
  }
})
</script>
`
}

/**
 * The sign-out page.
 *
 * This deployment's cookie is cleared by the response carrying this page; the
 * page then ends the identity session too, because a browser that kept one
 * would be signed straight back in by the page above.
 * @param identityBaseUrl - public origin of the identity service.
 * @returns the complete HTML document.
 */
export function signOutPage(identityBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Signing out</title>
<style>${STYLE}</style>
<p id="status">Signing out…</p>
<script type="module">
try {
  await fetch(${scriptLiteral(identityBaseUrl)} + ${scriptLiteral(IDENTITY_ROUTES.signOut)}, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
} catch {
  // The identity service is unreachable: this deployment's own cookie is
  // already gone, so the browser is signed out here either way.
}
location.replace('/')
</script>
`
}
