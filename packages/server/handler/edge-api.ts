// @ts-nocheck
import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { config, isEdgeMode, saveConfig } from '../config';
import { edgeRegistry } from '../edge/registry';
import { maskEndpoint } from '../edge/protocol';
import { getEdgeAuthConfig, requireEdgeAdmin as requireAdmin } from './edge-auth';

function allowCors(handler: any) {
    handler.response.addHeader('Access-Control-Allow-Origin', '*');
    handler.response.addHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    handler.response.addHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

class EdgeAuthConfigHandler extends Handler<Context> {
    async get() {
        if (!requireAdmin(this)) return;
        allowCors(this);
        const auth = getEdgeAuthConfig();
        this.response.body = {
            enabled: auth.enabled,
            username: auth.username,
            passwordConfigured: Boolean(auth.password),
        };
    }

    async post() {
        if (!requireAdmin(this)) return;
        allowCors(this);
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
        allowCors(this);
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
        allowCors(this);
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

async function callNodeMcp(nodeId: string, name: string, args: any = {}) {
    return edgeRegistry.request(nodeId, {
        protocol: 'mcp',
        action: 'jsonrpc',
        payload: {
            jsonrpc: '2.0',
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            method: 'tools/call',
            params: { name, arguments: args },
        },
    });
}

class EdgeNodeToolsHandler extends Handler<Context> {
    async get() {
        if (!requireAdmin(this)) return;
        allowCors(this);
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
        allowCors(this);
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
    async post() {
        if (!requireAdmin(this)) return;
        allowCors(this);
        const nodeId = String((this.request as any).params?.nodeId || '');
        if (!edgeRegistry.get(nodeId)) {
            this.response.status = 404;
            this.response.body = { error: 'node not found' };
            return;
        }
        const body = this.request.body || {};
        try {
            this.response.body = await callNodeMcp(nodeId, 'zigbee_control_device', {
                deviceId: String(body.deviceId || ''),
                state: String(body.state || '').toUpperCase(),
            });
        } catch (e) {
            this.response.status = 502;
            this.response.body = { error: (e as Error).message };
        }
    }
}

class EdgeAuthorizeHandler extends Handler<Context> {
    async post() {
        if (!requireAdmin(this)) return;
        allowCors(this);
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
    async post() {
        if (!requireAdmin(this)) return;
        allowCors(this);
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
    async get() {
        if (!requireAdmin(this)) return;
        allowCors(this);
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
        allowCors(this);
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
    async post() {
        if (!requireAdmin(this)) return;
        allowCors(this);
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

    // WebSocket endpoint for real-time device state updates (inject server to access router)
    ctx.inject(['server'], ({ server }) => {
        const wsLayer = server.router.ws('/api/edge/ws', (socket, req) => {
            // Authenticate: check Basic Auth header or token query param
            const authHeader = req.headers['authorization'] || '';
            const token = (new URL(req.url || '', `http://${req.headers.host}`).searchParams.get('token') || '');
            const auth = (config as any).auth || {};
            let authed = !auth.enabled;
            if (!authed && authHeader.startsWith('Basic ')) {
                const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
                const [uname, pass] = decoded.split(':');
                authed = uname === auth.username && pass === auth.password;
            }
            if (!authed && token && token === auth.password) authed = true;
            if (!authed) {
                socket.close(4001, 'auth required');
                return;
            }

            // Subscribe to device state changes via registry (node MQTT publishes)
            const unsub = edgeRegistry.onEnvelope((record, envelope) => {
                if (envelope.protocol !== 'mqtt' || envelope.action !== 'publish') return;
                const match = String(envelope.channel || '').match(/^node\/[^/]+\/devices\/([^/]+)\/state$/);
                if (!match) return;
                const msg = { type: 'device_state', topic: envelope.channel, payload: envelope.payload || '' };
                try { socket.send(JSON.stringify(msg)); } catch {}
            });
            socket.on('close', () => { try { unsub(); } catch {} });
        });
        if ((config as any).enableSSE !== false) {
            server.router.get('/api/edge/ws', (ctx) => {
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
