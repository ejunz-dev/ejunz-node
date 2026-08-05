import { Buffer } from 'node:buffer';

export const EDGE_WS_PROTOCOL = 'edge-ws/v1';
export const EDGE_WS_MAX_MESSAGE_BYTES = 64 * 1024;
export const EDGE_WS_MAX_ID_LENGTH = 128;
export const EDGE_WS_MAX_LIST_ITEMS = 128;
export const EDGE_WS_MAX_TOPIC_LENGTH = 256;

export type EdgeWsHello = { protocol: typeof EDGE_WS_PROTOCOL; type: 'hello'; requestId?: string; clientId?: string };
export type EdgeWsSubscribe = { protocol: typeof EDGE_WS_PROTOCOL; type: 'subscribe'; requestId?: string; nodeIds?: string[]; deviceIds?: string[]; topics?: string[] };
export type EdgeWsSnapshotRequest = { protocol: typeof EDGE_WS_PROTOCOL; type: 'snapshot_request'; requestId?: string; nodeIds?: string[]; deviceIds?: string[] };
export type EdgeWsControl = { protocol: typeof EDGE_WS_PROTOCOL; type: 'control'; requestId?: string; nodeId: string; deviceId: string; state: 'ON' | 'OFF' | 'TOGGLE' };
export type EdgeWsPing = { protocol: typeof EDGE_WS_PROTOCOL; type: 'ping'; requestId?: string; timestamp?: number };
export type EdgeWsMessage = EdgeWsHello | EdgeWsSubscribe | EdgeWsSnapshotRequest | EdgeWsControl | EdgeWsPing;
export type EdgeWsParseResult = { ok: true; message: EdgeWsMessage } | { ok: false; code: string; message: string };

function record(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function stringField(value: unknown, name: string, required = false, maxLength = EDGE_WS_MAX_ID_LENGTH) {
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`);
    return value.trim();
}
function stringList(value: unknown, name: string, maxLength = EDGE_WS_MAX_ID_LENGTH) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > EDGE_WS_MAX_LIST_ITEMS) throw new Error(`${name} must contain at most ${EDGE_WS_MAX_LIST_ITEMS} items`);
    const result = value.map((item) => stringField(item, name, true, maxLength)!);
    if (new Set(result).size !== result.length) throw new Error(`${name} must not contain duplicates`);
    return result;
}
function allowedKeys(value: Record<string, any>, keys: string[]) {
    const allowed = new Set(keys);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`unknown field: ${unknown}`);
}
function validateMessage(value: unknown): EdgeWsMessage {
    if (!record(value)) throw new Error('message must be a JSON object');
    if (value.protocol !== EDGE_WS_PROTOCOL) throw new Error(`protocol must be ${EDGE_WS_PROTOCOL}`);
    const type = stringField(value.type, 'type', true, 32);
    switch (type) {
        case 'hello':
            allowedKeys(value, ['protocol', 'type', 'requestId', 'clientId']);
            return { protocol: EDGE_WS_PROTOCOL, type, requestId: stringField(value.requestId, 'requestId'), clientId: stringField(value.clientId, 'clientId') };
        case 'subscribe':
            allowedKeys(value, ['protocol', 'type', 'requestId', 'nodeIds', 'deviceIds', 'topics', 'nodes', 'devices']);
            return { protocol: EDGE_WS_PROTOCOL, type, requestId: stringField(value.requestId, 'requestId'), nodeIds: stringList(value.nodeIds ?? value.nodes, 'nodeIds'), deviceIds: stringList(value.deviceIds ?? value.devices, 'deviceIds'), topics: stringList(value.topics, 'topics', EDGE_WS_MAX_TOPIC_LENGTH) };
        case 'snapshot_request':
            allowedKeys(value, ['protocol', 'type', 'requestId', 'nodeIds', 'deviceIds', 'nodes', 'devices']);
            return { protocol: EDGE_WS_PROTOCOL, type, requestId: stringField(value.requestId, 'requestId'), nodeIds: stringList(value.nodeIds ?? value.nodes, 'nodeIds'), deviceIds: stringList(value.deviceIds ?? value.devices, 'deviceIds') };
        case 'control': {
            allowedKeys(value, ['protocol', 'type', 'requestId', 'nodeId', 'deviceId', 'state']);
            const nodeId = stringField(value.nodeId, 'nodeId', true)!;
            const deviceId = stringField(value.deviceId, 'deviceId', true)!;
            const state = stringField(value.state, 'state', true, 16)?.toUpperCase();
            if (state !== 'ON' && state !== 'OFF' && state !== 'TOGGLE') throw new Error('state must be ON, OFF, or TOGGLE');
            return { protocol: EDGE_WS_PROTOCOL, type, requestId: stringField(value.requestId, 'requestId'), nodeId, deviceId, state };
        }
        case 'ping':
            allowedKeys(value, ['protocol', 'type', 'requestId', 'timestamp']);
            if (value.timestamp !== undefined && (!Number.isSafeInteger(value.timestamp) || value.timestamp < 0)) throw new Error('timestamp must be a non-negative safe integer');
            return { protocol: EDGE_WS_PROTOCOL, type, requestId: stringField(value.requestId, 'requestId'), timestamp: value.timestamp };
        default: throw new Error(`unsupported message type: ${type}`);
    }
}

export function parseEdgeWsMessage(data: unknown): EdgeWsParseResult {
    let bytes: number;
    let text: string;
    if (typeof data === 'string') { text = data; bytes = Buffer.byteLength(data, 'utf8'); }
    else if (Buffer.isBuffer(data) || data instanceof Uint8Array) { bytes = data.byteLength; text = Buffer.from(data).toString('utf8'); }
    else return { ok: false, code: 'invalid_message', message: 'message must be text or UTF-8 bytes' };
    if (bytes > EDGE_WS_MAX_MESSAGE_BYTES) return { ok: false, code: 'message_too_large', message: `message exceeds ${EDGE_WS_MAX_MESSAGE_BYTES} bytes` };
    let value: unknown;
    try { value = JSON.parse(text); } catch { return { ok: false, code: 'invalid_json', message: 'message must contain valid JSON' }; }
    try { return { ok: true, message: validateMessage(value) }; }
    catch (error) { return { ok: false, code: 'invalid_message', message: (error as Error).message }; }
}

export function protocolMessage(type: string, fields: Record<string, any> = {}) { return { protocol: EDGE_WS_PROTOCOL, type, ...fields }; }
