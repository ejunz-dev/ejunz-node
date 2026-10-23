import type { ContentBlock } from '@ejunz/llm'
import type { JsonValue, ToolDefinition } from '@ejunz/tools'
import type { HostArguments, HostCatalog, HostToolClient, HostToolSpec } from './types.ts'

const RUNTIME_TOOL_CALL_TYPE = 'ejunz/runtime-tool-call'

interface RuntimeToolCall {
  toolName: string
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRuntimeToolCall(value: JsonValue): RuntimeToolCall | undefined {
  if (!isRecord(value) || value.type !== RUNTIME_TOOL_CALL_TYPE) return undefined
  const toolName = value.toolName
  if (typeof toolName !== 'string') {
    throw new Error('host tool returned a malformed runtime-tool-call result')
  }
  return { toolName }
}

/** Render an ordinary host result when no native tool presenter is available. */
function renderResult(value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value ?? null) }]
}

/** Bind one host declaration to its host call and optional native runtime implementation. */
export function createHostToolDefinition(
  spec: HostToolSpec,
  client: HostToolClient,
  runtimeTool?: ToolDefinition,
): ToolDefinition {
  if (spec.runtimeDelegation === true && runtimeTool === undefined) {
    throw new Error(`native runtime tool ${spec.name} is not installed for this Agent`)
  }
  return {
    ...(runtimeTool ?? {}),
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    output: runtimeTool?.output ?? {
      schema: {},
      render: (_args, value) => renderResult(value),
    },
    execute: async (args, exec) => {
      const input = typeof args === 'object' && args !== null && !Array.isArray(args)
        ? args as HostArguments
        : {}
      if (exec.agent === undefined) throw new Error(`tool ${spec.name} requires an Agent session`)
      const result = await client.call(spec.name, input, {
        sessionId: exec.agent.session.id,
        ...(spec.runtimeDelegation === true ? { runtimeDelegation: true } : {}),
      }, exec.signal)
      const delegated = parseRuntimeToolCall(result)
      if (delegated === undefined) {
        if (spec.runtimeDelegation === true) {
          throw new Error(`host tool ${spec.name} did not authorize runtime delegation`)
        }
        return result
      }
      if (delegated.toolName !== spec.name) {
        throw new Error(`host tool ${spec.name} cannot delegate to runtime tool ${delegated.toolName}`)
      }
      if (runtimeTool === undefined) {
        throw new Error(`native runtime tool ${spec.name} is not installed for this Agent`)
      }
      return await runtimeTool.execute(exec.arguments, exec)
    },
  }
}

/** The registry surface needed to capture and shadow native Agent tools. */
export interface ToolRegistry {
  /** Look up a tool as the given Agent scope sees it. */
  get(name: string, scope?: object): ToolDefinition | undefined
  /** Register one scoped host tool and return its disposer. */
  register(definition: ToolDefinition): () => void
}

/** Inputs to register one host catalog in an Agent's scoped registry. */
export interface RegisterHostToolsOptions {
  registry: ToolRegistry
  client: HostToolClient
  catalog: HostCatalog
  scope?: object
}

/** Register host wrappers while capturing the native definitions they can delegate to. */
export function registerHostTools(options: RegisterHostToolsOptions): () => void {
  const disposers: (() => void)[] = []
  try {
    for (const spec of options.catalog.tools) {
      const runtimeTool = options.registry.get(spec.name, options.scope)
      disposers.push(options.registry.register(createHostToolDefinition(spec, options.client, runtimeTool)))
    }
  } catch (error) {
    for (const dispose of [...disposers].reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
