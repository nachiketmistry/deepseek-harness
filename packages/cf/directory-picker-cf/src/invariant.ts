/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-directory-picker-cf`.
 * @module @deepseek-ai/dsh-directory-picker-cf/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-directory-picker-cf'

/** Cordis companion plugin name. */
export const name = 'directory-picker-cf-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each list/create/clone is one stateless container round trip;
 * the container filesystem itself is the authoritative state.
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
