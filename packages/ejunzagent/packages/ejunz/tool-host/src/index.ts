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
import type { ContentBlock } from '@ejunz/llm'
import type { JsonValue, ToolDefinition } from '@ejunz/tools'
import { HostToolClientService } from './client.ts'
import type { HostArguments, HostCallContext, HostCatalog, HostToolClient, HostToolSpec } from './types.ts'
export { createHostToolBridge, createHostToolClient } from './bridge.ts'
export type { HostToolBridge } from './bridge.ts'
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

/**
 * Render one host tool result.
 *
 * The result schema is unconstrained — `{}` — because the host's own result schemas are
 * the only accurate declaration of what it returns, and a copy here would drift from
 * them. The model receives the value as JSON text.
 * @param value - the lossless JSON value the host returned.
 * @returns the model-facing content for that value.
 */
function renderResult(value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value ?? null) }]
}

/** The registration surface this package needs from the Agent tool registry. */
export interface ToolRegistry {
  /**
   * Register one tool.
   * @param definition - schema, execution, and presentation callbacks.
   * @returns the exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition): () => void
}

/** Options for {@link registerHostTools}. */
export interface RegisterHostToolsOptions {
  /**
   * Registry the tools register into. The registry resolves its layer from the context it
   * was read through, so a registry read from an Agent scope publishes these tools to that
   * Agent alone.
   */
  readonly registry: ToolRegistry
  /** Client that executes the declared tools. */
  readonly client: HostToolClient
  /** Tools to register, as the host declared them. */
  readonly catalog: HostCatalog
}

/**
 * Bind one declared tool to the client that executes it.
 * @param spec - the tool as the host declared it.
 * @param client - client that executes the declared tools.
 * @returns the definition the registry registers.
 */
function toolDefinition(spec: HostToolSpec, client: HostToolClient): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    output: {
      schema: {},
      render: (_args, value) => renderResult(value),
    },
    execute: async (args, exec) => {
      const input = typeof args === 'object' && args !== null && !Array.isArray(args)
        ? args as HostArguments
        : {}
      if (exec.agent === undefined) throw new Error(`tool ${spec.name} requires an Agent session`)
      const context: HostCallContext = { sessionId: exec.agent.session.id }
      return await client.call(spec.name, input, context, exec.signal)
    },
  }
}

/**
 * Register a host-declared tool set in one registry.
 *
 * The caller supplies the catalog and the registry, so the registered names, descriptions,
 * and parameter schemas are exactly what the host declared, and the tools land in whatever
 * scope that registry was read through. Reading the registry from an Agent's own scope
 * therefore keeps the tools on that Agent: they are invisible to every other Agent in the
 * process and follow that Agent's disposal.
 * @param options - registry, client, and the declared tools.
 * @returns a disposer that removes every tool this call registered.
 */
export function registerHostTools(options: RegisterHostToolsOptions): () => void {
  const disposers = options.catalog.tools.map(spec => options.registry.register(toolDefinition(spec, options.client)))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

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
 * Install the host's tools for one Agent.
 *
 * The host declares its catalog per domain, so the catalog is read for this Agent's own
 * session: a tool another domain owns is never declared here, and every other Agent in the
 * process stays without it.
 *
 * Both the tools and their prompt section are registered through values read from
 * `agentCtx`, whose scope is what a scoped registry resolves its layer from: the Agent's
 * model sees the host's guidance for its own session, and no other Agent's.
 * @param options - the Agent scope and the client.
 * @throws when the scope carries no Agent or no tool registry, or the host catalog round
 *   trip fails — Agent creation rolls back rather than publishing an Agent without its tools.
 */
export async function installHostTools(options: InstallHostToolsOptions): Promise<void> {
  const { agentCtx, client } = options
  const agent = agentCtx.agent
  if (agent === undefined) throw new Error('tool-host: host tools require an Agent scope')
  const registry = agentCtx.get('tools') as ToolRegistry | undefined
  if (registry === undefined) throw new Error('tool-host: the tool registry is unavailable in this Agent scope')
  const sessionId = agent.session.id
  const catalog = await client.catalog(AbortSignal.timeout(CATALOG_TIMEOUT_MS), { sessionId })
  registerHostTools({ registry, client, catalog })
  const guidance = catalog.guidance
  if (guidance !== undefined && guidance.length > 0) {
    agentCtx.get('systemPrompt')?.context({
      name: 'host-tools',
      order: 120,
      text: () => guidance,
    })
  }
  agentCtx.logger.info(`tool-host: installed ${catalog.tools.length} host tool(s) for session ${sessionId}`)
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
