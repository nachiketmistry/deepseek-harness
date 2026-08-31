/** Package-owned invariant companion for `@deepseek-ai/dsh-principal`. @module @deepseek-ai/dsh-principal/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-principal'
/** Cordis companion plugin name. */
export const name = 'principal-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']
/** No runtime invariant: this seam owns value types and one pure name function, and holds no mutable data or event stream to relate. */
const install: InvariantInstaller = () => {}
/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
