/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-spill-r2`.
 * @module @deepseek-ai/dsh-spill-r2/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-spill-r2'

/** Cordis companion plugin name. */
export const name = 'spill-r2-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each save writes one fresh, collision-free object and
 * returns its key; the store keeps no index and emits no events, so nothing
 * can drift.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
