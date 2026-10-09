// @ts-nocheck
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { fs, Logger, randomstring } from '../utils';
import { isEdgeMode } from '../config';
import { edgeRegistry } from '../model/edge-registry';
import { callNodeMcp } from '../tools/edge-device-control';
import { getActiveAgentModel } from './edge-llm-config';
import { isEdgeAdminAuthorized, requireEdgeAdmin } from './edge-auth';

const logger = new Logger('handler/edge-agent');
const storePath = path.resolve(process.cwd(), 'data/edge-agent-sessions.json');
const maxStoredSessions = 100;
const maxStoredEvents = 500;
const maxToolResultChars = 12000;
const modelTimeoutMs = 120000;

const tools = [
    {
        type: 'function',
        function: {
            name: 'edge_status',
            description: '读取 Edge 服务、上游连接和节点数量状态。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edge_list_nodes',
            description: '列出 Edge 上已授权的节点及其在线状态。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'zigbee_list_devices',
            description: '通过指定在线节点读取 Zigbee 设备列表。此工具只读。',
            parameters: {
                type: 'object',
                properties: { nodeId: { type: 'string', description: 'Edge 节点 ID' } },
                required: ['nodeId'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'zigbee_get_device_status',
            description: '读取指定节点上某个 Zigbee 设备的状态。此工具只读。',
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'Edge 节点 ID' },
                    deviceId: { type: 'string', description: 'Zigbee 设备 ID' },
                },
                required: ['nodeId', 'deviceId'],
                additionalProperties: false,
            },
        },
    },
];

function readStore() {
    if (!fs.existsSync(storePath)) return { sessions: [] };
    try {
        const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        if (!data || !Array.isArray(data.sessions)) throw new Error('sessions must be an array');
        return data;
    } catch (error) {
        logger.error('Unable to read Edge Agent sessions: %s', (error as Error).message);
        throw new Error('Agent 会话数据损坏，暂时无法启动');
    }
}

function writeStore(store: any) {
    fs.ensureDirSync(path.dirname(storePath));
    const tempPath = `${storePath}.${process.pid}.${randomstring(6)}.tmp`;
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
        fs.chmodSync(tempPath, 0o600);
        fs.renameSync(tempPath, storePath);
        fs.chmodSync(storePath, 0o600);
    } finally {
        if (fs.existsSync(tempPath)) fs.removeSync(tempPath);
    }
}

function textContent(content: any) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('\n').trim();
}

function stringifyResult(value: unknown) {
    let text: string;
    try { text = JSON.stringify(value); } catch { text = String(value); }
    return text.length > maxToolResultChars ? `${text.slice(0, maxToolResultChars)}…（结果已截断）` : text;
}

function extractApiError(value: any, fallback: string) {
    const error = value?.error;
    if (typeof error === 'string') return error;
    if (typeof error?.message === 'string') return error.message;
    return fallback;
}

export class EdgeAgentRuntime {
    private store: any;
    private subscribers = new Set<(event: any) => void>();
    private running = new Set<string>();

    constructor() {
        this.store = readStore();
        for (const session of this.store.sessions) session.running = false;
    }

    status() {
        try {
            const model = getActiveAgentModel();
            return {
                state: model ? 'ready' : 'waiting',
                provider: model?.providerName,
                model: model?.modelId,
                message: model ? undefined : '请先在模型配置中启用 Provider 和模型，并配置 API Key。',
            };
        } catch (error) {
            return { state: 'waiting', message: (error as Error).message };
        }
    }

    subscribe(listener: (event: any) => void) {
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }

    private persist() {
        this.store.sessions = this.store.sessions
            .sort((a: any, b: any) => b.updatedAt - a.updatedAt)
            .slice(0, maxStoredSessions);
        writeStore(this.store);
    }

    private event(session: any, type: string, data: any = {}) {
        const event = { type, data, timestamp: Date.now() };
        const seq = (session.events.at(-1)?.seq || 0) + 1;
        session.events.push({ seq, event });
        if (session.events.length > maxStoredEvents) session.events.splice(0, session.events.length - maxStoredEvents);
        session.updatedAt = Date.now();
        this.persist();
        const message = { type: 'session/event', sessionId: session.sessionId, event };
        for (const subscriber of this.subscribers) {
            try { subscriber(message); } catch {}
        }
    }

    private session(sessionId: unknown) {
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId 不能为空');
        const session = this.store.sessions.find((item: any) => item.sessionId === sessionId);
        if (!session) throw new Error('对话不存在');
        return session;
    }

    private async runTool(name: string, args: any) {
        if (name === 'edge_status') {
            const upstream = (global as any).__edge_upstream;
            const nodes = edgeRegistry.list();
            return {
                mode: 'edge',
                broker: Boolean((global as any).__ejunz_aedes),
                upstream: upstream?.status?.() || { enabled: false, connected: false },
                nodeCount: nodes.length,
                onlineNodes: nodes.filter((node: any) => node.connected || node.status === 'online').length,
            };
        }
        if (name === 'edge_list_nodes') {
            return edgeRegistry.list().map((node: any) => ({
                nodeId: node.nodeId,
                status: node.status,
                connected: Boolean(node.connected),
                host: node.host,
                lastSeen: node.lastSeen,
                tools: (node.tools || []).map((tool: any) => tool.name).filter(Boolean),
            }));
        }
        if (name === 'zigbee_list_devices' || name === 'zigbee_get_device_status') {
            const nodeId = String(args?.nodeId || '');
            const node = edgeRegistry.get(nodeId);
            if (!node) throw new Error('Edge 节点不存在');
            if (!node.connection) throw new Error(`节点 ${nodeId} 当前未连接`);
            if (name === 'zigbee_list_devices') return callNodeMcp(nodeId, 'zigbee_list_devices');
            const deviceId = String(args?.deviceId || '');
            if (!deviceId) throw new Error('deviceId 不能为空');
            return callNodeMcp(nodeId, 'zigbee_get_device_status', { deviceId });
        }
        throw new Error(`不支持的只读工具：${name}`);
    }

    private async complete(session: any) {
        const model = getActiveAgentModel();
        if (!model) throw new Error('没有启用的模型，请先检查模型配置和 API Key。');
        if (model.api !== 'openai-completions') throw new Error(`暂不支持 Provider API：${model.api}`);

        const systemMessage = {
            role: 'system',
            content: [
                '你是 Ejunz Edge Agent，负责解释边缘节点、上游连接和 Zigbee 设备状态。默认使用中文回答。',
                '需要实时信息时使用提供的只读工具，不要臆测在线状态。工具只允许读取，不允许控制设备、修改配置或执行其他有副作用的操作。',
                '如果用户要求控制设备，说明当前 Agent 只支持查询，并引导用户使用现有设备控制界面。',
            ].join('\n'),
        };
        const messages = [systemMessage, ...session.messages];
        for (let round = 0; round < 5; round += 1) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), modelTimeoutMs);
            let response: Response;
            let payload: any;
            try {
                response = await fetch(`${model.baseURL.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
                    },
                    body: JSON.stringify({
                        model: model.modelId,
                        messages,
                        tools,
                        tool_choice: 'auto',
                        temperature: 0.2,
                        max_tokens: 2048,
                    }),
                    signal: controller.signal,
                });
                payload = await response.json().catch(() => ({}));
            } finally {
                clearTimeout(timeout);
            }
            if (!response.ok) throw new Error(extractApiError(payload, `模型请求失败（HTTP ${response.status}）`));
            const message = payload?.choices?.[0]?.message;
            if (!message) throw new Error('模型响应中没有 assistant message');

            if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
                messages.push(message);
                session.messages.push(message);
                this.persist();
                for (const call of message.tool_calls) {
                    const name = String(call?.function?.name || '');
                    let args: any = {};
                    try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { throw new Error(`模型返回了无效的工具参数：${name}`); }
                    this.event(session, 'tool/call', { name, arguments: args });
                    let result: any;
                    try { result = await this.runTool(name, args); }
                    catch (error) { result = { error: (error as Error).message }; }
                    const resultText = stringifyResult(result);
                    this.event(session, 'tool/result', { name, message: { content: [{ type: 'text', text: resultText }] } });
                    const toolMessage = { role: 'tool', tool_call_id: call.id, content: resultText };
                    messages.push(toolMessage);
                    session.messages.push(toolMessage);
                }
                this.persist();
                continue;
            }

            const answer = textContent(message.content);
            if (!answer) throw new Error('模型返回了空回复');
            const assistantMessage = { role: 'assistant', content: answer };
            session.messages.push(assistantMessage);
            this.event(session, 'assistant/message', {
                message: { content: [{ type: 'text', text: answer }] },
            });
            return;
        }
        throw new Error('Agent 工具调用次数超出限制');
    }

    private async processPrompt(session: any) {
        try {
            await this.complete(session);
        } catch (error) {
            const message = error instanceof Error && error.name === 'AbortError'
                ? '模型请求超时，请稍后重试。'
                : `Agent 请求失败：${(error as Error).message}`;
            logger.warn('Agent turn failed for %s: %s', session.sessionId, message);
            session.messages.push({ role: 'assistant', content: message });
            this.event(session, 'assistant/message', { message: { content: [{ type: 'text', text: message }] } });
        } finally {
            session.running = false;
            this.running.delete(session.sessionId);
            this.event(session, 'turn/end', { reason: 'completed' });
        }
    }

    async rpc(method: string, payload: any = {}) {
        if (method === 'session.list') {
            return { items: this.store.sessions.map(({ sessionId, updatedAt, running }: any) => ({ sessionId, updatedAt, running: Boolean(running) })) };
        }
        if (method === 'session.create') {
            const now = Date.now();
            const session = { sessionId: randomUUID(), createdAt: now, updatedAt: now, running: false, messages: [], events: [] };
            this.store.sessions.unshift(session);
            this.persist();
            return { sessionId: session.sessionId };
        }
        if (method === 'session.history') {
            const session = this.session(payload.sessionId);
            const requested = Number(payload.maxMessages) || 100;
            const limit = Math.max(1, Math.min(500, requested));
            return { events: session.events.slice(-limit) };
        }
        if (method === 'session.prompt') {
            const session = this.session(payload.sessionId);
            const text = textContent(payload.content);
            if (!text) throw new Error('消息内容不能为空');
            if (text.length > 16000) throw new Error('消息长度不能超过 16000 个字符');
            if (session.running || this.running.has(session.sessionId)) throw new Error('该对话正在处理中');
            if (!getActiveAgentModel()) throw new Error('没有启用的模型，请先检查模型配置和 API Key。');
            session.running = true;
            this.running.add(session.sessionId);
            const content = [{ type: 'text', text }];
            session.messages.push({ role: 'user', content: text });
            this.event(session, 'user/message', { content });
            void this.processPrompt(session);
            return { accepted: true };
        }
        throw new Error(`不支持的 Agent RPC 方法：${method}`);
    }
}

let runtime: EdgeAgentRuntime | undefined;

class EdgeAgentStatusHandler extends Handler<Context> {
    async get() {
        if (!requireEdgeAdmin(this)) return;
        this.response.body = runtime?.status() || { state: 'starting' };
    }
}

class EdgeAgentRpcHandler extends Handler<Context> {
    async post() {
        if (!requireEdgeAdmin(this)) return;
        const body = this.request.body || {};
        try {
            const result = await runtime!.rpc(String(body.method || ''), body.payload || {});
            this.response.body = { result: { ok: true, value: result } };
        } catch (error) {
            this.response.status = 400;
            this.response.body = { error: { message: (error as Error).message } };
        }
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    try {
        runtime = new EdgeAgentRuntime();
    } catch (error) {
        logger.error('Failed to initialize Agent runtime: %s', (error as Error).message);
    }
    ctx.Route('edge-agent-status', '/api/agent/status', EdgeAgentStatusHandler);
    ctx.Route('edge-agent-rpc', '/api/agent/rpc', EdgeAgentRpcHandler);
    ctx.inject(['server'], ({ server }: any) => {
        server.router.get('/api/agent/events', (context: any) => {
            if (!isEdgeAdminAuthorized(context.request)) {
                context.status = 401;
                context.set('WWW-Authenticate', 'Basic realm="Ejunz Edge"');
                context.body = { error: { message: 'edge admin authentication required' } };
                return;
            }
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
            const unsubscribe = runtime?.subscribe((event) => {
                try { context.res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
            });
            const heartbeat = setInterval(() => {
                try { context.res.write(': keep-alive\n\n'); } catch {}
            }, 20000);
            context.res.on('close', () => {
                clearInterval(heartbeat);
                unsubscribe?.();
            });
        });
    });
}
