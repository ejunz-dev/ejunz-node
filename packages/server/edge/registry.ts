import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config';
import { fs } from '../utils';
import { EdgeEnvelope, generateTraceId, hashToken, safeTokenEqual } from './protocol';

export type EdgeNodeStatus = 'pending' | 'online' | 'offline' | 'revoked';

export type EdgeNodeRecord = {
    nodeId: string;
    host: string;
    port: number;
    status: EdgeNodeStatus;
    tools: any[];
    lastSeen: number;
    authorizedAt?: number;
    revokedAt?: number;
    tokenHash?: string;
    requestId?: string;
    requestExpiresAt?: number;
    metadata?: Record<string, any>;
    connection?: any;
};

type EnvelopeListener = (node: EdgeNodeRecord, envelope: EdgeEnvelope) => void;

class EdgeRegistry {
    private readonly nodes = new Map<string, EdgeNodeRecord>();
    private readonly listeners = new Set<EnvelopeListener>();
    private readonly pendingRequests = new Map<string, {
        nodeId: string;
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        timer: NodeJS.Timeout;
    }>();
    private loaded = false;

    private storagePath() {
        const configured = (config as any).auth?.tokenFile || 'data/edge-nodes.json';
        return path.resolve(process.cwd(), configured);
    }

    init() {
        if (this.loaded) return;
        this.loaded = true;
        const file = this.storagePath();
        if (!fs.existsSync(file)) return;
        try {
            const records = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(records)) return;
            for (const record of records) {
                if (record?.nodeId) this.nodes.set(String(record.nodeId), { ...record, connection: undefined });
            }
        } catch {
            // A corrupt registry must not prevent the edge from starting.
        }
    }

    private persist() {
        const file = this.storagePath();
        fs.ensureDirSync(path.dirname(file));
        const records = Array.from(this.nodes.values()).map(({ connection, ...record }) => record);
        fs.writeFileSync(file, JSON.stringify(records, null, 2));
    }

    private node(nodeId: string, metadata: Partial<EdgeNodeRecord> = {}) {
        const id = String(nodeId || '').trim();
        if (!id) throw new Error('nodeId is required');
        const existing = this.nodes.get(id);
        const record: EdgeNodeRecord = {
            host: 'unknown',
            port: 0,
            status: 'offline',
            tools: [],
            lastSeen: Date.now(),
            ...existing,
            ...metadata,
            nodeId: id,
        };
        this.nodes.set(id, record);
        return record;
    }

    list() {
        this.init();
        return Array.from(this.nodes.values()).map(({ connection, tokenHash, ...record }) => ({
            ...record,
            tokenConfigured: Boolean(tokenHash),
            connected: Boolean(connection),
        }));
    }

    get(nodeId: string) {
        this.init();
        return this.nodes.get(String(nodeId));
    }

    requestAuthorization(nodeId: string, metadata: Partial<EdgeNodeRecord>, connection: any) {
        this.init();
        const record = this.node(nodeId, {
            ...metadata,
            status: 'pending',
            requestId: generateTraceId('authorize', nodeId),
            requestExpiresAt: Date.now() + Number((config as any).auth?.requestTtl || 300000),
            connection,
            lastSeen: Date.now(),
        });
        this.persist();
        return record;
    }

    authorize(nodeId: string) {
        this.init();
        const record = this.node(nodeId);
        if (!record.connection || !record.requestId || (record.requestExpiresAt || 0) < Date.now()) {
            throw new Error(`Node ${nodeId} has no active authorization request`);
        }
        const token = crypto.randomBytes(32).toString('base64url');
        record.tokenHash = hashToken(token);
        record.authorizedAt = Date.now();
        record.revokedAt = undefined;
        record.status = 'pending';
        record.requestExpiresAt = undefined;
        this.persist();
        return { record, token };
    }

    completeAuthorization(nodeId: string, connection: any) {
        const record = this.node(nodeId, { connection, status: 'online', lastSeen: Date.now() });
        record.requestId = undefined;
        record.requestExpiresAt = undefined;
        this.persist();
        return record;
    }

    authenticate(token: string) {
        this.init();
        if (!token) return undefined;
        for (const record of this.nodes.values()) {
            if (!record.tokenHash || record.status === 'revoked') continue;
            if (safeTokenEqual(record.tokenHash, hashToken(token))) return record;
        }
        return undefined;
    }

    attach(nodeId: string, connection: any, metadata: Partial<EdgeNodeRecord> = {}) {
        const record = this.node(nodeId, { ...metadata, connection, status: 'online', lastSeen: Date.now() });
        record.revokedAt = undefined;
        this.persist();
        return record;
    }

    detach(nodeId: string, connection?: any) {
        const record = this.get(nodeId);
        if (!record) return;
        if (connection && record.connection !== connection) return;
        record.connection = undefined;
        if (record.status !== 'revoked') record.status = 'offline';
        record.lastSeen = Date.now();
        this.persist();
    }

    revoke(nodeId: string) {
        const record = this.node(nodeId, { status: 'revoked', revokedAt: Date.now() });
        const connection = record.connection;
        record.connection = undefined;
        record.tokenHash = undefined;
        this.persist();
        try { connection?.send?.({ type: 'edge/auth_revoked', nodeId }); } catch {}
        try { connection?.close?.(4003, 'token revoked'); } catch {}
        return record;
    }

    updateTools(nodeId: string, tools: any[]) {
        const record = this.node(nodeId, { tools: Array.isArray(tools) ? tools : [], lastSeen: Date.now() });
        if (record.status !== 'revoked') record.status = record.connection ? 'online' : 'offline';
        this.persist();
        return record;
    }

    send(nodeId: string, envelope: EdgeEnvelope) {
        const record = this.get(nodeId);
        if (!record?.connection) return false;
        try {
            record.connection.sendEnvelope(envelope);
            return true;
        } catch {
            return false;
        }
    }

    request(nodeId: string, envelope: EdgeEnvelope, timeoutMs = 15000): Promise<any> {
        const traceId = envelope.traceId || generateTraceId('request', nodeId);
        const request = { ...envelope, traceId, nodeId };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(traceId);
                reject(new Error(`Node ${nodeId} request timed out`));
            }, timeoutMs);
            this.pendingRequests.set(traceId, { nodeId, resolve, reject, timer });
            if (!this.send(nodeId, request)) {
                clearTimeout(timer);
                this.pendingRequests.delete(traceId);
                reject(new Error(`Node ${nodeId} is not connected`));
            }
        });
    }

    onEnvelope(listener: EnvelopeListener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    receive(nodeId: string, envelope: EdgeEnvelope) {
        const record = this.node(nodeId, { lastSeen: Date.now() });
        const pending = envelope.traceId ? this.pendingRequests.get(envelope.traceId) : undefined;
        if (pending && pending.nodeId === nodeId) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(envelope.traceId!);
            const payload = envelope.payload || {};
            if (payload.error) pending.reject(new Error(payload.error.message || 'Node request failed'));
            else pending.resolve(payload.result ?? payload);
        }
        for (const listener of this.listeners) {
            try { listener(record, envelope); } catch {}
        }
    }
}

export const edgeRegistry = new EdgeRegistry();
