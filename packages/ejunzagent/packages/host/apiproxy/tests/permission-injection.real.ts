import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@ejunz/app-boot'
import type { ApiProxy } from '../src/api/index.ts'
import type { Session } from '@ejunz/session'

interface FixtureService {
  session: Session
}

const configPath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/permission-injection/cordis.yml')
const ctx = await boot('permission-injection-real-composition', configPath)
try {
  const fixture = ctx.get('permissionInjectionFixture') as FixtureService
  const api = ctx.get('apiProxy') as ApiProxy
  const permissionInjection = {
    addonId: 'base',
    permissions: [{ kind: 'priv', id: 'PRIV.USER_PRIV_USER_PROFILE', name: 'User Profile', bit: '0x4' }],
  }
  const response = await api.sessions.permissionInjection({
    rpcId: 'permission-injection-real-test',
    payload: { sessionId: fixture.session.id, injections: [permissionInjection] },
  })

  assert.deepEqual(response.result, { ok: true, value: { accepted: true, seq: 0 } })
  assert.equal(fixture.session.events.length, 1)
  assert.equal(fixture.session.events[0]?.type, 'session/permission-injection')
  assert.equal(fixture.session.events[0]?.seq, 0)
  assert.deepEqual(fixture.session.events[0]?.data, permissionInjection)
  console.log('permission injection persisted through the composed host API')
} finally {
  await ctx.fiber.dispose()
}
