import type { LlmDomainRuntime } from '@ejunz/llm'
import type { JsonValue } from '@ejunz/tools'
import { parseHostCatalog } from './catalog.ts'
import type { HostArguments, HostCallContext, HostCatalog, HostToolClient } from './types.ts'

/**
 * Transport the standalone Agent process uses to reach the host that declares its tools.
 *
 * Each method names the host data API path it posts to. A deployment whose host runs in
 * this process attaches its own client to `ctx.hostProvider` instead of bridging.
 */
export interface HostToolBridge {
  /**
   * Read the tool catalog the host exposes to Agent sessions.
   * @param signal - aborts the request.
   * @param context - session the catalog is read for; omitted reads the set every session
   *   shares, which leaves out the tools a single domain publishes.
   * @returns the declared tools and their guidance.
   */
  catalog(signal: AbortSignal, context?: HostCallContext): Promise<HostCatalog>
  /**
   * Execute one declared tool in the host process.
   * @param sessionId - Agent session the call acts for.
   * @param name - tool name from the declared catalog.
   * @param args - tool arguments.
   * @param signal - aborts the request.
   * @returns the tool result.
   */
  call(sessionId: string, name: string, args: HostArguments, signal: AbortSignal): Promise<JsonValue>
  /**
   * Read the LLM runtime configuration for one session's domain.
   *
   * The host owns which models a domain may use, so the runtime is read over the same
   * transport as the tools even though no tool serves it.
   * @param sessionId - Agent session to resolve.
   * @param signal - aborts the request.
   * @returns the domain runtime, or undefined when the host reports none.
   */
  runtime(sessionId: string, signal: AbortSignal): Promise<LlmDomainRuntime | undefined>
}

interface BridgeResponse {
  ok?: boolean
  value?: JsonValue
  error?: { message?: string }
}

function formatThrown(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through */
    }
  }
  return String(error);
}

async function request(
  origin: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<JsonValue | undefined> {
  const url = `${origin.replace(/\/$/, '')}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ejunz-agent-token': token,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    throw new Error(`Ejunz Agent bridge request failed for ${url}: ${formatThrown(error)}`, { cause: error })
  }
  let payload: BridgeResponse
  try {
    payload = await response.json() as BridgeResponse
  } catch (error) {
    throw new Error(`Ejunz Agent bridge request failed for ${url}: non-JSON response (${response.status}): ${formatThrown(error)}`)
  }
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error?.message || `Ejunz Agent bridge request failed: ${response.status}`)
  }
  return payload.value
}

/**
 * Build the bridge for one host origin and its data token.
 * @param origin - host origin, e.g. `http://127.0.0.1:2333`.
 * @param token - value of `EJUNZ_AGENT_DATA_TOKEN`.
 * @returns the bridge the Agent process uses for host data.
 */
export function createHostToolBridge(origin: string, token: string): HostToolBridge {
  return {
    async catalog(signal, context) {
      const body = context === undefined ? {} : { sessionId: context.sessionId }
      return parseHostCatalog(await request(origin, token, '/api/ejunz-agent/data/tools/catalog', body, signal))
    },
    async call(sessionId, name, args, signal) {
      const value = await request(origin, token, '/api/ejunz-agent/data/tools/call', { sessionId, name, args }, signal)
      return value as JsonValue
    },
    async runtime(sessionId, signal) {
      const value = await request(origin, token, '/api/ejunz-agent/data/domain/runtime', { sessionId }, signal)
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as unknown as LlmDomainRuntime
        : undefined
    },
  }
}

/**
 * Wrap a bridge as the client an Agent composition installs tools from.
 *
 * The session reaches the host on every round trip — catalog and call alike — so the
 * tools one session receives, and the operations they run, belong to that session's
 * domain rather than to the set every session shares.
 * @param bridge - transport to the host data API.
 * @returns the client that declares and executes the host's tools.
 */
export function createHostToolClient(bridge: HostToolBridge): HostToolClient {
  return {
    catalog: (signal, context) => bridge.catalog(signal, context),
    call: (name, args, context, signal) => bridge.call(context.sessionId, name, args, signal),
  }
}
