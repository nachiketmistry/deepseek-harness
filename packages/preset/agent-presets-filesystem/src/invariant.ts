/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-presets-filesystem`.
 * @module @deepseek-ai/dsh-agent-presets-filesystem/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-presets-filesystem'

/** Cordis companion plugin name. */
export const name = 'agent-presets-filesystem-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider reads and copies directories on demand
 * and keeps no mutable state or event stream of its own; the standing-mount
 * and root-realm relations it feeds are asserted by `dsh-agent-presets`' companion.
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
