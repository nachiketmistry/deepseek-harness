import { describe, expect, it } from 'vitest'
import {
  HOST_OBJECT_NAME_PREFIX,
  HOST_OBJECT_NAME_VERSION,
  OrganizationId,
  UserId,
  hostObjectName,
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
