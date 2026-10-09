/**
 * Package-owned invariant companion for `@ejunz/tool-subagent-control`.
 * @module @ejunz/tool-subagent-control/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@ejunz/cordis'
import type { InvariantInstaller } from '@ejunz/invariants'

const PACKAGE_NAME = '@ejunz/tool-subagent-control'

/** Cordis companion plugin name. */
export const name = 'tool-subagent-control-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this model-facing adapter has no independent lifecycle stream; delivery
 * and activation relations are owned by the subagent service it calls.
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
