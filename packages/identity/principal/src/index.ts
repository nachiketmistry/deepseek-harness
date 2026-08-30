/**
 * Service Definition for the verified-principal capability seam (`ctx.principal`).
 *
 * A Service Provider answers with the principal the deployment has already
 * verified for the current request; the seam never verifies anything itself.
 * A single-user deployment is not a separate code path, it is a deployment
 * whose provider always answers with the same principal.
 * @module @deepseek-ai/dsh-principal
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Principal } from './types.ts'

export { OrganizationId, UserId } from './brand.ts'
export {
  HOST_OBJECT_NAME_PREFIX,
  HOST_OBJECT_NAME_VERSION,
  hostObjectName,
  parseHostObjectName,
} from './host-object-name.ts'
export type { Principal, PrincipalSubject } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    principal: PrincipalResolver
  }
}

/**
 * Resolves the verified principal for the current request. Implementations
 * locate an answer that something upstream already established; none of them
 * owns the principal's lifetime, and none of them authenticates.
 */
export abstract class PrincipalResolver extends Service {
  constructor(ctx: Context) {
    super(ctx, 'principal')
  }

  /**
   * The principal this request acts as.
   * @returns the verified principal.
   */
  abstract current(): Principal
}

export default PrincipalResolver
