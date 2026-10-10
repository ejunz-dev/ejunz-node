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
    expect(history.result.value.events.some(entry =>
      entry.event.type === 'user/message'
      && entry.event.data.source.kind === 'plugin'
      && entry.event.data.source.plugin === 'ejunz-agent-plugin-lifecycle')).toBe(false)

    const missing = await client.sessions.addons({
      sessionId: 'unknown-fixture-session' as SessionId,
      addonId: 'base',
      enabled: true,
    })
    expect(missing.result.ok).toBe(false)
    if (missing.result.ok) throw new Error('fixture accepted an addon event for a missing session')
    expect(missing.result.error.code).toBe('session-not-found')
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
