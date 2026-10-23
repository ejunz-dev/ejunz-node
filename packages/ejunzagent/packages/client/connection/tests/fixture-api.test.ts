import { describe, expect, it } from 'vitest'
import type { SessionId } from '@ejunz/session/types'
import { FixtureApiClient } from '../src/client/fixture.ts'

const alpha = 'fx-alpha' as SessionId

describe('FixtureApiClient API additions', () => {
  it('returns an unmatched result for commands absent from the fixture', async () => {
    const client = new FixtureApiClient()
    const response = await client.sessions.command({ sessionId: alpha, command: '/not-registered' })

    expect(response.result).toEqual({ ok: true, value: { matched: false } })
  })

  it('records injected sections and reports missing sessions', async () => {
    const client = new FixtureApiClient()
    const sections = [{ name: 'project notes', text: 'Read-only fixture context' }]
    const accepted = await client.sessions.inject({ sessionId: alpha, plugin: 'fixture-test', sections })
    const history = await client.sessions.history({ sessionId: alpha, maxMessages: 100 })

    expect(accepted.result).toEqual({ ok: true, value: { accepted: true } })
    if (!history.result.ok) throw new Error(history.result.error.message)
    const injected = history.result.value.events.find(entry =>
      entry.event.type === 'user/message'
      && entry.event.data.source.kind === 'plugin'
      && entry.event.data.source.plugin === 'fixture-test')
    expect(injected?.event.type === 'user/message' ? injected.event.data.content : []).toEqual([
      { type: 'text', text: '# project notes\nRead-only fixture context' },
    ])

    const missing = await client.sessions.inject({
      sessionId: 'unknown-fixture-session' as SessionId,
      plugin: 'fixture-test',
      sections,
    })
    expect(missing.result.ok).toBe(false)
    if (missing.result.ok) throw new Error('fixture accepted injection into a missing session')
    expect(missing.result.error.code).toBe('session-not-found')
  })

  it('records addon mounts separately from context messages', async () => {
    const client = new FixtureApiClient()
    const before = await client.sessions.history({ sessionId: alpha, maxMessages: 100 })
    if (!before.result.ok) throw new Error(before.result.error.message)
    const payload = { sessionId: alpha, addonId: 'base', enabled: false }
    const recorded = await client.sessions.addons(payload)
    const repeated = await client.sessions.addons(payload)
    const history = await client.sessions.history({ sessionId: alpha, maxMessages: 100 })

    expect(recorded.result.ok).toBe(true)
    expect(repeated.result).toEqual(recorded.result)
    if (!history.result.ok) throw new Error(history.result.error.message)
    const addonEvents = history.result.value.events.filter(entry => entry.event.type === 'session/addons')
    expect(addonEvents).toHaveLength(1)
    expect(addonEvents[0]?.event).toMatchObject({ type: 'session/addons', data: { addonId: 'base', enabled: false } })
    expect(history.result.value.events.filter(entry => entry.event.type === 'user/message'))
      .toHaveLength(before.result.value.events.filter(entry => entry.event.type === 'user/message').length)

    const missing = await client.sessions.addons({
      sessionId: 'unknown-fixture-session' as SessionId,
      addonId: 'base',
      enabled: true,
    })
    expect(missing.result.ok).toBe(false)
    if (missing.result.ok) throw new Error('fixture accepted an addon event for a missing session')
    expect(missing.result.error.code).toBe('session-not-found')
  })

  it('records initial addon state with the first prompt as one log-only snapshot', async () => {
    const client = new FixtureApiClient()
    const before = await client.sessions.history({ sessionId: alpha, maxMessages: 100 })
    if (!before.result.ok) throw new Error(before.result.error.message)
    const snapshot = [
      { addonId: 'agent', enabled: true },
      { addonId: 'base', enabled: false },
    ]
    const recorded = await client.sessions.prompt({
      sessionId: alpha,
      mode: 'queue',
      content: [{ type: 'text', text: 'first prompt' }],
      addonSnapshot: snapshot,
    })
    const history = await client.sessions.history({ sessionId: alpha, maxMessages: 100 })

    expect(recorded.result.ok).toBe(true)
    if (!history.result.ok) throw new Error(history.result.error.message)
    const events = history.result.value.events
    const addonEvents = events.filter(entry => entry.event.type === 'session/addons')
    const userMessages = events.filter(entry => entry.event.type === 'user/message')
    expect(addonEvents).toHaveLength(1)
    expect(addonEvents[0]?.event).toMatchObject({ type: 'session/addons', data: { snapshot } })
    expect(userMessages).toHaveLength(before.result.value.events.filter(entry => entry.event.type === 'user/message').length + 1)
    expect(addonEvents[0]?.event.seq).toBeLessThan(userMessages.at(-1)?.event.seq ?? 0)
  })

  it('records initial permission injection as a durable session event', async () => {
    const client = new FixtureApiClient()
    const permissionInjection = {
      permissions: [{ kind: 'perm', id: 'PERM.AGENT_PERM_AGENT_LIST', name: 'List Agents', bit: `0x${(1n << 103n).toString(16)}` }],
    }
    const recorded = await client.sessions.prompt({
      sessionId: alpha,
      mode: 'queue',
      content: [{ type: 'text', text: 'first prompt' }],
      addonSnapshot: [{ addonId: 'agent', enabled: true, permissionInjection }],
    })
    const refreshedPermissionInjection = {
      permissions: [{ kind: 'perm', id: 'PERM.AGENT_PERM_AGENT_UPDATE', name: 'Update an Agent', bit: `0x${(1n << 106n).toString(16)}` }],
    }
    const refreshed = await client.sessions.permissionInjection({
      sessionId: alpha,
      injections: [{ addonId: 'agent', ...refreshedPermissionInjection }],
    })
    const history = await client.sessions.history({ sessionId: alpha, maxMessages: 100 })

    expect(recorded.result.ok).toBe(true)
    expect(refreshed.result.ok).toBe(true)
    if (!history.result.ok) throw new Error(history.result.error.message)
    const events = history.result.value.events
    const mount = events.find(entry => entry.event.type === 'session/addons')
    const injections = events.filter(entry => entry.event.type === 'session/permission-injection')
    const prompt = events.filter(entry => entry.event.type === 'user/message').at(-1)
    expect(mount?.event).toMatchObject({ data: { snapshot: [{ addonId: 'agent', enabled: true }] } })
    expect(injections).toHaveLength(2)
    expect(injections[0]?.event).toMatchObject({
      type: 'session/permission-injection',
      data: { addonId: 'agent', ...permissionInjection },
    })
    expect(injections[1]?.event).toMatchObject({
      type: 'session/permission-injection',
      data: { addonId: 'agent', ...refreshedPermissionInjection },
    })
    expect(injections[0]?.event.seq).toBeLessThan(prompt?.event.seq ?? 0)
    expect(injections[1]?.event.seq).toBeGreaterThan(injections[0]?.event.seq ?? 0)
  })

  it('lets individual addon changes override an initial snapshot', async () => {
    const client = new FixtureApiClient()
    await client.sessions.prompt({
      sessionId: alpha,
      mode: 'queue',
      content: [{ type: 'text', text: 'first prompt' }],
      addonSnapshot: [{ addonId: 'base', enabled: false }, { addonId: 'agent', enabled: true }],
    })
    const changed = await client.sessions.addons({ sessionId: alpha, addonId: 'base', enabled: true })
    const repeated = await client.sessions.addons({ sessionId: alpha, addonId: 'base', enabled: true })
    const history = await client.sessions.history({ sessionId: alpha, maxMessages: 100 })

    expect(repeated.result).toEqual(changed.result)
    if (!history.result.ok) throw new Error(history.result.error.message)
    const addonEvents = history.result.value.events.filter(entry => entry.event.type === 'session/addons')
    expect(addonEvents).toHaveLength(2)
    expect(addonEvents.at(-1)?.event).toMatchObject({ type: 'session/addons', data: { addonId: 'base', enabled: true } })
  })

  it('projects only the known settings namespace', async () => {
    const client = new FixtureApiClient()
    const empty = await client.settings.project({ sections: {} })
    const projected = await client.settings.project({
      sections: { 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
    })

    expect(empty.result).toEqual({ ok: true, value: { namespaces: [] } })
    if (!projected.result.ok) throw new Error(projected.result.error.message)
    expect(projected.result.value.namespaces.map(namespace => namespace.ns)).toEqual(['llm-deepseek'])
  })
})
