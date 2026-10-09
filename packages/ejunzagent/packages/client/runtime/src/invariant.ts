/** Package-owned invariant companion for `@ejunz/client-runtime`.
 * @module @ejunz/client-runtime/invariant
 */

import type { Context } from '@ejunz/cordis'
import type { InvariantInstaller } from '@ejunz/invariants'

const PACKAGE_NAME = '@ejunz/client-runtime'

/** Cordis companion plugin name. */
export const name = 'client-runtime-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package projects state already validated by its
 * Host and wire owners; its client-side caches have no independent event
 * relation to assert here.
 */
const install: InvariantInstaller = (_ctx: Context, _fail): void => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
