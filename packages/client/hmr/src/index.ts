/**
 * HMR plugin, node half: the host end of the dev reload chain. One interval
 * stat-polls every graph row's client bundle (polling by design: network mounts
 * deliver no inotify events), reports changes through
 * `clientModuleHost.rebuilt(id)`, and serves the `/plugins/events` SSE channel
 * broadcasting graph/rebuilt frames to the browser half (src/client/).
 * The web bundle mounts this row unconditionally: without a rebuild
 * watcher rewriting client bundles, the poll observes no changes and the
 * chain stays idle.
 */
import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Empty type imports carry the clientModuleHost/webServer Context merges.
import type { ClientArtifactBaseline } from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PluginsEventFrame } from './events.ts'
import { EVENTS_ENDPOINT } from './events.ts'

export type { PluginsEventFrame } from './events.ts'
export { EVENTS_ENDPOINT } from './events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the web plugin table and the route registry. */
export const inject = ['clientModules', 'webServer']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500),
})

/** Serialize one frame as an SSE data line. */
function sseData(frame: PluginsEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

type WatchedBundleStat = Omit<ClientArtifactBaseline, 'path'>

type WatchedBundle = {
  -readonly [K in keyof ClientArtifactBaseline]: ClientArtifactBaseline[K]
} & { dirty: boolean }

/** Snapshot the executable bundle metadata that drives reloads. */
function bundleStat(path: string): WatchedBundleStat {
  const bundle = statSync(path)
  return { mtimeMs: bundle.mtimeMs, size: bundle.size }
}

/** Whether the executable bundle is unchanged since the last successful re-hash. */
function sameBundleStat(left: WatchedBundleStat, right: WatchedBundleStat): boolean {
  return left.mtimeMs === right.mtimeMs
    && left.size === right.size
}

/**
 * Mount the dev chain: bundle watches, rebuilt reporting, and the SSE channel.
 * @param ctx - host plugin context carrying clientModuleHost and webServer.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the field is set after validation.
  const pollIntervalMs = config.pollIntervalMs as number

  // --- bundle watch: one HMR-owned stat poll ------------------------------
  const watched = new Map<string, WatchedBundle>()

  const rehash = (id: string, watch: WatchedBundle, current: WatchedBundleStat): void => {
    try {
      // rebuilt() replaces the opaque startup rev on its first call; later
      // calls stay silent when the content hash is unchanged.
      ctx.clientModules.rebuilt(id)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        watch.dirty = true
        return
      }
      ctx.logger.warn(error)
    }
    watch.mtimeMs = current.mtimeMs
    watch.size = current.size
    watch.dirty = false
  }

  const watchRow = (id: string, baseline: ClientArtifactBaseline): void => {
    const watch: WatchedBundle = { ...baseline, dirty: false }
    watched.set(id, watch)
    let current: WatchedBundleStat
    try {
      current = bundleStat(baseline.path)
    } catch (error) {
      watch.dirty = true
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
      return
    }
    // The module host captured its baseline before reading the bytes in the
    // startup batch. Only a mismatch crosses into the content-hash path.
    if (!sameBundleStat(current, watch)) rehash(id, watch, current)
  }

  const pollWatches = (): void => {
    for (const [id, watch] of watched) {
      let current: WatchedBundleStat
      try {
        current = bundleStat(watch.path)
      } catch (error) {
        watch.dirty = true
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
        continue
      }
      if (!watch.dirty && sameBundleStat(current, watch)) continue
      // Stat-before-hash preserves a detectable older baseline for writes that
      // land during hashing. Repeated stat changes heal a torn read.
      rehash(id, watch, current)
    }
  }

  // Diff the watch set against the current graph: drop watches for removed
  // rows (or rows whose bundle path moved), add watches for new rows.
  const syncWatches = (): void => {
    const rows = new Map<string, ClientArtifactBaseline>()
    for (const row of ctx.clientModules.graph().entries) {
      const watch = ctx.clientModules.artifactBaseline(row.id)
      if (watch !== undefined) rows.set(row.id, watch)
    }
    for (const [id, watch] of watched) {
      if (rows.get(id)?.path === watch.path) continue
      watched.delete(id)
    }
    for (const [id, watch] of rows) {
      if (!watched.has(id)) watchRow(id, watch)
    }
  }

  ctx.effect(() => {
    // Initial sync covers rows already in the graph; the subscription covers
    // rows arriving later (boot-window activations, including this plugin's
    // own row — no self-exemption, a modules/hmr rebuild rides the same chain).
    syncWatches()
    const unsubscribe = ctx.clientModules.onGraphChanged(syncWatches)
    const timer = setInterval(pollWatches, pollIntervalMs)
    timer.unref()
    return () => {
      unsubscribe()
      clearInterval(timer)
      watched.clear()
    }
  }, 'client-hmr: bundle watches')

  // --- /plugins/events SSE channel ----------------------------------------
  const encoder = new TextEncoder()
  const connections = new Set<ReadableStreamDefaultController<Uint8Array>>()

  const connect = (request: Request): Response => {
    // Assigned by start(), which runs synchronously inside the constructor below.
    let release: () => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => { connections.delete(controller) }
        // Comment line on open so clients/proxies see a live channel even when
        // no rebuild ever happens; EventSource frame parsing skips it naturally.
        controller.enqueue(encoder.encode(': connected\n\n'))
        controller.enqueue(encoder.encode(sseData({ type: 'graph', graph: ctx.clientModules.graph() })))
        connections.add(controller)
        request.signal.addEventListener('abort', () => {
          release()
          try {
            controller.close()
          } catch {
            // Closed by the teardown below first; nothing remains to release.
          }
        }, { once: true })
      },
      cancel() {
        // The carrier stopped reading without aborting the request (a platform
        // entry cancelling the body): a cancelled stream rejects enqueue, so
        // the row leaves the broadcast set here.
        release()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      },
    })
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (request) => {
        // Named routes match ahead of the carrier's method gate; keep the old
        // global 405 semantics for non-GET hits on this endpoint.
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response(null, { status: 405 })
        }
        return connect(request)
      },
    })
    const unsubscribe = ctx.clientModules.onRebuilt((id, rev) => {
      const line = encoder.encode(sseData({ type: 'rebuilt', id, rev }))
      for (const controller of connections) controller.enqueue(line)
    })
    return () => {
      unsubscribe()
      disposeRoute()
      for (const controller of connections) controller.close()
      connections.clear()
    }
  }, 'client-hmr: /plugins/events channel')
}
