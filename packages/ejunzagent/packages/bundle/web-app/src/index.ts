/**
 * @ejunz/web-app — the embedded Host API bundle glue. The browser client is
 * intentionally absent; this plugin supplies only the authority list consumed
 * by the embedded connection transport.
 * @module @ejunz/web-app
 */

import type { Context } from '@ejunz/cordis'
import z from '@ejunz/schemastery'

/** Stable Cordis plugin name. */
export const name = 'web-app'

/** Runtime service that supplies authorities accepted by the Host API transport. */
const WEB_RUNTIME_SERVICE = 'webRuntime'

/** Authorities the embedded API transport may accept. */
export interface WebRuntimeValues {
  /** Explicit Host authorities; an empty list keeps the transport loopback-only. */
  trustedHosts: string[]
}

declare module '@ejunz/cordis' {
  interface Context {
    webRuntime: WebRuntimeValues
  }
}

/** Plugin config for the embedded API transport. */
export interface Config {
  /** Explicit authorities accepted by the API transport. */
  trustedHosts: string[]
}

/** Schema for {@link Config}. */
export const Config: z<Config> = z.object({
  trustedHosts: z.array(String).default([]),
})

/** Provide the configured Host authorities without starting a browser server or serving assets. */
export function apply(ctx: Context, config: Config): void {
  ctx.provide(WEB_RUNTIME_SERVICE, { trustedHosts: [...config.trustedHosts] })
}
