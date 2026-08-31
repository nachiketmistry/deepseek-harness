/** The Durable Object name a principal addresses. @module @deepseek-ai/dsh-principal/host-object-name */

import { OrganizationId, UserId } from './brand.ts'
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

/**
 * Identity-service identifier grammar. Better Auth issues `[A-Za-z0-9_-]`
 * identifiers, so a segment can hold no `:` and the name parses unambiguously.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * Compile-time guard for {@link parseHostObjectName}. A host object name
 * records the subject's identifier and not its kind, so reading one back is
 * unambiguous only while `user` is the sole variant. Adding a second variant
 * fails this assignment, at the point where the new variant's permanent name
 * segment has to be chosen.
 */
const PARSE_ASSUMES_ONE_SUBJECT_VARIANT: Exclude<PrincipalSubject['kind'], 'user'> extends never ? true : never = true

/**
 * Read a host object name back into the principal it was built from.
 *
 * The name is the durable record of which principal an object serves, so a
 * Durable Object addressed by {@link hostObjectName} recovers its own
 * principal from its own identity rather than from anything a request claims.
 * @param name - a name produced by {@link hostObjectName}.
 * @returns the principal that name addresses.
 * @throws when the name is not one this version builds, which is a name from
 * another namespace rather than a principal this build can serve.
 */
export function parseHostObjectName(name: string): Principal {
  void PARSE_ASSUMES_ONE_SUBJECT_VARIANT
  const segments = name.split(':')
  const [prefix, version, org, user] = segments
  if (segments.length !== 4
    || prefix !== HOST_OBJECT_NAME_PREFIX
    || version !== String(HOST_OBJECT_NAME_VERSION)
    || org === undefined || !SEGMENT_PATTERN.test(org)
    || user === undefined || !SEGMENT_PATTERN.test(user)) {
    throw new Error(`principal: ${JSON.stringify(name)} is not a ${HOST_OBJECT_NAME_PREFIX}:${String(HOST_OBJECT_NAME_VERSION)} host object name`)
  }
  return { org: OrganizationId(org), subject: { kind: 'user', user: UserId(user) } }
}
