import type { Context } from '@ejunz/cordis'
import z from '@ejunz/schemastery'
import {
  StorageError,
  UNIT_NAME_RE,
  storageBackendServiceKey,
  type KvFacet,
  type KvUnit,
  type KvUnitDescriptor,
  type StorageBackend,
} from '@ejunz/storage'

export const name = 'storage-ejunz'
export const inject = ['storage']

export interface Config {
  origin: string
  token: string
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  origin: z.string().required(),
  token: z.string().required(),
  timeoutMs: z.number().step(1).min(1000).default(30_000),
})

interface Reply<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

interface UnitSnapshot {
  tables: Record<string, Record<string, unknown>>
  global: unknown
}

class RemoteUnit implements KvUnit {
  private closed = false

  constructor(private readonly backend: EjunzStorageBackend, private readonly descriptor: KvUnitDescriptor) {}

  async loadAll(): Promise<UnitSnapshot> {
    return await this.backend.request<UnitSnapshot>('storage/load', { name: this.descriptor.name }, this)
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    await this.backend.request('storage/put', { name: this.descriptor.name, table, key, value }, this)
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    await this.backend.request('storage/delete', { name: this.descriptor.name, table, key }, this)
  }

  async setGlobal(value: unknown): Promise<void> {
    if (!this.descriptor.hasGlobal) throw new Error(`storage unit '${this.descriptor.name}' has no global slot`)
    await this.backend.request('storage/setGlobal', { name: this.descriptor.name, value }, this)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.backend.release(this.descriptor.name, this)
  }

  assertOpen(): void {
    if (this.closed) throw new StorageError('closed', `storage unit '${this.descriptor.name}' is closed`)
  }
}

export class EjunzStorageBackend implements StorageBackend {
  private readonly units = new Map<string, RemoteUnit>()
  private closed = false

  constructor(private readonly config: Config) {}

  readonly kv: KvFacet = {
    open: async (descriptor) => {
      if (this.closed) throw new StorageError('closed', 'ejunz storage backend is closed')
      if (!UNIT_NAME_RE.test(descriptor.name) || descriptor.tables.some((table) => !UNIT_NAME_RE.test(table))) {
        throw new StorageError('malformed-medium', `invalid storage descriptor '${descriptor.name}'`)
      }
      if (this.units.has(descriptor.name)) throw new Error(`unit '${descriptor.name}' is already open`)
      await this.request('storage/open', { descriptor })
      const unit = new RemoteUnit(this, descriptor)
      this.units.set(descriptor.name, unit)
      return unit
    },
  }

  release(name: string, unit: RemoteUnit): void {
    if (this.units.get(name) === unit) this.units.delete(name)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([...this.units.values()].map((unit) => unit.close()))
    this.units.clear()
  }

  async request<T>(method: string, payload: Record<string, unknown>, unit?: RemoteUnit): Promise<T> {
    if (unit) unit.assertOpen()
    if (this.closed) throw new StorageError('closed', 'ejunz storage backend is closed')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`Ejunz storage request timed out: ${method}`)), this.config.timeoutMs ?? 30_000)
    try {
      const response = await fetch(`${this.config.origin.replace(/\/$/, '')}/api/ejunz-agent/data/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ejunz-agent-token': this.config.token,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const reply = await response.json() as Reply<T>
      if (!response.ok || !reply.ok) throw new Error(reply.error?.message || `Ejunz storage HTTP ${response.status}`)
      return reply.value as T
    } finally {
      clearTimeout(timer)
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  const backend = new EjunzStorageBackend(config)
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('ejunz', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('ejunz'), backend)
}

