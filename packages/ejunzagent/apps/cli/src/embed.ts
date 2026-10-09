/**
 * Embedded launch surface: boot the Host API composition inside the process
 * that owns the Agent, then return its in-process API and event streams.
 *
 * The composition starts no browser UI. The owning server receives the `/api`
 * handler and mux/host downlinks directly, and disposes the root context to
 * stop the instance. Signal handling, fail-loud policy, and patch watching
 * remain with the process owner.
 * @module @ejunz/ea/embed
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@ejunz/cordis'
import { loadLayeredEnv } from '@ejunz/app-boot'
// Activate the Context merges this surface reads (`connection`, `apiProxy`).
import type {} from '@ejunz/client-connection'
import type {} from '@ejunz/host-apiproxy'
import type { ConnectionFetchHandler } from '@ejunz/client-connection'
import { RpcId, type HostFrame, type MuxFrame, type RpcRequest } from '@ejunz/host-apiproxy/api'
import { bootProfileTree, composeProfile } from './profile-boot.ts'
import { installHostToolBridge, type HostToolBridgeConfig } from './host-tools.ts'

/** The shipped embedded overlay: the Web composition minus a front door of its own. */
const EMBEDDED_PATCH = fileURLToPath(new URL('../config/embedded.patch.yml', import.meta.url))

/** Configuration for {@link embedAgentRuntime}. */
export interface EmbedWebAppOptions {
  /** The host this instance belongs to, for tools, session logs, storage, settings, and credentials. */
  bridge: HostToolBridgeConfig
  /**
   * Inner arguments recorded as the tree's command line. Absent, the tree sees
   * an empty command line — the shape the Web composition's parsers accept,
   * because an embedder states what it wants through services, not flags.
   */
  args?: readonly string[]
}

/** A booted application the embedder drives directly. */
export interface EmbeddedAgentRuntime {
  /** The booted application root; disposing it is this instance's whole shutdown. */
  readonly ctx: Context
  /**
   * The composed `/api` channel handler: the same dispatch the HTTP route
   * serves, Remote interceptor included, callable without a socket. A caller
   * supplies the `Host` header a request would have carried (`127.0.0.1` for a
   * loopback deployment), because the privileged-method and interceptor fences
   * read it.
   */
  readonly api: ConnectionFetchHandler
  /** The two downlink streams, as the WebSocket carrier pumps them to a browser client. */
  readonly events: {
    /** Mux frames: transcript, interaction, and session-lifecycle traffic. */
    mux(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>>
    /** Host frames: session list, status, and projections. */
    host(signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>>
  }
}

/**
 * Boot this application in-process and return its transport faces.
 *
 * The returned API and event streams are live for as long as `ctx` is; the
 * embedder stops them by disposing that context, which unwinds every session
 * the instance holds.
 * @param options - the owning host's bridge and this instance's command line.
 * @returns the booted context and the faces the embedder drives it with.
 * @throws when the composition mounts no `/api` channel, because an embedder
 * with no dispatch face could not serve a single request.
 */
export async function embedAgentRuntime(options: EmbedWebAppOptions): Promise<EmbeddedAgentRuntime> {
  const composed = composeProfile('web', [EMBEDDED_PATCH])
  // The host bridge is per-instance, so its rows carry runtime values: the
  // bundle's own rows read them from the environment a spawned process would
  // have been given, and an embedded boot has no such environment.
  composed.overlays.push(
    { id: 'session-persistence-ejunz', config: { ...options.bridge } },
    { id: 'storage-ejunz', config: { ...options.bridge } },
  )
  const ctx = await bootProfileTree(composed, {
    environment: loadLayeredEnv('ea'),
    args: options.args ?? [],
    prepare: async (hostCtx) => { await installHostToolBridge(hostCtx, options.bridge) },
  })
  const api = ctx.get('connection')?.apiHandler
  const apiProxy = ctx.get('apiProxy')
  if (api === undefined || apiProxy === undefined) {
    await ctx.fiber.dispose()
    throw new Error('ea embed: the composition mounted no /api channel; the profile needs its client-connection row')
  }
  return {
    ctx,
    api,
    events: {
      mux: signal => apiProxy.events.mux({ rpcId: RpcId(crypto.randomUUID()), payload: {} }, signal),
      host: signal => apiProxy.events.host({ rpcId: RpcId(crypto.randomUUID()), payload: {} }, signal),
    },
  }
}
