// @ts-nocheck
import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { config, isEdgeMode, saveConfig } from '../config';
import { edgeRegistry } from '../edge/registry';
import { maskEndpoint } from '../edge/protocol';
import { callNodeMcp, controlEdgeDevice } from '../edge/device-control';
import { EDGE_WS_MAX_MESSAGE_BYTES, parseEdgeWsMessage, protocolMessage } from '../edge/ws-protocol';
import { getEdgeAuthConfig, isEdgeAdminAuthorized, requireEdgeAdmin as requireAdmin } from './edge-auth';

class EdgeAuthConfigHandler extends Handler<Context> {
    allowCors = true;
    async get() {
        if (!requireAdmin(this)) return;
        const auth = getEdgeAuthConfig();
        this.response.body = {
            enabled: auth.enabled,
            username: auth.username,
            passwordConfigured: Boolean(auth.password),
        };
    }

    async post() {
        if (!requireAdmin(this)) return;

        const body = this.request.body || {};
        const auth = (config as any).auth || ((config as any).auth = {});
        if (body.enabled !== undefined) auth.enabled = Boolean(body.enabled);
        if (typeof body.username === 'string' && body.username.trim()) auth.username = body.username.trim();
        if (typeof body.password === 'string' && body.password.length > 0) auth.password = body.password;
        saveConfig();
        this.response.body = {
            ok: 1,
            enabled: Boolean(auth.enabled),
            username: String(auth.username || 'admin'),
        };
    }
}

class EdgeStatusHandler extends Handler<Context> {
    async get() {
        if (!requireAdmin(this)) return;

        const upstream = (global as any).__edge_upstream;
        const headers = (this.request as any).headers || {};
        const forwardedProto = String(headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        const protocol = forwardedProto === 'https' ? 'wss' : 'ws';
        const host = String((config as any).publicHost || headers.host || `localhost:${(config as any).port || 5283}`);
        const nodePath = String((config as any).nodePath || '/node/conn');
        this.response.body = {
            mode: 'edge',
            nodes: edgeRegistry.list().length,
            broker: Boolean((global as any).__ejunz_aedes),
            nodeEndpoint: `${protocol}://${host}${nodePath.startsWith('/') ? nodePath : `/${nodePath}`}`,
            upstream: upstream?.status?.() || { enabled: false, connected: false },
        };
    }
}

class EdgeNodesHandler extends Handler<Context> {
    async get() {
        if (!requireAdmin(this)) return;

        this.response.body = { nodes: edgeRegistry.list() };
    }
}

function getCurrentDeviceState(node: any, deviceId: string) {
    const states = node?.deviceStates || {};
    const direct = states[deviceId];
    const read = (value: any) => {
        if (!value || typeof value !== 'object') return undefined;
        if (value.state === 'ON' || value.state === 'OFF') return value.state;
        if (value.power === 'ON' || value.power === 'OFF') return value.power;
        return undefined;
    };
    const directState = read(direct);
    if (directState) return directState;
    const endpoint = String(deviceId).match(/^(.+)_(l\d+)$/);
    if (endpoint) {
        const baseState = states[endpoint[1]];
        if (baseState?.[`state_${endpoint[2]}`] === 'ON' || baseState?.[`state_${endpoint[2]}`] === 'OFF') {
            return baseState[`state_${endpoint[2]}`];
        }
        if (baseState?.state === 'ON' || baseState?.state === 'OFF') return baseState.state;
    }
    return undefined;
}

class EdgeNodeToolsHandler extends Handler<Context> {
    async get() {
        if (!requireAdmin(this)) return;

        const nodeId = String((this.request as any).params?.nodeId || '');
        const node = edgeRegistry.get(nodeId);
        if (!node) {
            this.response.status = 404;
            this.response.body = { error: 'node not found' };
            return;
        }
        this.response.body = { nodeId, tools: node.tools || [] };
    }
}

class EdgeNodeDevicesHandler extends Handler<Context> {
    async get() {
        if (!requireAdmin(this)) return;

        const nodeId = String((this.request as any).params?.nodeId || '');
        if (!edgeRegistry.get(nodeId)) {
            this.response.status = 404;
            this.response.body = { error: 'node not found' };
            return;
        }
        try {
            const result = await callNodeMcp(nodeId, 'zigbee_list_devices');
            const devices = Array.isArray(result?.devices) ? result.devices : [];
            for (const device of devices) {
                if (device.currentState === 'ON' || device.currentState === 'OFF') continue;
                try {
                    const status = await callNodeMcp(nodeId, 'zigbee_get_device_status', { deviceId: device.deviceId });
                    if (status?.currentState === 'ON' || status?.currentState === 'OFF') device.currentState = status.currentState;
                } catch {
                    // The list remains usable when a device does not expose a readable state.
                }
            }
            const known = new Set(devices.map((device: any) => String(device.deviceId)));
            const node = edgeRegistry.get(nodeId);
            for (const tool of node?.tools || []) {
                const metadata = tool?.metadata || {};
                if (metadata.category !== 'zigbee-switch' || !metadata.deviceId) continue;
                const deviceId = String(metadata.deviceId);
                if (known.has(deviceId)) continue;
                known.add(deviceId);
                devices.push({
                    deviceId,
                    friendlyName: metadata.friendlyName || deviceId,
                    model: metadata.model || '未知型号',
                    vendor: metadata.vendor || '未知厂商',
                    type: '端点',
                    supportsOnOff: true,
                    endpoint: metadata.endpoint,
                    currentState: devices.find((device: any) => String(device.deviceId) === String(metadata.originalDeviceId))?.state?.[`state_${metadata.endpoint}`]
                        || devices.find((device: any) => String(device.deviceId) === String(metadata.originalDeviceId))?.currentState
                        || null,
                });
            }
            for (const device of devices) {
                const currentState = getCurrentDeviceState(node, String(device.deviceId || ''));
                if (currentState) device.currentState = currentState;
            }
            this.response.body = { ...result, count: devices.length, devices };
        } catch (e) {
            this.response.status = 502;
            this.response.body = { error: (e as Error).message };
        }
    }
}

class EdgeNodeDeviceControlHandler extends Handler<Context> {
    allowCors = true;
    async post() {
        if (!requireAdmin(this)) return;

        const nodeId = String((this.request as any).params?.nodeId || '');
        if (!edgeRegistry.get(nodeId)) {
            this.response.status = 404;
            this.response.body = { error: 'node not found' };
            return;
        }
        const body = this.request.body || {};
        const deviceId = String(body.deviceId || '');
        const state = String(body.state || '').toUpperCase();
        try {
            this.response.body = await controlEdgeDevice(nodeId, deviceId, state);
        } catch (e) {
            this.response.status = 502;
            this.response.body = { error: (e as Error).message };
        }
    }
}

class EdgeAuthorizeHandler extends Handler<Context> {
    allowCors = true;
    async post() {
        if (!requireAdmin(this)) return;

        const nodeId = String((this.request as any).params?.nodeId || '');
        const node = edgeRegistry.get(nodeId);
        if (!node?.connection?.authorize) {
            this.response.status = 404;
            this.response.body = { error: `No pending authorization for ${nodeId}` };
            return;
        }
        try {
            this.response.body = { ok: 1, ...node.connection.authorize() };
        } catch (e) {
            this.response.status = 400;
            this.response.body = { error: (e as Error).message };
        }
    }
}

class EdgeRevokeHandler extends Handler<Context> {
    allowCors = true;
    async post() {
        if (!requireAdmin(this)) return;

        const nodeId = String((this.request as any).params?.nodeId || '');
        if (!edgeRegistry.get(nodeId)) {
            this.response.status = 404;
            this.response.body = { error: 'node not found' };
            return;
        }
        edgeRegistry.revoke(nodeId);
        this.response.body = { ok: 1 };
    }
}

class EdgeUpstreamHandler extends Handler<Context> {
    allowCors = true;
    async get() {
        if (!requireAdmin(this)) return;

        const upstream = (global as any).__edge_upstream;
        const current = (config as any).upstream || {};
        this.response.body = {
            enabled: Boolean(current.enabled),
            endpoint: maskEndpoint(current.endpoint || ''),
            connected: Boolean(upstream?.status?.().connected),
        };
    }

    async post() {
        if (!requireAdmin(this)) return;

        const body = this.request.body || {};
        const upstream = (config as any).upstream || {};
        if (body.enabled !== undefined) upstream.enabled = Boolean(body.enabled);
        if (typeof body.endpoint === 'string' && body.endpoint.trim()) upstream.endpoint = body.endpoint.trim();
        if (typeof body.token === 'string' && body.token) upstream.token = body.token;
        (config as any).upstream = upstream;
        saveConfig();
        const service = (global as any).__edge_upstream;
        await service?.restart?.();
        this.response.body = { ok: 1, endpoint: maskEndpoint(upstream.endpoint || '') };
    }
}

class EdgeUpstreamRestartHandler extends Handler<Context> {
    allowCors = true;
    async post() {
        if (!requireAdmin(this)) return;

        await (global as any).__edge_upstream?.restart?.();
        this.response.body = { ok: 1 };
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    ctx.Route('edge-auth-config', '/api/edge/auth-config', EdgeAuthConfigHandler);
    ctx.Route('edge-status', '/api/edge/status', EdgeStatusHandler);
    ctx.Route('edge-nodes', '/api/edge/nodes', EdgeNodesHandler);
    ctx.Route('edge-node-tools', '/api/edge/nodes/:nodeId/tools', EdgeNodeToolsHandler);
    ctx.Route('edge-node-devices', '/api/edge/nodes/:nodeId/devices', EdgeNodeDevicesHandler);
    ctx.Route('edge-node-device-control', '/api/edge/nodes/:nodeId/devices/control', EdgeNodeDeviceControlHandler);
    ctx.Route('edge-authorize', '/api/edge/nodes/:nodeId/authorize', EdgeAuthorizeHandler);
    ctx.Route('edge-revoke', '/api/edge/nodes/:nodeId/revoke', EdgeRevokeHandler);
    ctx.Route('edge-upstream', '/api/edge/upstream', EdgeUpstreamHandler);
    ctx.Route('edge-upstream-restart', '/api/edge/upstream/restart', EdgeUpstreamRestartHandler);

    // Long-polling endpoint for real-time device state updates (works where WebSocket is blocked)
    ctx.Route('edge-poll', '/api/edge/poll', class extends Handler<Context> {
        allowCors = true;
        async get() {
            if (!requireAdmin(this)) return;
            const nodeId = String(this.request.query.nodeId || '');
            if (!nodeId || !edgeRegistry.get(nodeId)) {
                this.response.body = { error: 'node not found' };
                this.response.status = 404;
                return;
            }
            // Wait for next device state change (up to 30s)
            const result = await new Promise<any>((resolve) => {
                const timer = setTimeout(() => resolve({ timeout: true }), 30000);
                const unsub = edgeRegistry.onEnvelope((record, envelope) => {
                    if (envelope.protocol !== 'mqtt' || envelope.action !== 'publish') return;
                    const match = String(envelope.channel || '').match(/^node\/([^/]+)\/devices\/([^/]+)\/state$/);
                    if (!match || match[1] !== nodeId) return;
                    clearTimeout(timer);
                    unsub();
                    resolve({ deviceId: match[2], state: envelope.payload });
                });
                // Clean up on request close (res may be undefined in some frameworks)
                try { this.request.res?.on?.('close', () => { clearTimeout(timer); unsub(); resolve({ timeout: true }); }); } catch {}
            });
            this.response.body = result;
        }
    });

    // WebSocket endpoint for real-time device state updates (inject server to access router)
    ctx.inject(['server'], ({ server }) => {
        server.router.ws('/api/edge/ws', (socket, req) => {
            if (!isEdgeAdminAuthorized(req)) {
                try { socket.close(4001, 'auth required'); } catch {}
                return;
            }

            let protocolMode = false;
            let closed = false;
            let lastActivity = Date.now();
            let nodeIds: string[] | undefined;
            let deviceIds: string[] | undefined;
            let topics: string[] | undefined;

            const send = (message: any) => {
                if (closed || socket.readyState !== undefined && socket.readyState !== 1) return false;
                try {
                    const payload = JSON.stringify(message);
                    if (Buffer.byteLength(payload, 'utf8') > EDGE_WS_MAX_MESSAGE_BYTES) return false;
                    socket.send(payload);
                    return true;
                } catch { return false; }
            };
            const sendError = (code: string, message: string, requestId?: string) =>
                send(protocolMessage('error', { code, message, ...(requestId ? { requestId } : {}) }));
            const matches = (nodeId: string, deviceId: string, topic: string) => {
                if (nodeIds?.length && !nodeIds.includes(nodeId)) return false;
                if (deviceIds?.length && !deviceIds.includes(deviceId)) return false;
                if (topics?.length && !topics.includes(topic)) return false;
                return true;
            };
            const sendSnapshot = (requestId?: string, requestedNodeIds?: string[], requestedDeviceIds?: string[]) => {
                const snapshot = edgeRegistry.snapshot({
                    nodeIds: requestedNodeIds?.length ? requestedNodeIds : nodeIds,
                    deviceIds: requestedDeviceIds?.length ? requestedDeviceIds : deviceIds,
                });
                send(protocolMessage('device_snapshot', { requestId, ...snapshot }));
            };

            send(protocolMessage('hello', {
                heartbeatIntervalMs: 30000,
                snapshot: true,
                subscriptions: true,
                control: true,
                serverTime: Date.now(),
            }));

            const unsub = edgeRegistry.onEnvelope((record, envelope) => {
                if (envelope.protocol !== 'mqtt' || envelope.action !== 'publish') return;
                const match = String(envelope.channel || '').match(/^node\/([^/]+)\/devices\/([^/]+)\/state$/);
                if (!match || !matches(match[1], match[2], String(envelope.channel))) return;
                if (protocolMode) {
                    send(protocolMessage('device_state', {
                        nodeId: match[1], deviceId: match[2], topic: envelope.channel,
                        payload: envelope.payload || '',
                        updatedAt: record.deviceStateUpdatedAt?.[match[2]] || Date.now(),
                    }));
                } else {
                    send({ type: 'device_state', topic: envelope.channel, payload: envelope.payload || '' });
                }
            });

            const heartbeat = setInterval(() => {
                if (closed) return;
                try { socket.ping?.(); } catch {}
                if (protocolMode) send(protocolMessage('ping', { timestamp: Date.now() }));
                if (Date.now() - lastActivity > 120000) {
                    try { socket.close(4000, 'heartbeat timeout'); } catch {}
                }
            }, 30000);

            const handleMessage = (data: any) => {
                lastActivity = Date.now();
                const parsed = parseEdgeWsMessage(data);
                if (!parsed.ok) {
                    sendError(parsed.code, parsed.message);
                    if (parsed.code === 'message_too_large') try { socket.close(1009, parsed.message); } catch {}
                    return;
                }
                protocolMode = true;
                const message = parsed.message;
                try {
                    switch (message.type) {
                        case 'hello':
                            send(protocolMessage('hello_ack', { requestId: message.requestId, serverTime: Date.now() }));
                            break;
                        case 'subscribe':
                            nodeIds = message.nodeIds;
                            deviceIds = message.deviceIds;
                            topics = message.topics;
                            send(protocolMessage('subscribed', { requestId: message.requestId, nodeIds, deviceIds, topics }));
                            break;
                        case 'snapshot_request':
                            sendSnapshot(message.requestId, message.nodeIds, message.deviceIds);
                            break;
                        case 'control':
                            if ((!nodeIds?.length || nodeIds.includes(message.nodeId))
                                && (!deviceIds?.length || deviceIds.includes(message.deviceId))) {
                                controlEdgeDevice(message.nodeId, message.deviceId, message.state)
                                    .then((result) => send(protocolMessage('control_result', { requestId: message.requestId, ok: true, nodeId: message.nodeId, deviceId: message.deviceId, state: message.state, result })))
                                    .catch((error) => send(protocolMessage('control_result', { requestId: message.requestId, ok: false, nodeId: message.nodeId, deviceId: message.deviceId, error: (error as Error).message })));
                            } else {
                                sendError('control_not_subscribed', 'target is not included in the current subscription', message.requestId);
                            }
                            break;
                        case 'ping':
                            send(protocolMessage('pong', { requestId: message.requestId, timestamp: message.timestamp ?? Date.now(), serverTime: Date.now() }));
                            break;
                    }
                } catch (error) {
                    sendError('request_failed', (error as Error).message, (message as any).requestId);
                }
            };

            socket.on('message', handleMessage);
            socket.on('pong', () => { lastActivity = Date.now(); });
            socket.on('close', () => {
                closed = true;
                clearInterval(heartbeat);
                try { unsub(); } catch {}
            });
            socket.on('error', () => {
                closed = true;
                clearInterval(heartbeat);
                try { unsub(); } catch {}
            });
        });
        if ((config as any).enableSSE !== false) {
            server.router.get('/api/edge/ws', (ctx) => {
                if (!isEdgeAdminAuthorized(ctx.request)) {
                    ctx.status = 401;
                    ctx.set('WWW-Authenticate', 'Basic realm="Ejunz Edge"');
                    ctx.body = { error: 'edge admin authentication required' };
                    return;
                }
                ctx.set('Content-Type', 'text/event-stream');
                ctx.set('Cache-Control', 'no-cache');
                ctx.set('Connection', 'keep-alive');
                ctx.set('Access-Control-Allow-Origin', '*');
                ctx.status = 200;
                ctx.res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                });
                const unsub = edgeRegistry.onEnvelope((record, envelope) => {
                    if (envelope.protocol !== 'mqtt' || envelope.action !== 'publish') return;
                    const match = String(envelope.channel || '').match(/^node\/[^/]+\/devices\/([^/]+)\/state$/);
                    if (!match) return;
                    try { ctx.res.write(`data: ${JSON.stringify({ type: 'device_state', topic: envelope.channel, payload: envelope.payload || '' })}\n\n`); } catch {}
                });
                ctx.req.on('close', () => { try { unsub(); } catch {} });
            });
        }
    });
}
