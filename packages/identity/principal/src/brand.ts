/** Principal identifier brands. @module @deepseek-ai/dsh-principal/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity-service identifier for one organization. */
export type OrganizationId = Branded<'OrganizationId'>

/**
 * Brand an identity-service organization identifier.
 * @param value - opaque identifier issued by the identity service.
 * @returns the branded identifier.
 */
export function OrganizationId(value: string): OrganizationId {
  return value as OrganizationId
}

/** Opaque identity-service identifier for one user. */
export type UserId = Branded<'UserId'>

/**
 * Brand an identity-service user identifier.
 * @param value - opaque identifier issued by the identity service.
 * @returns the branded identifier.
 */
export function UserId(value: string): UserId {
  return value as UserId
}
