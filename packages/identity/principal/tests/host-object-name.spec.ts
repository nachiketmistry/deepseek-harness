import { describe, expect, it } from 'vitest'
import {
  HOST_OBJECT_NAME_PREFIX,
  HOST_OBJECT_NAME_VERSION,
  OrganizationId,
  UserId,
  hostObjectName,
  parseHostObjectName,
  type Principal,
} from '@deepseek-ai/dsh-principal'

function principal(org: string, user: string): Principal {
  return { org: OrganizationId(org), subject: { kind: 'user', user: UserId(user) } }
}

describe('hostObjectName', () => {
  it('names the object by version, organization, and subject', () => {
    expect(hostObjectName(principal('org_a', 'usr_1'))).toBe('dsh:1:org_a:usr_1')
  })

  it('exposes the segments it builds the name from', () => {
    expect(HOST_OBJECT_NAME_PREFIX).toBe('dsh')
    expect(HOST_OBJECT_NAME_VERSION).toBe(1)
  })

  it('gives two principals in different organizations different names', () => {
    expect(hostObjectName(principal('org_a', 'usr_1')))
      .not.toBe(hostObjectName(principal('org_b', 'usr_1')))
  })

  it('gives two subjects in one organization different names', () => {
    expect(hostObjectName(principal('org_a', 'usr_1')))
      .not.toBe(hostObjectName(principal('org_a', 'usr_2')))
  })

  it('gives one principal the same name every time', () => {
    expect(hostObjectName(principal('org_a', 'usr_1'))).toBe(hostObjectName(principal('org_a', 'usr_1')))
  })
})

describe('parseHostObjectName', () => {
  it('recovers the principal a name was built from', () => {
    const original = principal('org_a', 'usr_1')
    expect(parseHostObjectName(hostObjectName(original))).toStrictEqual(original)
  })

  it('recovers every identifier character the identity service issues', () => {
    const original = principal('Org-A_9', 'usr-1_Z')
    expect(parseHostObjectName(hostObjectName(original))).toStrictEqual(original)
  })

  // A Durable Object name is durable input read back from the platform, so a
  // name from another namespace is reachable rather than excluded by types.
  it.each([
    ['', 'empty'],
    ['default', 'the name every caller shared before addressing was per-principal'],
    ['dsh:1:org_a', 'no subject segment'],
    ['dsh:1:org_a:usr_1:extra', 'a fifth segment'],
    ['dsh:2:org_a:usr_1', 'a namespace this build does not serve'],
    ['xsh:1:org_a:usr_1', 'another prefix'],
    ['dsh:1::usr_1', 'an empty organization'],
    ['dsh:1:org_a:', 'an empty subject'],
    ['dsh:1:org a:usr_1', 'a character no identity-service identifier holds'],
  ])('refuses %j (%s)', (name, _why) => {
    expect(() => parseHostObjectName(name)).toThrow(/host object name/)
  })
})
