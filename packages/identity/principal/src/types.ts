/** Verified-principal value types. @module @deepseek-ai/dsh-principal/types */

import type { OrganizationId, UserId } from './brand.ts'

/**
 * Who a verified request acts as, within its organization. A union rather than
 * a bare user id because a client-credentials caller is a machine with no user,
 * and widening the subject later would break every consumer of the seam.
 */
export type PrincipalSubject =
  | { readonly kind: 'user'; readonly user: UserId }

/**
 * One verified caller: the organization that owns the state, and the subject
 * acting inside it. Both identifiers are opaque and issued by the identity
 * service; neither is an email or any other value a person can change, because
 * both reach {@link hostObjectName} and other permanent keys.
 */
export interface Principal {
  /** The organization whose state this caller reaches. */
  readonly org: OrganizationId
  /** Who is acting inside that organization. */
  readonly subject: PrincipalSubject
}
