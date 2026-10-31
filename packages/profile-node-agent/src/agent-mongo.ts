// @ts-nocheck
import type { Context } from '@ejunz/cordis';
import { StorageError, storageBackendServiceKey, type KvUnitDescriptor, type StorageBackend } from '@ejunz/ea-core/storage';
import { SessionPersistence, PersistenceCoordinator, type PersistenceBackend, type SessionInspection, type SessionPersistenceSnapshot, type SessionPersistenceRevision, type StoredPrefix } from '@ejunz/ea-core/session-persistence';
import type { SessionEvent, SessionHeader, SessionId } from '@ejunz/ea-core/session';

export const name = 'agent-mongo';
export const inject = ['storage'];

interface MongoStore {
    openStorageUnit(descriptor: KvUnitDescriptor): Promise<any>;
    listStoredSessions(): Promise<{ header: SessionHeader; revision: SessionPersistenceRevision }[]>;
    loadStoredSession(id: string): Promise<StoredPrefix<undefined> | undefined>;
    sessionRevision(id: string): Promise<SessionPersistenceRevision | undefined>;
    loadStoredSessionFrom(id: string, fromSeq: number): Promise<{ meta: SessionHeader; events: SessionEvent[] } | undefined>;
    appendSessionBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void>;
}

function mongoStore(): MongoStore {
    const value = (globalThis as any).__agent_mongo_model;
    if (!value) throw new Error('Mongo service must be loaded before the Agent profile');
    return value;
}

class MongoStorageBackend implements StorageBackend {
    readonly kv = { open: (descriptor: KvUnitDescriptor) => this.openUnit(descriptor) };
    private readonly units = new Map<string, Promise<any>>();
    private closing?: Promise<void>;
    private readonly model: MongoStore;

    constructor(model: MongoStore) {
        this.model = model;
    }

    private openUnit(descriptor: KvUnitDescriptor) {
        if (this.closing) return Promise.reject(new StorageError('closed', 'Mongo storage backend is closing'));
        if (this.units.has(descriptor.name)) return Promise.reject(new Error(`Storage unit '${descriptor.name}' is already open`));
        const pending = this.model.openStorageUnit(descriptor);
        this.units.set(descriptor.name, pending);
        pending.catch(() => {
            if (this.units.get(descriptor.name) === pending) this.units.delete(descriptor.name);
        });
        return pending;
    }

    close() {
        if (this.closing) return this.closing;
        this.closing = this.closeUnits();
        return this.closing;
    }

    private async closeUnits() {
        for (const pending of [...this.units.values()]) await (await pending.catch(() => undefined))?.close();
        this.units.clear();
    }
}

class MongoSessionPersistence extends SessionPersistence implements PersistenceBackend<undefined> {
    static inject = ['sessions'];
    readonly supportsRawArtifacts = false;
    readonly name = 'mongo';
    private readonly model: MongoStore;
    private readonly coordinator: PersistenceCoordinator<undefined>;

    constructor(ctx: Context, config: any = {}) {
        super(ctx);
        this.model = mongoStore();
        this.coordinator = new PersistenceCoordinator(ctx, this, {
            preparedSessionCacheSize: config.preparedSessionCacheSize ?? 5,
            writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? 200,
        });
    }

    locate(_meta: SessionHeader) { return undefined; }
    create(meta: SessionHeader) { return this.coordinator.create(meta); }
    append(id: SessionId, events: readonly SessionEvent[]) { return this.coordinator.append(id, events); }
    prepare(id: SessionId, signal?: AbortSignal) { return this.coordinator.prepare(id, signal); }
    load(id: SessionId): Promise<SessionInspection> { return this.coordinator.load(id); }
    inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> { return this.coordinator.inspect(id, signal); }
    readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal) { return this.coordinator.readFrom(id, fromSeq, signal); }
    async list(_signal?: AbortSignal): Promise<SessionHeader[]> {
        return (await this.model.listStoredSessions()).map((item) => item.header);
    }
    async listSnapshots(_signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
        return (await this.model.listStoredSessions()).map((item) => ({ header: item.header, revision: item.revision }));
    }
    loadStored(id: SessionId): Promise<StoredPrefix<undefined> | undefined> { return this.model.loadStoredSession(id); }
    readStoredRevision(id: SessionId): Promise<SessionPersistenceRevision | undefined> { return this.model.sessionRevision(id); }
    loadStoredFrom(id: SessionId, fromSeq: number) { return this.model.loadStoredSessionFrom(id, fromSeq); }
    appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean) { return this.model.appendSessionBatch(meta, events, isMaterialized); }
    async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]) {
        if (closers.length > 0) await this.model.appendSessionBatch(meta, closers, true);
    }
}

export async function apply(ctx: Context) {
    const backend = new MongoStorageBackend(mongoStore());
    ctx.effect(() => {
        const unregister = ctx.storage.backend.register('mongo', backend);
        ctx.provide(storageBackendServiceKey('mongo'), backend);
        return async () => {
            unregister();
            await backend.close();
        };
    }, 'node-agent-mongo.storage');
    await Promise.resolve(ctx.plugin(MongoSessionPersistence));
}
