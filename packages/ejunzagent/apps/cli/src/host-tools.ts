/**
 * The host-tool bridge: what makes an Ejunz host's tools — the tools its addons
 * register, plus the Base tools — reachable inside this application, together
 * with the per-domain settings and credentials those tools act under.
 *
 * Embedded boots install it from the configuration the owning Ejunz host
 * passes in directly.
 * @module @ejunz/ea/host-tools
 */

import type { Context } from '@ejunz/cordis'
import { createHostToolBridge, createHostToolClient } from '@ejunz/tool-host'
import * as ToolHost from '@ejunz/tool-host'

/** Where this application reaches the host that owns its sessions. */
export interface HostToolBridgeConfig {
  /** Host origin, e.g. `http://127.0.0.1:2333`. */
  origin: string
  /** Token the host issued for this application instance. */
  token: string
}

/**
 * Publish the host-backed services and mount the host tool set.
 *
 * The session-persistence and storage providers read the same host through
 * their own rows, so this installs only the tool plane and the per-session
 * domain runtime the model plane resolves.
 * @param ctx - the booting application root context.
 * @param config - the host origin and the token it issued for this instance.
 */
export async function installHostToolBridge(ctx: Context, config: HostToolBridgeConfig): Promise<void> {
  const bridge = createHostToolBridge(config.origin, config.token)
  ctx.provide('llmDomainRuntime', {
    resolve: (sessionId: string, signal: AbortSignal) => bridge.runtime(sessionId, signal),
  })
  ctx.provide('hostProvider', createHostToolClient(bridge))
  await ctx.plugin(ToolHost)
}
