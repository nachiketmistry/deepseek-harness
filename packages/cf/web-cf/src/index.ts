/**
 * @deepseek-ai/dsh-web-cf — the browser-surface glue on Cloudflare. Claims
 * the webserver fallback seat over a Workers Assets binding (the built
 * frontend dist), rendering `index.html` through the carrier's injection
 * table, and registers the model-visible surface context: the
 * `app:web-surface` prompt section and the `DSH_WEB_URL` bash variable,
 * both naming the deployment's public URL.
 * @module @deepseek-ai/dsh-web-cf
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cf-bindings'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell-env'

/** Stable Cordis plugin name. */
export const name = 'web-cf'

/** Services required before the glue mounts. */
export const inject = ['webServer', 'cf', 'connection']

/** Plugin config. */
export interface Config {
  /** The Workers Assets binding name. */
  assets: string
  /** The public origin the browser loads from, for the surface context. */
  publicUrl: string
  /** Register the surface prompt section and the bash variable. */
  surfaceContext: boolean
}

export const Config: z<Config> = z.object({
  assets: z.string().default('ASSETS'),
  publicUrl: z.string().required(),
  surfaceContext: z.boolean().default(true),
})

/** The structural subset of a Workers Assets binding. */
interface AssetsBinding {
  fetch(request: Request | string): Promise<Response>
}

const DSH_WEB_URL = 'DSH_WEB_URL'

/**
 * Run Connection's synchronous index authentication and collect whatever it
 * writes as one Fetch response. The exchange sets a cookie and redirects, so
 * its head and body are captured rather than streamed.
 * @param ctx - plugin context carrying the connection service.
 * @param request - the index request being authenticated.
 * @returns the refusal or redirect response, or `undefined` when authenticated.
 */
function authorizeIndexResponse(ctx: Context, request: Request): Response | undefined {
  let status = 200
  let headers: Record<string, string> = {}
  let body: string | undefined
  const authenticated = ctx.connection.authorizeIndex(request, {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus
      headers = { ...nextHeaders }
    },
    end(nextBody) {
      body = nextBody
    },
  })
  if (authenticated) return undefined
  return new Response(body ?? null, { status, headers })
}

/** Model-visible orientation for sessions created through the deployed GUI. */
function webSurfacePrompt(webUrl: string): string {
  return `You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}, deployed on Cloudflare. `
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + 'Your tools run inside a sandbox container whose /workspace holds the user\'s git projects; the GUI itself is not served from that container, so starting a server there does not update this GUI.'
}

/**
 * Mount the glue: the authenticated assets fallback and the surface context.
 * @param ctx - plugin context carrying the webServer and cf services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const assets = ctx.cf.binding(config.assets) as AssetsBinding
  // The Node surface prints this line to a terminal the operator is watching.
  // A Worker has no terminal, so the deployment's own log stream is the one
  // place the launch token can be read, once per isolate that mints one.
  // `console` rather than `ctx.logger`, for the same reason `dsh web` prints
  // rather than logs: this is an operator handoff, not a diagnostic, and it
  // must not depend on a composed exporter or its level.
  console.log(`dsh web: ${ctx.connection.authenticatedUrl(config.publicUrl)}`)
  ctx.effect(() => ctx.webServer.registerFallback(async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Same rule the Node dist server applies: an index response passes
      // browser authentication before its bytes are read, which is also the
      // launch-token exchange. Non-index assets stay public.
      const refusal = authorizeIndexResponse(ctx, request)
      if (refusal !== undefined) return refusal
      const index = await assets.fetch(new URL('/index.html', url).toString())
      if (!index.ok) return new Response(`web-cf: index.html missing from assets (${String(index.status)})`, { status: 500 })
      const html = ctx.webServer.renderIndex(await index.text())
      return new Response(request.method === 'HEAD' ? null : html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    return assets.fetch(request)
  }), 'web-cf: fallback seat')
  if (!config.surfaceContext) return
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'app:web-surface',
      order: -98,
      text: () => webSurfacePrompt(config.publicUrl),
    })
  })
  ctx.inject(['shellEnv'], (runtimeCtx) => {
    runtimeCtx.shellEnv.register({
      name: 'web-runtime',
      variables: {
        [DSH_WEB_URL]: { description: 'Canonical public URL of the DeepSeek Harness Web GUI serving this session.' },
      },
      resolve: () => ({ [DSH_WEB_URL]: config.publicUrl }),
    })
  })
}
