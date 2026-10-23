import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { boot } from '@ejunz/app-boot'
import { SessionId } from '@ejunz/session'

const testDir = dirname(fileURLToPath(import.meta.url))
const configPath = resolve(testDir, 'fixtures/host-tool-delegation/cordis.yml')

test('host tools shadow only their Agent scope and delegate to native implementations', async () => {
  const ctx = await boot('host-tool-delegation-real-composition', configPath)
  const handles: { agent: any; dispose(): Promise<void> }[] = []
  try {
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents') as {
      create(options: Record<string, unknown>): Promise<{ agent: any; dispose(): Promise<void> }>
    }
    const agentOptions = { meta: { cwd: process.cwd() }, agentOptions: { provider: 'test', model: 'test' } }
    const hostHandle = await agents.create({
      ...agentOptions,
      sessionId: SessionId('host-tool-delegation-real-session'),
      setup: async (agentCtx: any) => {
        const installer = agentCtx.get('hostTools') as { install(context: unknown): Promise<void> }
        await installer.install(agentCtx)
      },
    })
    handles.push(hostHandle)
    const nativeHandle = await agents.create({
      ...agentOptions,
      sessionId: SessionId('native-tool-fallback-real-session'),
    })
    handles.push(nativeHandle)

    const hostAgent = hostHandle.agent
    const hostRegistry = hostAgent.ctx.get('tools') as {
      get(name: string, scope?: object): unknown
      execute(input: Record<string, unknown>): Promise<{ isError: boolean; value?: unknown }>
    }
    const native = hostRegistry.get('job_list')
    const scopedHostTool = hostRegistry.get('job_list', hostAgent)
    assert.ok(native)
    assert.ok(scopedHostTool)
    assert.notEqual(scopedHostTool, native)

    const result = await hostRegistry.execute({
      callId: 'host-tool-delegation-call',
      name: 'job_list',
      arguments: {},
      agent: hostAgent,
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, [])

    const nativeOnlyRegistry = nativeHandle.agent.ctx.get('tools') as {
      get(name: string, scope?: object): unknown
    }
    assert.equal(nativeOnlyRegistry.get('job_list', nativeHandle.agent), native)

    const fixture = ctx.get('runtimeDelegationFixture') as {
      calls: { name: string; args: unknown; sessionId: string }[]
    }
    assert.deepEqual(fixture.calls, [{
      name: 'job_list',
      args: {},
      sessionId: hostAgent.session.id,
    }])
    console.log('host catalog tool delegated through the composed Agent tool registry')
  } finally {
    for (const handle of handles.reverse()) await handle.dispose()
    await ctx.fiber.dispose()
  }
})
