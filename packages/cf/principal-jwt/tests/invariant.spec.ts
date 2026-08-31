import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import * as invariant from '@deepseek-ai/dsh-principal-jwt/invariant'

describe('principal-jwt invariant companion', () => {
  it('reserves package ownership and releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(Invariants)
    const dispose = await invariant.apply(ctx)
    expect(invariant.name).toBe('principal-jwt-invariant')
    expect(invariant.inject).toStrictEqual(['invariants'])
    dispose()
  })
})
