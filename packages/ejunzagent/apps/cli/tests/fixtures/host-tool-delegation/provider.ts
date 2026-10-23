import type { Context } from '@ejunz/cordis'

export const name = 'host-tool-delegation-test-provider'

export function apply(ctx: Context): void {
  const fixture = { calls: [] as { name: string; args: unknown; sessionId: string }[] }
  const hostProvider = {
    async catalog() {
      return {
        tools: [{
          name: 'job_list',
          description: 'List your background jobs (running and finished) with their ids, kinds, and statuses.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      }
    },
    async call(name: string, args: unknown, context: { sessionId: string }) {
      fixture.calls.push({ name, args, sessionId: context.sessionId })
      return { type: 'ejunz/runtime-tool-call', toolName: name }
    },
  }
  const providerContext = ctx as unknown as { provide(name: string, value: unknown): unknown }
  providerContext.provide('runtimeDelegationFixture', fixture)
  providerContext.provide('hostProvider', hostProvider)
}
