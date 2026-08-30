/**
 * @deepseek-ai/dsh-principal-local — `principal` provider that answers with one
 * configured principal for every request.
 *
 * This is what a deployment with no identity service looks like from inside the
 * harness: the CLI and headless profiles get a real principal, so nothing has to
 * branch on whether identity exists, and the storage, settings, and object keys
 * derived from it are the same shape a multi-principal deployment writes.
 * @module @deepseek-ai/dsh-principal-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { OrganizationId, PrincipalResolver, UserId, type Principal } from '@deepseek-ai/dsh-principal'

/** Plugin configuration. */
export interface Config {
  /** Opaque organization identifier every request in this deployment acts within. */
  org: string
  /** Opaque user identifier every request in this deployment acts as. */
  user: string
}

/**
 * Validated configuration. Both identifiers are required rather than defaulted:
 * they land in permanent object and storage keys, so a deployment that has not
 * chosen them must fail at load rather than silently adopt a shared name.
 */
export const Config: z<Config> = z.object({
  org: z.string().required(),
  user: z.string().required(),
})

/** Answers every request with the one principal this deployment was configured for. */
export class LocalPrincipalResolver extends PrincipalResolver {
  static Config = Config

  private readonly principal: Principal

  /**
   * @param ctx - Cordis context the service registers on.
   * @param config - the deployment's single principal.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.principal = {
      org: OrganizationId(config.org),
      subject: { kind: 'user', user: UserId(config.user) },
    }
  }

  /**
   * The configured principal.
   * @returns the same principal for every request in this deployment.
   */
  current(): Principal {
    return this.principal
  }
}

export default LocalPrincipalResolver
