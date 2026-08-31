/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-bundle-source-node`.
 * @module @deepseek-ai/dsh-client-bundle-source-node/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-bundle-source-node'

/** Cordis companion plugin name. */
export const name = 'client-bundle-source-node-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider answers pure lookups over `node_modules`; the graph whose
 * consistency matters is owned and checked by `@deepseek-ai/dsh-client-modules`.
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
