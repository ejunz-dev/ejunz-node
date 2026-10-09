import type { Context } from '@ejunz/cordis'
import type { InvariantInstaller } from '@ejunz/invariants'

const PACKAGE_NAME = '@ejunz/tool-host'

export const name = 'tool-host-invariant'
export const inject = ['invariants']

const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
