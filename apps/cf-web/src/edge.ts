/**
 * The edge half of the dsh web GUI on Cloudflare: everything that runs before a
 * Durable Object is addressed.
 *
 * Verification happens here rather than inside the object because an object
 * must be addressed before it can run, so a check inside it happens after the
 * tenant was already chosen. Refusing here is what makes isolation structural:
 * the object cannot serve the wrong principal because it was never addressed
 * for them.
 * @module
 */

import { PrincipalTokenVerifier, VerifierConfig } from '@deepseek-ai/dsh-principal-jwt'
import { hostObjectName } from '@deepseek-ai/dsh-principal'
import { EDGE_ROUTES, signInPage, signOutPage } from './sign-in.ts'

/** What the edge is parameterized by, which is the subset of the Worker's bindings it reads. */
export interface EdgeEnv {
  /** The Host object namespace, addressed by the name a verified principal builds. */
  HOST: DurableObjectNamespace
  /** Public origin of the identity service, which the sign-in page talks to directly. */
  AUTH_BASE_URL: string
  /** Key set every accepted token is verified against. */
  AUTH_JWKS_URL: string
  /** Issuer every accepted token must name. */
  AUTH_ISSUER: string
  /** Shortest interval between two key-set fetches, in seconds. Optional; the verifier defaults it. */
  AUTH_JWKS_REFRESH_FLOOR_SECONDS?: string
}

/** Cookie this deployment carries a verified token in, so a WebSocket upgrade presents it too. */
const SESSION_COOKIE = 'dsh-principal'

/**
 * One verifier per isolate. The JWKS cache and its refresh floor live inside
 * it, so a verifier rebuilt per request would refetch the identity service's
 * key set on every request and the floor would protect nothing.
 */
let verifier: PrincipalTokenVerifier | undefined

/** The isolate's verifier, built from this deployment's bindings on first use. */
function verifierFor(env: EdgeEnv): PrincipalTokenVerifier {
  verifier ??= new PrincipalTokenVerifier(VerifierConfig({
    jwksUrl: env.AUTH_JWKS_URL,
    issuer: env.AUTH_ISSUER,
    ...(env.AUTH_JWKS_REFRESH_FLOOR_SECONDS === undefined
      ? {}
      : { refreshFloorSeconds: Number(env.AUTH_JWKS_REFRESH_FLOOR_SECONDS) }),
  } as VerifierConfig))
  return verifier
}

/** Read the exact session cookie without implementing general Cookie decoding. */
function sessionToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')
  if (authorization?.startsWith('Bearer ') === true) return authorization.slice('Bearer '.length)
  for (const segment of (request.headers.get('cookie') ?? '').split(';')) {
    const at = segment.indexOf('=')
    if (at !== -1 && segment.slice(0, at).trim() === SESSION_COOKIE) return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize this deployment's session cookie; `Secure` for the https origins a deployment is reached at. */
function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

/**
 * Refuse a request that carries no principal this deployment verified.
 *
 * A navigation is answered with the sign-in page as the refusal's own body
 * rather than a redirect to it: the status stays the fact that the request was
 * refused, and a person still gets somewhere they can sign in.
 */
function refuse(request: Request, env: EdgeEnv): Response {
  const wantsPage = request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html')
  return new Response(wantsPage ? signInPage(env.AUTH_BASE_URL) : 'dsh web: sign in to reach this deployment.\n', {
    status: 401,
    headers: {
      'cache-control': 'no-store',
      'content-type': wantsPage ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    },
  })
}

/**
 * Exchange a token the browser obtained from the identity service for this
 * deployment's session cookie. The token is verified here, so a cookie only
 * ever holds one this deployment already accepted, and the cookie expires with
 * the token rather than outliving it.
 */
async function startSession(request: Request, env: EdgeEnv): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  let token: unknown
  try {
    const body = await request.json() as { token?: unknown }
    token = body.token
  } catch {
    return new Response('dsh web: expected a JSON body naming a token.\n', { status: 400 })
  }
  if (typeof token !== 'string') return new Response('dsh web: expected a JSON body naming a token.\n', { status: 400 })
  let expiresAt: number
  try {
    expiresAt = (await verifierFor(env).verify(token)).expiresAt
  } catch {
    return new Response('dsh web: that token is not one this deployment accepts.\n', { status: 401 })
  }
  // The cookie expires with the token it holds rather than outliving it, so a
  // browser never presents a credential the edge has started refusing.
  const maxAge = Math.max(1, expiresAt - Math.floor(Date.now() / 1000))
  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'set-cookie': sessionCookie(token, maxAge, new URL(request.url).protocol === 'https:'),
    },
  })
}

/** Give up this deployment's session cookie, and serve the page that ends the identity session too. */
function endSession(request: Request, env: EdgeEnv): Response {
  return new Response(signOutPage(env.AUTH_BASE_URL), {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': sessionCookie('', 0, new URL(request.url).protocol === 'https:'),
    },
  })
}

/**
 * Answer one request at the edge: obtain or give up a principal, refuse a
 * request that carries none this deployment verified, or address the one
 * object that principal names.
 * @param request - the incoming request.
 * @param env - this deployment's bindings.
 * @returns the response, from the edge itself or from the addressed object.
 */
export async function handleEdge(request: Request, env: EdgeEnv): Promise<Response> {
  const { pathname } = new URL(request.url)
  // Both routes exist to obtain or give up a principal, so neither can
  // require one; they are answered here and reach no object either way.
  if (pathname === EDGE_ROUTES.session) return startSession(request, env)
  if (pathname === EDGE_ROUTES.signOut) return endSession(request, env)
  const token = sessionToken(request)
  if (token === undefined) return refuse(request, env)
  let name: string
  try {
    name = hostObjectName((await verifierFor(env).verify(token)).principal)
  } catch {
    return refuse(request, env)
  }
  return env.HOST.get(env.HOST.idFromName(name)).fetch(request)
}
