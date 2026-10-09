/** Read-only projection of the current Cordis Loader plugin entries. */

import type { Agent } from '@ejunz/agent'
import type { Context, FiberState } from '@ejunz/cordis'
import type {} from '@ejunz/agent-presets'
import type {} from '@ejunz/cordis-plugin-loader'
import type {} from '@ejunz/tools'
import type {} from '@ejunz/tool-host'
import { TypertRemoteService, Remote } from '@ejunz/typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
  ToolInventoryEntry,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/**
 * Bound on the standing inventory's host-catalog round trip: a host that accepts the
 * connection and never answers fails the read instead of blocking the settings surface.
 */
const HOST_CATALOG_TIMEOUT_MS = 30_000

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   *
   * The standing composition registers this deployment's own tool plugins only: each Agent
   * installs the attached host's declared set into its own scope as it is composed, so a
   * standing read that stopped at `schemas()` would report a catalog missing the host's
   * whole surface. The host's deployment-wide declarations are merged in for that reason.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    const presets = this.ctx.get('agentPresets')
    const scope = presets === undefined ? undefined : await presets.standingKeyFor()
    return this.snapshot(scope, await this.declaredHostTools())
  }

  @Remote('sessionList')
  async sessionList(agent: Agent): Promise<PluginInventorySnapshot> {
    return this.snapshot(agent)
  }

  /**
   * The tool set the attached host declares for this deployment.
   *
   * The read carries no session, which is the host's own contract for the set every
   * session shares: a tool one domain publishes stays out of the deployment-wide
   * inventory, exactly as it stays out of another domain's model request.
   * @returns Declared tools, or none when this deployment provides no host client.
   */
  private async declaredHostTools(): Promise<readonly ToolInventoryEntry[]> {
    const client = this.ctx.get('hostProvider')
    if (client === undefined) return []
    const catalog = await client.catalog(AbortSignal.timeout(HOST_CATALOG_TIMEOUT_MS))
    return catalog.tools.map(tool => ({ name: tool.name, description: tool.description }))
  }

  /**
   * @param scope - Agent-like scope whose tool view is projected; omitted reads the global layer.
   * @param declared - tools the attached host declares for this deployment.
   */
  private snapshot(scope?: object, declared: readonly ToolInventoryEntry[] = []): PluginInventorySnapshot {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      const phase = entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? null
      entries.push({
        entryId: pluginEntryId(String(entry.id)),
        moduleName: String(entry.options.name),
        enabled: !entry.disabled,
        fiberPhase: phase,
      })
    }
    const tools: ToolInventoryEntry[] = (this.ctx.get('tools')?.schemas(scope) ?? []).map((tool) => ({
      name: String(tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
    }))
    // A name both layers publish is one tool: the scoped schema already describes it.
    for (const tool of declared) {
      if (!tools.some(existing => existing.name === tool.name)) tools.push(tool)
    }
    return { entries, tools }
  }
}

export default PluginInventoryGateway
