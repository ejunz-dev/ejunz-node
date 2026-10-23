import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@ejunz/tools'
import { createHostToolDefinition, registerHostTools } from '../src/runtime-delegation.ts'
import type { ToolRegistry } from '../src/runtime-delegation.ts'
import type { HostCatalog, HostToolClient, HostToolSpec } from '../src/types.ts'

const spec: HostToolSpec = {
  name: 'todo_write',
  description: 'Replace the current session todo list.',
  inputSchema: {
    type: 'object',
    properties: { todos: { type: 'array' } },
    required: ['todos'],
  },
}

function nativeDefinition(execute: ToolDefinition['execute'] = async () => ({ source: 'native' })): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    output: {
      schema: { type: 'object' },
      render: () => [{ type: 'text', text: 'native renderer' }],
    },
    execute,
    presentCall: () => ({ card: 'generic', title: 'Native call', kind: 'other' }),
    presentResult: () => ({ card: 'generic', title: 'Native result' }),
    timeoutMs: 1200,
    isConcurrencySafe: () => false,
  } as ToolDefinition
}

function executionContext(): ToolRunContext {
  return {
    callId: 'call-1',
    name: spec.name,
    arguments: { todos: [] },
    agent: { session: { id: 'session-1' } },
    signal: new AbortController().signal,
    token: Symbol(),
    deferContext() {},
    concludeTurn() {},
  } as unknown as ToolRunContext
}

function hostClient(response: JsonValue): HostToolClient {
  return {
    async catalog() { return { tools: [] } },
    async call() { return response },
  }
}

describe('host tool runtime delegation', () => {
  it('captures the inherited native tool before registering the host shadow', () => {
    const runtime = nativeDefinition()
    const order: string[] = []
    const scope = {}
    let lookedUpScope: object | undefined
    let registered: ToolDefinition | undefined
    const registry: ToolRegistry = {
      get(name, scopeArg) {
        order.push(`get:${name}`)
        lookedUpScope = scopeArg
        return name === spec.name ? runtime : undefined
      },
      register(definition) {
        order.push(`register:${definition.name}`)
        registered = definition
        return () => { registered = undefined }
      },
    }
    const dispose = registerHostTools({ registry, client: hostClient({ ok: true }), catalog: { tools: [spec] }, scope })
    assert.deepEqual(order, ['get:todo_write', 'register:todo_write'])
    assert.equal(lookedUpScope, scope)
    assert.equal(registered?.output, runtime.output)
    dispose()
    assert.equal(registered, undefined)
  })

  it('preserves the native output and presentation contracts', () => {
    const runtime = nativeDefinition()
    const hostTool = createHostToolDefinition(spec, hostClient({ value: true }), runtime)
    assert.equal(hostTool.output, runtime.output)
    assert.equal(hostTool.presentCall, runtime.presentCall)
    assert.equal(hostTool.presentResult, runtime.presentResult)
    assert.equal(hostTool.timeoutMs, 1200)
  })

  it('returns ordinary host results without invoking the native tool', async () => {
    let nativeCalls = 0
    const runtime = nativeDefinition(async () => {
      nativeCalls++
      return { source: 'native' }
    })
    const hostTool = createHostToolDefinition(spec, hostClient({ source: 'host' }), runtime)
    assert.deepEqual(await hostTool.execute({ todos: [] }, executionContext()), { source: 'host' })
    assert.equal(nativeCalls, 0)
  })

  it('delegates the same tool name with the original arguments and execution context', async () => {
    const input = { todos: [{ content: 'ship', status: 'in_progress' }] }
    const calls: { args: unknown; exec: ToolRunContext }[] = []
    const runtime = nativeDefinition(async (args, exec) => {
      calls.push({ args, exec })
      return { source: 'native', args }
    })
    const hostTool = createHostToolDefinition(spec, hostClient({
      type: 'ejunz/runtime-tool-call',
      toolName: spec.name,
    }), runtime)
    const exec = { ...executionContext(), arguments: input } as ToolRunContext
    assert.deepEqual(await hostTool.execute(input, exec), { source: 'native', args: input })
    assert.deepEqual(calls, [{ args: input, exec }])
  })

  it('rejects a delegation to a different native tool', async () => {
    const hostTool = createHostToolDefinition(spec, hostClient({
      type: 'ejunz/runtime-tool-call',
      toolName: 'job_kill',
    }), nativeDefinition())
    await assert.rejects(hostTool.execute({ todos: [] }, executionContext()), /cannot delegate to runtime tool job_kill/)
  })

  it('rejects a delegation when no native tool is available', async () => {
    const hostTool = createHostToolDefinition(spec, hostClient({
      type: 'ejunz/runtime-tool-call',
      toolName: spec.name,
    }))
    await assert.rejects(hostTool.execute({ todos: [] }, executionContext()), /native runtime tool todo_write is not installed/)
  })
})
