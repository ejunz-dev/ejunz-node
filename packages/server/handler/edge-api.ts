// @ts-nocheck
import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { config, isEdgeMode, saveConfig } from '../config';
import { edgeRegistry } from '../edge/registry';
import { maskEndpoint } from '../edge/protocol';

function requireAdmin(handler: any) {
    const request = handler.request;
    const response = handler.response;
    const expected = String((config as any).viewPass || '');
    const authorization = request.headers?.authorization || '';
    let valid = false;
    if (authorization.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(authorization.slice(6), 'base64').toString();
            const [, password] = decoded.split(':');
            valid = decoded.startsWith('admin:') && password === expected;
        } catch {}
    }
    if (!valid && request.query?.token) valid = String(request.query.token) === expected;
    if (valid) return true;
    response.status = 401;
    response.addHeader('WWW-Authenticate', 'Basic realm="Ejunz Edge"');
    response.body = { error: 'edge admin authentication required' };
    return false;
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

class EdgeAuthorizeHandler extends Handler<Context> {
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
    async post() {
        if (!requireAdmin(this)) return;
        await (global as any).__edge_upstream?.restart?.();
        this.response.body = { ok: 1 };
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    ctx.Route('edge-status', '/api/edge/status', EdgeStatusHandler);
    ctx.Route('edge-nodes', '/api/edge/nodes', EdgeNodesHandler);
    ctx.Route('edge-authorize', '/api/edge/nodes/:nodeId/authorize', EdgeAuthorizeHandler);
    ctx.Route('edge-revoke', '/api/edge/nodes/:nodeId/revoke', EdgeRevokeHandler);
    ctx.Route('edge-upstream', '/api/edge/upstream', EdgeUpstreamHandler);
    ctx.Route('edge-upstream-restart', '/api/edge/upstream/restart', EdgeUpstreamRestartHandler);
}
