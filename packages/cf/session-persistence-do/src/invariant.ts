/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-persistence-do`.
 * @module @deepseek-ai/dsh-session-persistence-do/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-persistence-do'

/** Cordis companion plugin name. */
export const name = 'session-persistence-do-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the contiguous-seq and materialization relationships are
 * owned and asserted by the shared coordinator in `dsh-session-persistence`; the
 * rows themselves are observable only by database round trip.
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
