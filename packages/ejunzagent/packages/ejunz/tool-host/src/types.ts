import type { JsonValue } from '@ejunz/tools'

export type { JsonValue } from '@ejunz/tools'

/**
 * One tool as the attached host declares it. The host owns this catalog: the Agent
 * process registers exactly the names, descriptions, and parameter schemas it receives,
 * so no copy of them exists here.
 */
export interface HostToolSpec {
  /** Name the model calls, and the name the tool registry holds. */
  readonly name: string
  /** Model-facing description. */
  readonly description: string
  /** Parameter JSON Schema, as `ToolSchema.parameters` holds it. */
  readonly inputSchema: Record<string, unknown>
}

/** The catalog one host round trip returns. */
export interface HostCatalog {
  /** Tools to register, in the order the host declared them. */
  readonly tools: readonly HostToolSpec[]
  /**
   * Model-facing statements about the set, and about the scope its calls act for, when
   * the host supplies them. The host resolves this text per session, so what a model
   * reads describes the session that asked.
   */
  readonly guidance?: string
}

/**
 * Identity of the Agent session one host round trip acts for.
 *
 * The session is what lets the host resolve the domain and the Base its tools act on, so
 * every call after the first carries it.
 */
export interface HostCallContext {
  readonly sessionId: string
}

/** Arguments of one host tool call, as the model supplied them. */
export type HostArguments = Record<string, JsonValue>

/**
 * The client a deployment attaches to reach its host: it declares the tools to install,
 * and it executes the calls it declared.
 */
export interface HostToolClient {
  /**
   * Declare the tools this client installs.
   * @param signal - aborts the round trip.
   * @param context - session the catalog is read for; omitted reads the set every session
   *   shares, which leaves out the tools a single domain publishes.
   * @returns the declared tools and the host's guidance.
   */
  catalog(signal: AbortSignal, context?: HostCallContext): Promise<HostCatalog>
  /**
   * Execute one declared tool.
   * @param name - tool name from the declared catalog.
   * @param args - tool arguments.
   * @param context - session the call belongs to.
   * @param signal - aborts the call.
   * @returns the tool result.
   */
  call(name: string, args: HostArguments, context: HostCallContext, signal: AbortSignal): Promise<JsonValue>
}
