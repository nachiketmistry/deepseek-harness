/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-credentials-secrets`.
 * @module @deepseek-ai/dsh-credentials-secrets/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-credentials-secrets'

/** Cordis companion plugin name. */
export const name = 'credentials-secrets-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider owns one SQLite table whose only writers
 * are its own methods; the seam's update events are emitted only after a
 * committed write, so there is no second authoritative stream to cross-check.
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
