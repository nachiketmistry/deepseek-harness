/** The Durable Object name a principal addresses. @module @deepseek-ai/dsh-principal/host-object-name */

import type { Principal, PrincipalSubject } from './types.ts'

/**
 * Naming-scheme version carried in every host object name. A Durable Object
 * cannot be renamed, so the only recovery from a naming mistake is to start a
 * new namespace deliberately; this segment is what makes that a decision
 * instead of a collision with the objects already addressed.
 */
export const HOST_OBJECT_NAME_VERSION = 1

/** Fixed leading segment separating principal-addressed objects from any other name in the same class. */
export const HOST_OBJECT_NAME_PREFIX = 'dsh'

/**
 * The name segment each subject variant contributes. Written as an exhaustive
 * map rather than a switch so a new variant fails to compile here, where its
 * permanent key segment has to be chosen, instead of falling through.
 */
const SUBJECT_SEGMENT: {
  readonly [K in PrincipalSubject['kind']]: (subject: Extract<PrincipalSubject, { kind: K }>) => string
} = {
  user: subject => subject.user,
}

/**
 * Build the Durable Object name one principal addresses:
 * `dsh:1:<orgId>:<subjectId>`. This is the single place that string is
 * constructed, because every segment of it is permanent.
 *
 * The organization identifier is present even while a user belongs to exactly
 * one personal organization: keying by subject alone and adding organizations
 * later re-keys every object, and `idFromName` has no rename.
 * @param principal - the verified caller.
 * @returns the object name, unambiguous because identity-service identifiers cannot contain `:`.
 */
export function hostObjectName(principal: Principal): string {
  const { subject } = principal
  return `${HOST_OBJECT_NAME_PREFIX}:${HOST_OBJECT_NAME_VERSION}:${principal.org}:${SUBJECT_SEGMENT[subject.kind](subject)}`
}
