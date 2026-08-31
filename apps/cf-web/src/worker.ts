/**
 * The dsh web GUI on Cloudflare. The Worker verifies the identity service's
 * token before it addresses anything, then forwards the request to the Host
 * Durable Object named for the principal that token names. Isolation is
 * therefore structural: an object cannot serve the wrong tenant because it was
 * never addressed for them. The object boots the harness plugin tree from the
 * build-time composition (`dist/generated`) on each wake and dispatches
 * requests through the webserver carrier. The Sandbox SDK's Durable Object
 * class is re-exported so the container binding resolves in this Worker.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Context } from '@deepseek-ai/cordis'
import { bootEntries } from '@deepseek-ai/dsh-app-boot'
import CfBindings, { type CfPlatform, type CfServerSocket } from '@deepseek-ai/dsh-cf-bindings'
import CfWebServer from '@deepseek-ai/dsh-webserver-cf'
import StaticClientBundleSource from '@deepseek-ai/dsh-client-bundle-source-static'
import StaticAgentPresetSource, { type StaticAgentPreset } from '@deepseek-ai/dsh-agent-presets-static'
import StaticTypertArtifactSource from '@deepseek-ai/dsh-typert-artifacts-static'
import CfPrincipalResolver from '@deepseek-ai/dsh-principal-jwt'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { handleEdge, type EdgeEnv } from './edge.ts'
import { modules } from '../dist/generated/modules.js'
import { clientTable } from '../dist/generated/client-table.js'
import { typertTable } from '../dist/generated/typert-table.js'
import composition from '../dist/generated/composition.json'
import presets from '../dist/generated/presets.json'

export { Sandbox } from '@cloudflare/sandbox'

/** Bindings this Worker is deployed with (wrangler.jsonc). */
interface Env extends EdgeEnv {
  HOST: DurableObjectNamespace<HostObject>
  [binding: string]: unknown
}

const BIN_NAME = 'dsh-cf-web'

/**
 * Boot the plugin tree over the Durable Object's platform handle.
 * @param platform - the object's bindings, storage, and sockets.
 * @param objectName - the object's own name, absent when it was addressed by a generated id.
 * @returns the booted tree and its carrier.
 */
async function bootTree(platform: CfPlatform, objectName: string | undefined): Promise<{ ctx: Context; carrier: CfWebServer }> {
  if (objectName === undefined) {
    throw new Error(`${BIN_NAME}: this Host object was addressed by a generated id; only a name built from a verified principal is served`)
  }
  let carrier: CfWebServer | undefined
  const ctx = await bootEntries(BIN_NAME, composition.rows as EntryOptions[], {
    modules,
    async prepare(root) {
      await root.plugin(CfBindings, platform)
      await root.plugin(CfWebServer)
      await root.plugin(CfPrincipalResolver, { objectName })
      await root.plugin(StaticClientBundleSource, clientTable)
      await root.plugin(StaticTypertArtifactSource, typertTable)
      await root.plugin(StaticAgentPresetSource, new Map(Object.entries(presets as Record<string, StaticAgentPreset>)))
      carrier = root.webServer as CfWebServer
    },
  })
  if (carrier === undefined) throw new Error(`${BIN_NAME}: carrier missing after boot`)
  return { ctx, carrier }
}

/** The Host Durable Object: one principal's harness tree, its storage, and its sockets. */
export class HostObject extends DurableObject<Env> {
  private readonly tree: Promise<{ ctx: Context; carrier: CfWebServer }>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const platform: CfPlatform = {
      env,
      // The platform handle's SQL cursor type is the structural subset of the runtime's; the
      // runtime constrains row values to SQL scalars, which the subset leaves to each provider.
      storage: ctx.storage as unknown as CfPlatform['storage'],
      sockets: {
        acceptWebSocket: (socket, tags) => { ctx.acceptWebSocket(socket as unknown as WebSocket, tags) },
        getWebSockets: tag => ctx.getWebSockets(tag) as unknown as CfServerSocket[],
      },
      waitUntil: (promise) => { ctx.waitUntil(promise) },
    }
    // The object's own name is the durable record of which principal it serves,
    // and it survives hibernation, which a request header does not: a socket
    // message delivered after a wake carries no request to read a principal from.
    this.tree = bootTree(platform, ctx.id.name).then((tree) => {
      tree.carrier.recover()
      return tree
    })
    // A boot failure surfaces on the first request; keep it from being an unhandled rejection meanwhile.
    this.tree.catch(() => {})
  }

  override async fetch(request: Request): Promise<Response> {
    let tree: { carrier: CfWebServer }
    try {
      tree = await this.tree
    } catch (error) {
      return new Response(`dsh-cf-web: boot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, { status: 503 })
    }
    return tree.carrier.handle(request)
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    (await this.tree).carrier.message(ws as unknown as CfServerSocket, message)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    (await this.tree).carrier.closed(ws as unknown as CfServerSocket)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    (await this.tree).carrier.errored(ws as unknown as CfServerSocket)
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleEdge(request, env)
  },
} satisfies ExportedHandler<Env>
