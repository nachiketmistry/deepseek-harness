/** What Connection asks about a browser request's authentication. @module @deepseek-ai/dsh-client-connection/browser-authority */

import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'

/**
 * Whoever decides that a browser request may reach this Host.
 *
 * Which implementation is mounted is a deployment fact, not a preference: a
 * Host reachable at a port owns the decision itself, and a Host reachable only
 * through an ingress that already made it does not.
 */
export interface BrowserAuthority {
  /**
   * Authenticate an index request, writing the refusal or redirect when it fails.
   * @param req - incoming root or configured-index request.
   * @param res - response owned by the implementation when this returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean

  /**
   * Decide whether one Host request is authenticated.
   * @param request - request headers carrying Host and Cookie.
   * @returns true when the request may be dispatched.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean

  /**
   * The application URL that admits its holder.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns the URL to hand the operator.
   */
  authenticatedUrl(baseUrl: string): string
}
