import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { hostObjectName } from '@deepseek-ai/dsh-principal'
import LocalPrincipalResolver, { Config } from '@deepseek-ai/dsh-principal-local'

describe('LocalPrincipalResolver', () => {
  it('answers every request with the configured principal', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalPrincipalResolver, { org: 'org_local', user: 'usr_local' })
    const first = ctx.principal.current()
    expect(first).toStrictEqual({ org: 'org_local', subject: { kind: 'user', user: 'usr_local' } })
    expect(ctx.principal.current()).toStrictEqual(first)
    expect(hostObjectName(first)).toBe('dsh:1:org_local:usr_local')
  })

  // cordis.yml supplies this config, so an entry missing either identifier is
  // reachable input rather than a value the static interface already excludes.
  it('refuses a deployment that has not chosen its identifiers', () => {
    expect(() => Config({} as unknown as Config)).toThrow()
    expect(() => Config({ org: 'org_local' } as unknown as Config)).toThrow()
  })
})
