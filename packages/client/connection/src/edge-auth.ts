/**
 * Browser authentication for a Host whose deployment authenticates upstream.
 *
 * A deployment can put the whole Host behind an ingress that verifies every
 * request before it can be routed at all — on Cloudflare, a Durable Object is
 * reachable only through the Worker holding its binding, and that Worker
 * verifies the identity service's token before it addresses an object. Making
 * the Host re-check a credential of its own there does not add a check, it adds
 * a second credential: a deployment-wide launch token that admits anyone who
 * has it, in front of a Host that was already reached under one caller's name.
 * @module @deepseek-ai/dsh-client-connection/edge-auth
 */

import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'
import type { BrowserAuthority } from './browser-authority.ts'

/** Admits every request, because the deployment's ingress already refused the rest. */
export class EdgeVerifiedAuthority implements BrowserAuthority {
  /**
   * @param _req - the index request the ingress already authenticated.
   * @param _res - unused: nothing is refused here, so nothing is written.
   * @returns true, always.
   */
  authorizeIndex(_req: ConnectionIndexRequest, _res: ConnectionIndexResponse): boolean {
    return true
  }

  /**
   * @param _request - the request the ingress already authenticated.
   * @returns true, always.
   */
  isAuthenticated(_request: ConnectionTrustRequest): boolean {
    return true
  }

  /**
   * @param _baseUrl - unused.
   * @returns never.
   * @throws always: a URL that admits its holder is exactly what this
   * deployment does not have, so a caller asking for one has to be told rather
   * than handed a link that authenticates nobody.
   */
  authenticatedUrl(_baseUrl: string): string {
    throw new Error('client-connection: this deployment authenticates at its ingress and mints no launch URL')
  }
}
