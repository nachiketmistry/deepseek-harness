/**
 * The Worker the edge acceptance run loads: the deployment's own edge module,
 * paired with a Host object that records what it was addressed as instead of
 * booting the harness tree.
 *
 * The edge is the shipped one — `src/edge.ts`, the same module
 * `src/worker.ts` serves every request through — and the Durable Object
 * namespace, its SQLite storage, and `idFromName` are the runtime's own. What
 * this entry replaces is only the object's body, so the run can see which
 * object a request reached and what that object holds. The assembled Worker
 * cannot be loaded here: it is 15 MiB of bundled plugin tree, which the pool's
 * runtime exits on.
 */

import { DurableObject } from 'cloudflare:workers'
import { handleEdge, type EdgeEnv } from '../../../src/edge.ts'

/** One request this object was reached by. */
interface Visit {
  /** The name this object was addressed as, which the edge built from a verified principal. */
  readonly objectName: string
  /** The path the request asked for. */
  readonly path: string
}

/** Records every request it is reached by, in its own storage. */
export class HostObject extends DurableObject {
  /**
   * Answer one request by recording it and reporting this object's own state.
   * @param request - the forwarded request.
   * @returns this object's name and everything written to it.
   */
  override async fetch(request: Request): Promise<Response> {
    const objectName = this.ctx.id.name ?? '<unnamed>'
    const url = new URL(request.url)
    const visits = await this.ctx.storage.get<Visit[]>('visits') ?? []
    // A GET reports what is here; anything else writes. State written as one
    // principal is only ever readable through the object that principal names.
    if (request.method !== 'GET') {
      visits.push({ objectName, path: url.pathname })
      await this.ctx.storage.put('visits', visits)
    }
    return Response.json({ objectName, visits })
  }
}

export default {
  fetch(request: Request, env: EdgeEnv): Promise<Response> {
    return handleEdge(request, env)
  },
} satisfies ExportedHandler<EdgeEnv>
