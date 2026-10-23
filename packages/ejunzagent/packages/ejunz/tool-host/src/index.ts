/**
 * Registers the tool set a host declares into each Agent's own tool registry.
 *
 * No tool is declared here: the attached host client declares the set, so a deployment
 * registers exactly the tools its host exposes, under the host's names, descriptions, and
 * parameter schemas. A host serves its catalog per domain, so the install runs per Agent
 * session — the session id is what lets the host resolve the acting domain — and the
 * tools land in that Agent's scope alone.
 * @module
 */
import type { Context } from '@ejunz/cordis'
import { HostToolClientService } from './client.ts'
import { registerHostTools } from './runtime-delegation.ts'
import type { ToolRegistry } from './runtime-delegation.ts'
import type { HostCatalog, HostToolClient } from './types.ts'
export { createHostToolBridge, createHostToolClient } from './bridge.ts'
export type { HostToolBridge } from './bridge.ts'
export { registerHostTools } from './runtime-delegation.ts'
export type { RegisterHostToolsOptions, ToolRegistry } from './runtime-delegation.ts'
export { parseHostCatalog } from './catalog.ts'
export type { HostArguments, HostCallContext, HostCatalog, HostToolClient, HostToolSpec, JsonValue } from './types.ts'
export { HostToolClientService, attachHostToolClient } from './client.ts'

export const name = 'tool-host'
export const inject = ['tools']

/**
 * Startup bound on the host catalog round trip: a host that accepts the connection and
 * never answers fails the load instead of blocking it.
 */
const CATALOG_TIMEOUT_MS = 30_000

/** Options for {@link installHostTools}. */
export interface InstallHostToolsOptions {
  /** The Agent's own scope: the tools bind to it and disappear with the Agent. */
  readonly agentCtx: Context
  /**
   * Client the installed tools read and call through. Passed in rather than resolved from
   * a service so an install works however the caller reached this Agent: the deployment's
   * client service, or a bridge built from `EJUNZ_AGENT_DATA_*`.
   */
  readonly client: HostToolClient
}

/**
/** Per-Agent host tool registrations and serialized catalog refresh state. */
interface HostToolInstallation {
  readonly client: HostToolClient
  queue: Promise<void>
  catalog?: HostCatalog
  dispose?: () => void
}

const installations = new WeakMap<Context, HostToolInstallation>()

function installCatalog(agentCtx: Context, client: HostToolClient, catalog: HostCatalog): () => void {
  const agent = agentCtx.agent
  if (agent === undefined) throw new Error('tool-host: host tools require an Agent scope')
  const registry = agentCtx.get('tools') as ToolRegistry | undefined
  if (registry === undefined) throw new Error('tool-host: the tool registry is unavailable in this Agent scope')
  const disposeTools = registerHostTools({ registry, client, catalog, scope: agent })
  try {
    const guidance = catalog.guidance
    const disposeContext = guidance !== undefined && guidance.length > 0
      ? agentCtx.get('systemPrompt')?.context({
        name: 'host-tools',
        order: 120,
        text: () => guidance,
      })
      : undefined
    return () => {
      disposeContext?.()
      disposeTools()
    }
  } catch (error) {
    disposeTools()
    throw error
  }
}

/** Refresh the tools and guidance already installed for one live Agent. */
export async function refreshHostTools(agentCtx: Context): Promise<void> {
  const installation = installations.get(agentCtx)
  if (installation === undefined) return
  const update = installation.queue.then(async () => {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('tool-host: host tools require an Agent scope')
    const sessionId = agent.session.id
    const previousCatalog = installation.catalog
    const disposePrevious = installation.dispose
    disposePrevious?.()
    delete installation.dispose
    try {
      const registry = agentCtx.get('tools') as (ToolRegistry & {
        schemas(scope?: object): { name: string; description: string; parameters: Record<string, unknown> }[]
      }) | undefined
      if (registry === undefined) throw new Error('tool-host: the tool registry is unavailable in this Agent scope')
      const runtimeTools = registry.schemas(agent).map(({ name, description, parameters }) => ({
        name,
        description,
        inputSchema: parameters,
      }))
      const catalog = await installation.client.catalog(AbortSignal.timeout(CATALOG_TIMEOUT_MS), { sessionId, runtimeTools })
      if (previousCatalog !== undefined && JSON.stringify(previousCatalog) === JSON.stringify(catalog)) {
        installation.dispose = installCatalog(agentCtx, installation.client, previousCatalog)
        return
      }
      installation.dispose = installCatalog(agentCtx, installation.client, catalog)
      installation.catalog = catalog
      agentCtx.logger.info(`tool-host: refreshed ${catalog.tools.length} host tool(s) for session ${sessionId}`)
    } catch (error) {
      if (previousCatalog !== undefined) {
        installation.dispose = installCatalog(agentCtx, installation.client, previousCatalog)
        installation.catalog = previousCatalog
      } else {
        delete installation.dispose
        delete installation.catalog
      }
      throw error
    }
  })
  installation.queue = update.then(() => undefined, () => undefined)
  await update
}

/**
 * Install the host catalog for one Agent and retain its client for live refreshes.
 *
 * The host resolves the Agent's own session id to select the domain-specific catalog. Tools
 * and guidance are registered in that Agent's scope alone.
 * @param options - the Agent scope and the client.
 * @throws when the scope carries no Agent or tool registry, or the host catalog round trip
 *   fails — Agent creation rolls back rather than publishing an Agent without its tools.
 */
export async function installHostTools(options: InstallHostToolsOptions): Promise<void> {
  const { agentCtx, client } = options
  if (agentCtx.agent === undefined) throw new Error('tool-host: host tools require an Agent scope')
  const existing = installations.get(agentCtx)
  if (existing !== undefined && existing.client !== client) {
    throw new Error('tool-host: a different client is already installed for this Agent')
  }
  const installation = existing ?? { client, queue: Promise.resolve() }
  installations.set(agentCtx, installation)
  try {
    await refreshHostTools(agentCtx)
  } catch (error) {
    if (existing === undefined) installations.delete(agentCtx)
    throw error
  }
}

/**
 * Service the Agent factory resolves to install host tools into one Agent scope.
 *
 * The name is the contract: a deployment that composes Agents outside this package calls
 * `install` on whatever `ctx.get('hostTools')` holds, and a deployment with no host
 * attached provides nothing, so Agent creation proceeds unchanged.
 */
export const HOST_TOOLS_SERVICE = 'hostTools'

declare module '@ejunz/cordis' {
  interface Context {
    /** Installer published by this package while a host client is attached. */
    hostTools?: {
      /**
       * Install the host tools for one Agent scope.
       * @param agentCtx - the Agent's own scope.
       * @returns a promise settling after the tools and their prompt section are registered.
       */
      install(agentCtx: Context): Promise<void>
    }
  }
}

/**
 * Attach the host client and publish the installer the Agent factory calls.
 *
 * Nothing is registered here: the host declares its catalog per domain, so the installer
 * resolves it for each Agent as that Agent is composed. A caller that cannot reach this
 * context — a row composed inside its own realm — supplies its own client instead of the
 * provided service; {@link installHostTools} accepts either.
 *
 * The service is read through the store rather than as a property: `provider` is published
 * by the service fiber this call loads, so a property read would need this plugin to
 * `inject` a name only its own apply can publish, and the installer would never be wired.
 * @param ctx - plugin context.
 * @throws when the service fiber published no `provider`.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(HostToolClientService)
  const client = ctx.get('provider')
  if (client === undefined) throw new Error('tool-host: the host client service published no provider')
  ctx.provide(HOST_TOOLS_SERVICE, {
    install: (agentCtx: Context) => installHostTools({ agentCtx, client }),
  })
}
