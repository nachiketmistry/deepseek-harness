import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import * as invariant from '@deepseek-ai/dsh-principal-local/invariant'

describe('principal-local invariant companion', () => {
  it('reserves package ownership and releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(Invariants)
    const dispose = await invariant.apply(ctx)
    expect(invariant.name).toBe('principal-local-invariant')
    expect(invariant.inject).toStrictEqual(['invariants'])
    dispose()
  })
})
