import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { OrganizationId, UserId, hostObjectName } from '@deepseek-ai/dsh-principal'
import CfPrincipalResolver, { Config } from '@deepseek-ai/dsh-principal-jwt'

describe('CfPrincipalResolver', () => {
  it('answers with the principal this object was addressed for', async () => {
    const expected = { org: OrganizationId('org_a'), subject: { kind: 'user' as const, user: UserId('usr_1') } }
    const ctx = new Context()
    await ctx.plugin(CfPrincipalResolver, { objectName: hostObjectName(expected) })
    expect(ctx.principal.current()).toStrictEqual(expected)
    expect(ctx.principal.current()).toStrictEqual(ctx.principal.current())
  })

  it('refuses to boot inside an object no principal addresses', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(CfPrincipalResolver, { objectName: 'default' })).rejects.toThrow(/host object name/)
  })

  // The Worker entry supplies this, so an object booted without its own name
  // is reachable input rather than a value the static interface excludes.
  it('refuses a deployment that did not say which object this is', () => {
    expect(() => Config({} as Config)).toThrow()
  })
})
