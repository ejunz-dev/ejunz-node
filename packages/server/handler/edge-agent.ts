// @ts-nocheck
import { timingSafeEqual } from 'node:crypto';
import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { Logger } from '../utils';
import { isEdgeMode } from '../config';
import { isEdgeAdminAuthorized, requireEdgeAdmin } from './edge-auth';

const logger = new Logger('handler/edge-agent');
const REQUEST_TIMEOUT_MS = 120_000;

let agentService: any;
let edgeServer: any;
let edgeContext: Context;

type RuntimeStatus = {
    state: 'ready' | 'waiting' | 'starting' | 'error';
    provider?: string;
    model?: string;
    message?: string;
};

async function callRuntime(path: string, body: unknown, signal?: AbortSignal) {
    if (!agentService) throw new Error('Agent service is not ready');
    return agentService.call(path, body, signal);
}

function isHostToolBridgeAuthorized(request: any) {
    const expected = String(agentService?.getHostToolToken?.() || '');
    const provided = String(request?.headers?.['x-ejunz-agent-token'] || '');
    if (!expected || !provided) return false;
    const expectedBytes = Buffer.from(expected);
    const providedBytes = Buffer.from(provided);
    return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function hostToolError(handler: any, status: number, message: string) {
    handler.response.status = status;
    handler.response.body = { ok: false, error: { message } };
}

function hostToolInputSchema(schema: any) {
    const serialized = schema.toJSON();
    const refs = serialized.refs as Record<string, any>;
    const root = refs[String(serialized.uid)];
    if (root?.type !== 'object') throw new Error('Edge host tools must use object schemas');

    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [name, id] of Object.entries(root.dict || {})) {
        const property = refs[String(id)];
        if (property?.type === 'string') {
            properties[name] = { type: 'string' };
        } else if (property?.type === 'union') {
            const values = (property.list || []).map((valueId: number) => {
                const value = refs[String(valueId)];
                if (value?.type !== 'const') throw new Error(`Unsupported Edge tool schema for ${name}`);
                return value.value;
            });
            properties[name] = { type: 'string', enum: values };
        } else {
            throw new Error(`Unsupported Edge tool schema for ${name}`);
        }
        if (property.meta?.description) properties[name].description = property.meta.description;
        if (property.meta?.required) required.push(name);
    }

    return {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
    };
}

function unwrapValue(payload: any) {
    if (payload?.result?.ok === false) {
        throw new Error(payload.result.error?.message || 'Agent request failed');
    }
    if (payload?.result?.ok === true) return payload.result.value;
    if (payload?.error?.message) throw new Error(payload.error.message);
    return payload?.result?.value ?? payload?.value ?? payload;
}

async function resolveStatus(): Promise<RuntimeStatus> {
    const starting = agentService?.getStarting();
    const runtime = agentService?.getRuntime();
    const bootError = agentService?.getBootError();
    if (starting) return { state: 'starting', message: 'Agent runtime is starting' };
    if (!runtime) {
        return {
            state: bootError ? 'error' : 'waiting',
            message: bootError || 'Agent runtime is not ready',
        };
    }
    try {
        const selectedModel = await agentService.getActiveLlmModel();
        if (!selectedModel) return { state: 'waiting', message: 'No enabled provider and model are configured' };
        if (!selectedModel.credentialReadable) {
            return { state: 'waiting', provider: selectedModel.provider, model: selectedModel.model, message: 'The stored API key cannot be decrypted; restore the original credential encryption key' };
        }
        if (!selectedModel.credentialConfigured) {
            return { state: 'waiting', provider: selectedModel.provider, model: selectedModel.model, message: 'Configure an API key for the active provider' };
        }
        const created = unwrapValue(await callRuntime('/api/session.create', agentService.createEnvelope('session.create', {
            provider: selectedModel.provider,
            model: selectedModel.model,
        })));
        const sessionId = created?.sessionId;
        if (!sessionId) return { state: 'ready' };
        try {
            const models = unwrapValue(await callRuntime('/api/session.models', agentService.createEnvelope('session.models', { sessionId })));
            if (!models?.routable) {
                return {
                    state: 'error',
                    provider: models?.current?.provider,
                    model: models?.current?.model,
                    message: 'The configured model is not registered in the Agent runtime',
                };
            }
            return {
                state: 'ready',
                provider: models?.current?.provider,
                model: models?.current?.model,
            };
        } catch (error) {
            return { state: 'ready', message: (error as Error).message };
        }
    } catch (error) {
        return { state: 'waiting', message: (error as Error).message };
    }
}

function mapListItems(value: any) {
    const items = Array.isArray(value?.items) ? value.items : [];
    return {
        items: items.map((item: any) => ({
            sessionId: String(item.sessionId || item.id || ''),
            updatedAt: Number(item.updatedAt || item.lastPromptAt || Date.now()),
            running: Boolean(item.running),
        })).filter((item: any) => item.sessionId),
    };
}

function mapHistory(value: any) {
    const events = Array.isArray(value?.events) ? value.events : [];
    return {
        events: events.map((entry: any, index: number) => {
            const event = entry?.event || entry;
            const seq = Number(event?.seq ?? entry?.seq ?? index + 1);
            return {
                seq,
                event: {
                    type: String(event?.type || 'unknown'),
                    data: event?.data ?? {},
                    timestamp: Number(event?.time || event?.timestamp || Date.now()),
                },
            };
        }),
    };
}

async function rpc(method: string, payload: any = {}, signal?: AbortSignal) {
    const envelope = agentService.createEnvelope(method, payload);
    if (method === 'approval.respond') {
        const rpcId = String(payload.rpcId || '');
        const sessionId = String(payload.sessionId || '');
        const approvalId = String(payload.approvalId || '');
        const outcome = String(payload.outcome || '');
        if (!rpcId || !sessionId || !approvalId || !['allowed-once', 'rejected'].includes(outcome)) {
            throw new Error('Approval response is invalid');
        }
        const response = await callRuntime('/api/respond', {
            type: 'client-response',
            rpcId,
            result: { ok: true, value: { sessionId, approvalId, outcome } },
        }, signal);
        if (response?.accepted !== true) throw new Error('Approval request expired or was already answered');
        return response;
    }
    if (method === 'session.list') {
        return mapListItems(unwrapValue(await callRuntime('/api/session.list', envelope, signal)));
    }
    if (method === 'session.create') {
        const selectedModel = await agentService.getActiveLlmModel();
        const sessionPayload = {
            ...payload,
            ...(payload.provider && payload.model ? {} : selectedModel ? { provider: selectedModel.provider, model: selectedModel.model } : {}),
        };
        const value = unwrapValue(await callRuntime('/api/session.create', {
            ...envelope,
            payload: sessionPayload,
        }, signal));
        return { sessionId: String(value?.sessionId || '') };
    }
    if (method === 'session.delete') {
        const sessionId = String(payload.sessionId || '');
        if (!sessionId) throw new Error('Session ID is required');
        return unwrapValue(await callRuntime('/api/session.delete', {
            ...envelope,
            payload: { sessionId },
        }, signal));
    }
    if (method === 'session.history') {
        return mapHistory(unwrapValue(await callRuntime('/api/session.history', {
            ...envelope,
            payload: {
                sessionId: payload.sessionId,
                maxMessages: payload.maxMessages,
            },
        }, signal)));
    }
    if (method === 'session.prompt') {
        const content = Array.isArray(payload.content)
            ? payload.content
            : [{ type: 'text', text: String(payload.content || payload.text || '') }];
        const value = unwrapValue(await callRuntime('/api/session.prompt', {
            ...envelope,
            payload: {
                sessionId: payload.sessionId,
                mode: payload.mode === 'steer' ? 'steer' : 'queue',
                content,
                ...(typeof payload.clientTimeZone === 'string' ? { clientTimeZone: payload.clientTimeZone } : {}),
                ...(Array.isArray(payload.addonSnapshot) ? { addonSnapshot: payload.addonSnapshot } : {}),
            },
        }, signal));
        return value?.accepted === false ? value : { accepted: true, ...value };
    }
    return unwrapValue(await callRuntime(`/api/${method}`, envelope, signal));
}

async function bootRuntime() {
    if (!agentService) throw new Error('Agent service is not available');
    return agentService.boot();
}

class EdgeAgentStatusHandler extends Handler<Context> {
    async get() {
        if (!requireEdgeAdmin(this)) return;
        if (!agentService?.getRuntime() && !agentService?.getStarting() && !agentService?.getBootError()) void bootRuntime();
        this.response.body = await resolveStatus();
    }
}

class EdgeAgentRpcHandler extends Handler<Context> {
    async post() {
        if (!requireEdgeAdmin(this)) return;
        const body = this.request.body || {};
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            if (!agentService?.getRuntime()) await bootRuntime();
            const result = await rpc(String(body.method || ''), body.payload || {}, controller.signal);
            this.response.body = { result: { ok: true, value: result } };
        } catch (error) {
            const message = error instanceof Error && error.name === 'AbortError'
                ? 'Agent request timed out'
                : (error as Error).message;
            this.response.status = 400;
            this.response.body = { error: { message } };
        } finally {
            clearTimeout(timer);
        }
    }
}

class EdgeHostToolCatalogHandler extends Handler<Context> {
    async post() {
        if (!isHostToolBridgeAuthorized(this.request)) return hostToolError(this, 401, 'Agent host-tool bridge authentication required');
        const sessionId = String(this.request.body?.sessionId || '').trim();
        if (!sessionId) return hostToolError(this, 400, 'sessionId is required');
        const tools = edgeServer.listTools()
            .filter((tool: any) => tool.addonId === 'edge')
            .map((tool: any) => {
                const schema = tool.checkerArgs.find((argument: any) =>
                    typeof argument === 'function' && typeof argument.toJSON === 'function');
                if (!schema) throw new Error(`Tool ${tool.name} has no schema`);
                return {
                    name: tool.name,
                    description: schema.meta.description,
                    inputSchema: hostToolInputSchema(schema),
                };
            });
        this.response.body = {
            ok: true,
            value: {
                tools,
                guidance: 'Use edge_status, edge_list_nodes, and edge_list_devices for Edge and Zigbee status questions. Use zigbee_control_device only for a direct user request to change a device; the user must approve each control action.',
            },
        };
    }
}

class EdgeHostToolCallHandler extends Handler<Context> {
    async post() {
        if (!isHostToolBridgeAuthorized(this.request)) return hostToolError(this, 401, 'Agent host-tool bridge authentication required');
        const body = this.request.body || {};
        const name = String(body.name || '');
        if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) return hostToolError(this, 400, 'sessionId is required');
        const registration = edgeServer.listTools().find((tool: any) => tool.addonId === 'edge' && tool.name === name);
        if (!registration) return hostToolError(this, 404, 'Unknown Edge tool');
        if (!body.args || typeof body.args !== 'object' || Array.isArray(body.args)) return hostToolError(this, 400, 'Tool arguments must be an object');
        try {
            const value = await edgeServer.executeTool(name, edgeContext, body.args, this);
            this.response.body = { ok: true, value };
        } catch (error) {
            hostToolError(this, 400, (error as Error).message);
        }
    }
}

class EdgeAgentEventsHandler extends Handler<Context> {
    async get() {
        if (!requireEdgeAdmin(this)) return;
        const context = this.context as any;
        context.respond = false;
        context.status = 200;
        context.set('Content-Type', 'text/event-stream');
        context.set('Cache-Control', 'no-cache, no-transform');
        context.set('Connection', 'keep-alive');
        context.res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        });
        context.res.write('retry: 3000\n\n');
        const onEvent = (event: any) => {
            try { context.res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
        };
        const unsubscribe = agentService.subscribe(onEvent);
        const heartbeat = setInterval(() => {
            try { context.res.write(': keep-alive\n\n'); } catch { /* closed */ }
        }, 20000);
        context.res.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    ctx.inject(['agent', 'server'], ({ agent, server }: any) => {
        agentService = agent;
        edgeServer = server;
        edgeContext = ctx;
        void bootRuntime();
        ctx.Route('edge-agent-status', '/api/agent/status', EdgeAgentStatusHandler);
        ctx.Route('edge-agent-rpc', '/api/agent/rpc', EdgeAgentRpcHandler);
        ctx.Route('edge-agent-events', '/api/agent/events', EdgeAgentEventsHandler);
        ctx.Route('edge-agent-host-tools-catalog', '/api/ejunz-agent/data/tools/catalog', EdgeHostToolCatalogHandler);
        ctx.Route('edge-agent-host-tools-call', '/api/ejunz-agent/data/tools/call', EdgeHostToolCallHandler);
    });
}
