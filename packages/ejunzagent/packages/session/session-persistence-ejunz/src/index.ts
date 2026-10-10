import { Context } from '@ejunz/cordis'
import z from '@ejunz/schemastery'
import type { SessionEvent, SessionId, SessionHeader } from '@ejunz/session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionInspection,
  type SessionPersistenceSnapshot,
  type SessionLocation,
  type StoredPrefix,
} from '@ejunz/session-persistence'

export interface Config {
  origin: string
  token: string
  timeoutMs?: number
  preparedSessionCacheSize?: number
  writeBatchMaxDelayMs?: number
}

interface Reply<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

interface StoredSession {
  meta: SessionHeader
  events: SessionEvent[]
}

interface StoredSessionTail {
  meta: SessionHeader
  events: SessionEvent[]
  hasMore: boolean
}

interface StoredSnapshot {
  header: SessionHeader
  revision: string
}

export class EjunzSessionPersistence extends SessionPersistence implements PersistenceBackend<undefined> {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    origin: z.string().required(),
    token: z.string().required(),
    timeoutMs: z.number().step(1).min(1000).default(30_000),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-ejunz'

  private readonly origin: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly coordinator: PersistenceCoordinator<undefined>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.origin = config.origin.replace(/\/$/, '')
    this.token = config.token
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.coordinator = new PersistenceCoordinator<undefined>(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  private async request<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`Ejunz persistence request timed out: ${method}`)), this.timeoutMs)
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetch(`${this.origin}/api/ejunz-agent/data/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ejunz-agent-token': this.token,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const reply = await response.json() as Reply<T>
      if (!response.ok || !reply.ok) throw new Error(reply.error?.message || `Ejunz persistence HTTP ${response.status}`)
      return reply.value as T
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  async create(meta: SessionHeader): Promise<void> {
    return await this.coordinator.create(meta)
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return await this.coordinator.append(id, events)
  }

  async load(id: SessionId): Promise<SessionInspection> {
    return await this.coordinator.load(id)
  }

  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return await this.coordinator.inspect(id, signal)
  }

  async readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const inspection = await this.coordinator.readFrom(id, fromSeq, signal)
    return { meta: inspection.meta, events: [...inspection.events] }
  }

  async readTail(id: SessionId, beforeSeq: number | undefined, limit: number, signal?: AbortSignal): Promise<StoredSessionTail> {
    return await this.request<StoredSessionTail>('session/readTail', {
      sessionId: id,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      limit,
    }, signal)
  }

  private async inspectStored(id: SessionId, signal?: AbortSignal): Promise<StoredSession | undefined> {
    try {
      return await this.request<StoredSession>('session/inspect', { sessionId: id }, signal)
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'session not found') return undefined
      throw error
    }
  }

  private revision(events: readonly SessionEvent[]): SessionPersistenceRevision {
    const lastSeq = events.at(-1)?.seq ?? -1
    return SessionPersistenceRevision(`${events.length}:${lastSeq}`)
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<undefined> | undefined> {
    const stored = await this.inspectStored(id, signal)
    if (stored === undefined) return undefined
    return { meta: stored.meta, events: [...stored.events], revision: this.revision(stored.events) }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    return (await this.loadStored(id, signal))?.revision
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    if (events.length === 0) return
    await this.request('session/append', {
      sessionId: meta.id,
      events,
      ...(isMaterialized ? {} : { meta }),
    })
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (closers.length > 0) await this.request('session/append', { sessionId: meta.id, events: closers })
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return await this.request<SessionHeader[]>('session/list', {}, signal)
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const snapshots = await this.request<StoredSnapshot[]>('session/listSnapshots', {}, signal)
    return snapshots.map((snapshot) => ({
      header: snapshot.header,
      revision: SessionPersistenceRevision(snapshot.revision),
    }))
  }
}

export default EjunzSessionPersistence
