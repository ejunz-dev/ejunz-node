import { Context, Service } from '@ejunz/cordis'
import type { JsonValue } from '@ejunz/tools'
import type { HostArguments, HostCallContext, HostCatalog, HostToolClient } from './types.ts'

declare module '@ejunz/cordis' {
  interface Context {
    /** Service holding the host client this deployment attached. */
    provider: HostToolClientService
    /** Host client provided at the root, which the service attaches on load. */
    hostProvider: HostToolClient
  }
}

/** Holds the attached host client, so a plugin reads it as a service. */
export class HostToolClientService extends Service {
  private client: HostToolClient | undefined

  constructor(ctx: Context) {
    super(ctx, 'provider')
    ctx.inject(['hostProvider'], (scope) => this.attach(scope.hostProvider))
  }

  /**
   * Attach the client this deployment authorizes.
   * @param client - client that declares the host's tools and executes them.
   */
  attach(client: HostToolClient): void {
    this.client = client
  }

  /**
   * Read the tools the attached client declares.
   * @param signal - aborts the round trip.
   * @param context - session the catalog is read for; omitted reads the set every session
   *   shares, which leaves out the tools a single domain publishes.
   * @returns the declared tools and the host's guidance.
   * @throws when no client is attached.
   */
  async catalog(signal: AbortSignal, context?: HostCallContext): Promise<HostCatalog> {
    if (this.client === undefined) throw new Error('tool-host: no client is attached, so no tool catalog is available')
    return this.client.catalog(signal, context)
  }

  /**
   * Execute one declared tool.
   * @param name - tool name from the declared catalog.
   * @param args - tool arguments.
   * @param context - session the call belongs to.
   * @param signal - aborts the call.
   * @returns the tool result.
   * @throws when no client is attached.
   */
  async call(name: string, args: HostArguments, context: HostCallContext, signal: AbortSignal): Promise<JsonValue> {
    if (this.client === undefined) throw new Error(`tool-host: no client is attached for ${name}`)
    return this.client.call(name, args, context, signal)
  }
}

/**
 * Attach a host client to the service in `ctx`.
 * @param ctx - context holding the client service.
 * @param client - client to attach.
 */
export function attachHostToolClient(ctx: Context, client: HostToolClient): void {
  ctx.provider.attach(client)
}
