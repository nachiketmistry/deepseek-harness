/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-subprocess-cf-sandbox`.
 * @module @deepseek-ai/dsh-subprocess-cf-sandbox/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subprocess-cf-sandbox'

/** Cordis companion plugin name. */
export const name = 'subprocess-cf-sandbox-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: process lifetimes live in the container supervisor, which the
 * Worker observes only through SDK handles; there is no owned event stream or mutable
 * data to cross-check.
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
