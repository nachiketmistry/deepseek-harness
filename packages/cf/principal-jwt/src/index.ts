/**
 * @deepseek-ai/dsh-principal-jwt — the Cloudflare `principal` provider.
 *
 * The Worker verifies the identity service's JWT and addresses a Durable
 * Object by `hostObjectName`, so by the time this plugin runs the
 * principal is already decided and recorded in the object's own name. The
 * provider reads it back from there rather than from anything a request
 * carries: a request that reached this object reached it because the edge
 * verified the principal the name was built from.
 *
 * [`./verify.ts`](./verify.ts) owns the edge half — the token check itself,
 * re-exported here because a package ships one runtime entry.
 * @module @deepseek-ai/dsh-principal-jwt
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PrincipalResolver, parseHostObjectName, type Principal } from '@deepseek-ai/dsh-principal'

export { PrincipalTokenError, PrincipalTokenVerifier, VerifierConfig } from './verify.ts'
export type { VerifiedToken } from './verify.ts'

/** Plugin configuration. */
export interface Config {
  /** This Durable Object's own name, as `hostObjectName` built it. */
  objectName: string
}

/**
 * Validated configuration. Required with no default: an object that cannot
 * say which principal it was addressed for must fail at boot rather than
 * serve requests under a name nobody chose.
 */
export const Config: z<Config> = z.object({
  objectName: z.string().required(),
})

/** Answers with the principal this Durable Object's name was built from. */
export class CfPrincipalResolver extends PrincipalResolver {
  static Config: z<Config> = Config

  private readonly principal: Principal

  /**
   * @param ctx - Cordis context the service registers on.
   * @param config - validated {@link Config}.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.principal = parseHostObjectName(config.objectName)
  }

  /**
   * The principal this object serves.
   * @returns the same principal for every request, because a different
   * principal is a different object.
   */
  current(): Principal {
    return this.principal
  }
}

export default CfPrincipalResolver
