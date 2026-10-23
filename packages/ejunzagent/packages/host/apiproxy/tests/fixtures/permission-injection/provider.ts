import type { Context } from '@ejunz/cordis'
import { Session } from '@ejunz/session'
import type { SessionId } from '@ejunz/session/types'

export const name = 'permission-injection-test-provider'
export const inject = []

export function apply(ctx: Context): void {
  const session = Session.create('permission-injection-real-session' as SessionId)
  const agent = { id: session.id, session, ctx: undefined }
  const agents = {
    get: (sessionId: string) => sessionId === session.id ? agent : undefined,
    isOwnedBy: () => false,
    list: () => [agent],
  }
  const sessions = {
    get: (sessionId: string) => sessionId === session.id ? session : undefined,
    flush: async () => {},
    list: () => [session],
  }

  ctx.provide('permissionInjectionFixture', { session })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture' }),
    saveSelection: async () => {},
  })
  ctx.provide('agents', agents)
  ctx.provide('attachments', {
    imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 1024 },
    validateImage: async () => {},
    saveImage: async () => { throw new Error('image service is outside this test') },
    readImage: async () => { throw new Error('image service is outside this test') },
  })
  ctx.provide('commands', { execute: async () => undefined })
  ctx.provide('llm', {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => undefined,
    listConfigurableProviders: () => [],
    canResolveProvider: () => false,
  })
  ctx.provide('sessions', sessions)
  ctx.provide('subagents', { listChildren: async () => [] })
  ctx.provide('sessionQuery', {})
  ctx.provide('tools', { get: () => undefined })
  ctx.provide('userQuestions', { registerProvider: () => () => {} })
}
