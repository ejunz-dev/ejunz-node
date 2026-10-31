// @ts-nocheck
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { MongoClient } from 'mongodb';
import { StorageError, UNIT_NAME_RE, type KvUnitDescriptor } from '@ejunz/ea-core/storage';
import { SessionPersistenceRevision } from '@ejunz/ea-core/session-persistence';

export interface AgentStorageDescriptor {
    name: string;
    version: number;
    tables: string[];
    hasGlobal: boolean;
}

export interface AgentStorageSnapshot {
    tables: Record<string, Record<string, unknown>>;
    global: unknown;
}

export interface AgentSessionHeader {
    id: string;
    version: number;
    createdAt: number;
    [key: string]: unknown;
}

export interface AgentSessionEvent {
    seq: number;
    type: string;
    [key: string]: unknown;
}

const COLLECTIONS = {
    units: 'agent_storage_units',
    records: 'agent_storage_records',
    sessions: 'agent_sessions',
    events: 'agent_session_events',
    settings: 'agent_settings',
    credentials: 'agent_credentials',
    llmConfig: 'agent_llm_config',
} as const;

export interface AgentLlmModelConfig {
    id: string;
    name?: string;
    enabled: boolean;
    contextWindow?: number;
    maxTokens?: number;
    [key: string]: any;
}

export interface AgentLlmProviderConfig {
    id: string;
    displayName: string;
    baseURL: string;
    api?: string;
    apiKeyEnv?: string;
    enabled: boolean;
    models: AgentLlmModelConfig[];
    lastSyncAt?: number;
    [key: string]: any;
}

export interface AgentLlmConfig {
    providers: AgentLlmProviderConfig[];
}

export function llmCredentialRef(providerId: string) {
    const safe = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'PROVIDER';
    return `EDGE_LLM_${safe}_API_KEY`;
}

export function parseCredentialEncryptionKey(raw: string) {
    const encoded = raw.trim().startsWith('base64:') ? raw.trim().slice(7) : raw.trim();
    const key = /^[0-9a-f]{64}$/i.test(encoded)
        ? Buffer.from(encoded, 'hex')
        : Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32) {
        throw new Error('Credential encryption key must encode exactly 32 bytes (base64 or 64-character hex)');
    }
    return key;
}

function encryptionKeyFromEnvironment() {
    const raw = process.env.NODE_AGENT_CREDENTIALS_ENCRYPTION_KEY?.trim();
    return raw ? parseCredentialEncryptionKey(raw) : undefined;
}

function jsonSnapshot(value: unknown) {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Agent storage values must be JSON serializable');
    return JSON.parse(json);
}

function sameJson(left: unknown, right: unknown) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function eventHash(event: unknown) {
    return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

export class AgentMongoModel {
    readonly units: any;
    readonly records: any;
    readonly sessions: any;
    readonly events: any;
    readonly settings: any;
    readonly credentials: any;
    readonly llmConfig: any;
    private readonly credentialEncryptionKey?: Buffer;
    private readonly openedUnits = new Map<string, MongoKvUnit>();
    private readonly sessionChains = new Map<string, Promise<void>>();
    private closing?: Promise<void>;
    readonly client: MongoClient;
    readonly db: any;

    constructor(client: MongoClient, db: any, credentialEncryptionKey?: Buffer) {
        this.client = client;
        this.db = db;
        this.units = db.collection(COLLECTIONS.units);
        this.records = db.collection(COLLECTIONS.records);
        this.sessions = db.collection(COLLECTIONS.sessions);
        this.events = db.collection(COLLECTIONS.events);
        this.settings = db.collection(COLLECTIONS.settings);
        this.credentials = db.collection(COLLECTIONS.credentials);
        this.llmConfig = db.collection(COLLECTIONS.llmConfig);
        this.credentialEncryptionKey = credentialEncryptionKey || encryptionKeyFromEnvironment();
    }

    async ensureIndexes() {
        await Promise.all([
            this.records.createIndex({ unit: 1, table: 1, key: 1 }, { unique: true, name: 'agent_storage_record_key' }),
            this.events.createIndex({ sessionId: 1, seq: 1 }, { unique: true, name: 'agent_session_event_seq' }),
            this.events.createIndex({ sessionId: 1, 'event.type': 1 }, { name: 'agent_session_event_type' }),
            this.sessions.createIndex({ materialized: 1, updatedAt: -1 }, { name: 'agent_session_updated' }),
        ]);
    }

    async loadSettingsDocument(): Promise<Record<string, unknown>> {
        const rows = await this.settings.find({}).toArray();
        return Object.fromEntries(rows.map((row: any) => [String(row._id), jsonSnapshot(row.section)]));
    }

    async persistSettingsSection(namespace: string, section: Record<string, unknown>) {
        await this.settings.updateOne(
            { _id: namespace },
            {
                $set: { section: jsonSnapshot(section), updatedAt: new Date() },
                $setOnInsert: { createdAt: new Date() },
                $inc: { revision: 1 },
            },
            { upsert: true },
        );
    }

    async hasLlmConfig() {
        return Boolean(await this.llmConfig.findOne({ _id: 'edge' }, { projection: { _id: 1 } }));
    }

    async loadLlmConfigState() {
        const row = await this.llmConfig.findOne({ _id: 'edge' });
        if (!row) return { config: { providers: [] } as AgentLlmConfig, revision: 0 };
        if (!row.config || !Array.isArray(row.config.providers)) throw new Error('Mongo LLM configuration is invalid');
        return { config: jsonSnapshot(row.config) as AgentLlmConfig, revision: Number(row.revision) || 0 };
    }

    async loadLlmConfig(): Promise<AgentLlmConfig> {
        return (await this.loadLlmConfigState()).config;
    }

    async saveLlmConfig(config: AgentLlmConfig, expectedRevision?: number) {
        const snapshot = jsonSnapshot(config) as AgentLlmConfig;
        const current = await this.llmConfig.findOne({ _id: 'edge' }, { projection: { revision: 1 } });
        if (!current) {
            if (expectedRevision !== undefined && expectedRevision !== 0) throw new Error('LLM configuration changed; refresh and try again');
            try {
                await this.llmConfig.insertOne({ _id: 'edge', config: snapshot, revision: 1, createdAt: new Date(), updatedAt: new Date() });
                return 1;
            } catch (error) {
                if ((error as any)?.code !== 11000) throw error;
                throw new Error('LLM configuration changed; refresh and try again');
            }
        }
        const revision = Number(current.revision) || 0;
        if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('LLM configuration changed; refresh and try again');
        const result = await this.llmConfig.updateOne(
            { _id: 'edge', revision },
            { $set: { config: snapshot, updatedAt: new Date() }, $inc: { revision: 1 } },
        );
        if (result.modifiedCount !== 1) throw new Error('LLM configuration changed; refresh and try again');
        return revision + 1;
    }

    async getLlmConfigRevision() {
        const row = await this.llmConfig.findOne({ _id: 'edge' }, { projection: { revision: 1 } });
        return Number(row?.revision) || 0;
    }

    async hasCredentialEncryptionKey() {
        return this.credentialEncryptionKey !== undefined;
    }

    async resolveCredential(reference: string) {
        const row = await this.credentials.findOne({ _id: reference });
        if (!row) return undefined;
        return this.decryptCredential(row);
    }

    async describeCredential(reference: string) {
        const row = await this.credentials.findOne({ _id: reference }, { projection: { _id: 1 } });
        return Boolean(row);
    }

    async setCredential(reference: string, value: string) {
        if (!value) throw new Error('Credential value cannot be empty');
        const encrypted = this.encryptCredential(value);
        await this.credentials.updateOne(
            { _id: reference },
            { $set: { ...encrypted, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true },
        );
    }

    async unsetCredential(reference: string) {
        await this.credentials.deleteOne({ _id: reference });
    }

    private encryptCredential(value: string) {
        const key = this.credentialEncryptionKey;
        if (!key) throw new Error('Configure NODE_AGENT_CREDENTIALS_ENCRYPTION_KEY before storing API keys');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return {
            algorithm: 'aes-256-gcm',
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
        };
    }

    private decryptCredential(row: any) {
        const key = this.credentialEncryptionKey;
        if (!key) throw new Error('Configure NODE_AGENT_CREDENTIALS_ENCRYPTION_KEY to read stored API keys');
        if (row.algorithm !== 'aes-256-gcm' || typeof row.iv !== 'string' || typeof row.tag !== 'string' || typeof row.ciphertext !== 'string') {
            throw new Error('Stored credential has an unsupported encrypted format');
        }
        try {
            const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
            decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
            return Buffer.concat([
                decipher.update(Buffer.from(row.ciphertext, 'base64')),
                decipher.final(),
            ]).toString('utf8');
        } catch {
            throw new Error('Stored credential could not be decrypted; verify NODE_AGENT_CREDENTIALS_ENCRYPTION_KEY');
        }
    }

    async openStorageUnit(descriptor: AgentStorageDescriptor) {
        if (this.closing) throw new StorageError('closed', 'Agent Mongo storage is closing');
        if (!UNIT_NAME_RE.test(descriptor.name)) throw new Error(`Invalid storage unit name: ${descriptor.name}`);
        if (!Number.isSafeInteger(descriptor.version) || descriptor.version < 0) throw new Error('Storage unit version must be a non-negative integer');
        for (const table of descriptor.tables) if (!UNIT_NAME_RE.test(table)) throw new Error(`Invalid storage table name: ${table}`);
        if (this.openedUnits.has(descriptor.name)) throw new Error(`Storage unit '${descriptor.name}' is already open`);

        const stableTables = [...descriptor.tables].sort();
        const existing = await this.units.findOne({ _id: descriptor.name });
        if (existing) {
            if (existing.version !== descriptor.version) {
                throw new StorageError('version-mismatch', `Storage unit '${descriptor.name}' is version ${existing.version}, requested ${descriptor.version}`);
            }
            if (!sameJson([...(existing.tables || [])].sort(), stableTables)) {
                throw new StorageError('malformed-medium', `Storage unit '${descriptor.name}' tables do not match its Mongo record`);
            }
            if (existing.legacyHasGlobalUnknown === true || existing.hasGlobal === null) {
                await this.units.updateOne(
                    { _id: descriptor.name, version: descriptor.version },
                    { $set: { hasGlobal: descriptor.hasGlobal, updatedAt: new Date() }, $unset: { legacyHasGlobalUnknown: '' } },
                );
            } else if (existing.hasGlobal !== descriptor.hasGlobal) {
                throw new StorageError('malformed-medium', `Storage unit '${descriptor.name}' global-slot descriptor does not match its Mongo record`);
            }
        } else {
            await this.units.insertOne({
                _id: descriptor.name,
                version: descriptor.version,
                tables: stableTables,
                hasGlobal: descriptor.hasGlobal,
                global: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        }

        const unit = new MongoKvUnit(this, descriptor);
        this.openedUnits.set(descriptor.name, unit);
        return unit;
    }

    releaseStorageUnit(name: string, unit: MongoKvUnit) {
        if (this.openedUnits.get(name) === unit) this.openedUnits.delete(name);
    }

    async getStorageUnitDescriptor(name: string): Promise<AgentStorageDescriptor> {
        const unit = await this.units.findOne({ _id: name });
        if (!unit) throw new Error(`Storage unit '${name}' is not open`);
        return { name, version: unit.version, tables: [...unit.tables], hasGlobal: unit.hasGlobal };
    }

    async loadStorageUnitByName(name: string) {
        return this.loadStorageUnit(await this.getStorageUnitDescriptor(name));
    }

    async loadStorageUnit(descriptor: AgentStorageDescriptor): Promise<AgentStorageSnapshot> {
        const unit = await this.units.findOne({ _id: descriptor.name });
        if (!unit) throw new Error(`Storage unit '${descriptor.name}' is not open`);
        const rows = await this.records.find({ unit: descriptor.name }).toArray();
        const tables: Record<string, Record<string, unknown>> = Object.fromEntries(descriptor.tables.map((table) => [table, {}]));
        for (const row of rows) if (Object.prototype.hasOwnProperty.call(tables, row.table)) tables[row.table][row.key] = row.value;
        return { tables, global: unit.hasGlobal ? unit.global : null };
    }

    async putStorageRecord(unit: string, table: string, key: string, value: unknown) {
        const descriptor = await this.getStorageUnitDescriptor(unit);
        if (!descriptor.tables.includes(table)) throw new Error(`Table '${table}' is not declared by storage unit '${unit}'`);
        const snapshot = jsonSnapshot(value);
        await this.records.updateOne(
            { unit, table, key },
            { $set: { value: snapshot, updatedAt: new Date() }, $setOnInsert: { unit, table, key } },
            { upsert: true },
        );
        await this.units.updateOne({ _id: unit }, { $set: { updatedAt: new Date() } });
    }

    async deleteStorageRecord(unit: string, table: string, key: string) {
        const descriptor = await this.getStorageUnitDescriptor(unit);
        if (!descriptor.tables.includes(table)) throw new Error(`Table '${table}' is not declared by storage unit '${unit}'`);
        const result = await this.records.deleteOne({ unit, table, key });
        if (result.deletedCount) await this.units.updateOne({ _id: unit }, { $set: { updatedAt: new Date() } });
        return result.deletedCount > 0;
    }

    async setStorageGlobal(unit: string, value: unknown) {
        const result = await this.units.updateOne(
            { _id: unit, hasGlobal: true },
            { $set: { global: jsonSnapshot(value), updatedAt: new Date() } },
        );
        if (result.matchedCount !== 1) throw new Error(`Storage unit '${unit}' has no global slot`);
    }

    async ensureSession(header: AgentSessionHeader) {
        await this.sessions.updateOne(
            { _id: header.id },
            {
                $setOnInsert: {
                    _id: header.id,
                    header: jsonSnapshot(header),
                    nextSeq: 0,
                    revision: 0,
                    materialized: true,
                    updatedAt: new Date(),
                },
            },
            { upsert: true },
        );
        const current = await this.sessions.findOne({ _id: header.id }, { projection: { header: 1 } });
        if (current?.header?.version !== header.version) {
            throw new Error(`Session '${header.id}' metadata conflicts with the stored header`);
        }
    }

    async appendRuntimeEvent(sessionId: string, rawEvent: Record<string, unknown>) {
        let session = await this.sessions.findOne({ _id: sessionId });
        if (!session) {
            await this.ensureSession({ id: sessionId, version: 0, createdAt: Date.now(), delegationDepth: 0 });
            session = await this.sessions.findOne({ _id: sessionId });
        }
        if (!session) return false;
        const seq = Number.isSafeInteger(Number(rawEvent.seq)) ? Number(rawEvent.seq) : Number(session.nextSeq) || 0;
        const event: AgentSessionEvent = {
            type: String(rawEvent.type || 'unknown'),
            seq,
            time: Number(rawEvent.time || rawEvent.timestamp || Date.now()),
            data: rawEvent.data ?? {},
            ...(rawEvent.ignorable === true ? { ignorable: true } : {}),
        };
        await this.appendSessionBatch(session.header as AgentSessionHeader, [event], true);
        return true;
    }

    async deleteSession(sessionId: string) {
        await Promise.all([
            this.sessions.deleteOne({ _id: sessionId }),
            this.events.deleteMany({ sessionId }),
        ]);
    }

    async serializeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
        if (this.closing) throw new StorageError('closed', 'Agent Mongo storage is closing');
        const previous = this.sessionChains.get(sessionId) || Promise.resolve();
        const current = previous.then(operation, operation);
        const settled = current.then(() => undefined, () => undefined);
        this.sessionChains.set(sessionId, settled);
        try {
            return await current;
        } finally {
            if (this.sessionChains.get(sessionId) === settled) this.sessionChains.delete(sessionId);
        }
    }

    async appendSessionBatch(meta: AgentSessionHeader, events: readonly AgentSessionEvent[], isMaterialized: boolean) {
        if (events.length === 0 && !isMaterialized) return;
        return this.serializeSession(meta.id, async () => {
            let session = await this.sessions.findOne({ _id: meta.id });
            if (!session) {
                try {
                    await this.sessions.insertOne({
                        _id: meta.id,
                        header: jsonSnapshot(meta),
                        nextSeq: 0,
                        revision: 0,
                        materialized: false,
                        updatedAt: new Date(),
                    });
                } catch (error) {
                    if ((error as any)?.code !== 11000) throw error;
                }
                session = await this.sessions.findOne({ _id: meta.id });
            }
            if (!session || session.header?.id !== meta.id) throw new Error(`Session '${meta.id}' metadata is missing or invalid`);
            if (session.header.version !== meta.version || session.header.createdAt !== meta.createdAt) {
                throw new Error(`Session '${meta.id}' metadata conflicts with the stored header`);
            }

            let expected = Number(session.nextSeq) || 0;
            const prepared = events.map((event) => {
                const seq = Number(event.seq);
                if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`Invalid event sequence for session '${meta.id}'`);
                return { seq, event: jsonSnapshot(event) };
            });
            const existingRows = prepared.length
                ? await this.events.find(
                    { sessionId: meta.id, seq: { $in: prepared.map((item) => item.seq) } },
                    { projection: { seq: 1, event: 1 } },
                ).toArray()
                : [];
            const existingBySeq = new Map(existingRows.map((row: any) => [Number(row.seq), row.event]));
            const operations: any[] = [];
            for (const item of prepared) {
                const { seq, event } = item;
                if (seq > expected) throw new Error(`Session '${meta.id}' event sequence gap: expected ${expected}, received ${seq}`);
                const existing = existingBySeq.get(seq);
                if (seq < expected) {
                    if (existing === undefined || !sameJson(existing, event)) throw new Error(`Session '${meta.id}' event conflict at sequence ${seq}`);
                    continue;
                }
                if (existing !== undefined) {
                    if (!sameJson(existing, event)) throw new Error(`Session '${meta.id}' event conflict at sequence ${seq}`);
                } else {
                    operations.push({
                        updateOne: {
                            filter: { sessionId: meta.id, seq },
                            update: { $setOnInsert: { sessionId: meta.id, seq, event, digest: eventHash(event), createdAt: new Date() } },
                            upsert: true,
                        },
                    });
                }
                expected += 1;
            }
            if (operations.length) await this.events.bulkWrite(operations, { ordered: true });
            await this.sessions.updateOne(
                { _id: meta.id },
                {
                    $set: { nextSeq: expected, materialized: session.materialized === true || isMaterialized || expected > 0, updatedAt: new Date() },
                    $inc: { revision: 1 },
                },
            );
        });
    }

    async loadStoredSession(sessionId: string) {
        const session = await this.sessions.findOne({ _id: sessionId, materialized: true });
        if (!session) return undefined;
        const rows = await this.events.find({ sessionId }).sort({ seq: 1 }).toArray();
        const events = rows.map((row: any) => row.event);
        for (let index = 0; index < events.length; index += 1) {
            if (Number(events[index].seq) !== index) throw new Error(`Stored session '${sessionId}' has a non-contiguous event log`);
        }
        if (events.length !== Number(session.nextSeq)) throw new Error(`Stored session '${sessionId}' cursor does not match its event log`);
        return {
            meta: session.header as AgentSessionHeader,
            events,
            revision: SessionPersistenceRevision(`${sessionId}:${Number(session.revision) || 0}:${Number(session.nextSeq) || 0}`),
        };
    }

    async loadStoredSessionFrom(sessionId: string, fromSeq: number) {
        const session = await this.sessions.findOne({ _id: sessionId, materialized: true });
        if (!session) return undefined;
        const rows = await this.events.find({ sessionId, seq: { $gte: fromSeq } }).sort({ seq: 1 }).toArray();
        return { meta: session.header as AgentSessionHeader, events: rows.map((row: any) => row.event) };
    }

    async sessionRevision(sessionId: string) {
        const session = await this.sessions.findOne({ _id: sessionId, materialized: true }, { projection: { revision: 1, nextSeq: 1 } });
        return session ? SessionPersistenceRevision(`${sessionId}:${Number(session.revision) || 0}:${Number(session.nextSeq) || 0}`) : undefined;
    }

    async listStoredSessions() {
        return (await this.sessions.find({ materialized: true }).sort({ updatedAt: -1 }).toArray()).map((session: any) => ({
            header: session.header as AgentSessionHeader,
            revision: SessionPersistenceRevision(`${session._id}:${Number(session.revision) || 0}:${Number(session.nextSeq) || 0}`),
        }));
    }

    async close() {
        if (this.closing) return this.closing;
        this.closing = (async () => {
            await Promise.all([...this.sessionChains.values()]);
            await Promise.all([...this.openedUnits.values()].map((unit) => unit.close()));
        })();
        return this.closing;
    }
}

export class MongoKvUnit {
    private closed = false;
    private readonly tables: Set<string>;
    private readonly store: AgentMongoModel;
    readonly descriptor: AgentStorageDescriptor;

    constructor(store: AgentMongoModel, descriptor: AgentStorageDescriptor) {
        this.store = store;
        this.descriptor = descriptor;
        this.tables = new Set(descriptor.tables);
    }

    async loadAll() {
        this.assertOpen();
        return this.store.loadStorageUnit(this.descriptor);
    }

    async putRecord(table: string, key: string, value: unknown) {
        this.assertTable(table);
        await this.store.putStorageRecord(this.descriptor.name, table, key, value);
    }

    async deleteRecord(table: string, key: string) {
        this.assertTable(table);
        await this.store.deleteStorageRecord(this.descriptor.name, table, key);
    }

    async setGlobal(value: unknown) {
        this.assertOpen();
        if (!this.descriptor.hasGlobal) throw new Error(`Storage unit '${this.descriptor.name}' has no global slot`);
        await this.store.setStorageGlobal(this.descriptor.name, value);
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this.store.releaseStorageUnit(this.descriptor.name, this);
    }

    private assertOpen() {
        if (this.closed) throw new StorageError('closed', `Storage unit '${this.descriptor.name}' is closed`);
    }

    private assertTable(table: string) {
        this.assertOpen();
        if (!this.tables.has(table)) throw new Error(`Table '${table}' is not declared by storage unit '${this.descriptor.name}'`);
    }
}
