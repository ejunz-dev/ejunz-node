import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { listNodeTools } from '../mcp-tools/node';
import { callNodeTool } from '../mcp-tools/node';
import { config } from '../config';
import { Logger } from '../utils';

const logger = new Logger('handler/node-mcp-provider');

// HTTP MCP API Handler
class NodeMCPApiHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const tools = listNodeTools(true);
            const payload = {
                jsonrpc: '2.0',
                result: {
                    server: 'Node MCP Provider Server',
                    version: '1.0.0',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                    tools: tools.map((t: any) => t.name),
                },
                id: null,
            };
            this.response.type = 'application/json';
            this.response.body = payload;
        } catch (e) {
            this.response.type = 'application/json';
            this.response.body = { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null };
        }
    }

    async post(params) {
        const request = this.request.body;
        const id = request?.id ?? null;
        const method = request?.method;

        logger.info('[node-mcp/api] incoming', {
            method: this.request.method,
            path: this.request.path,
            body: request,
        } as any);

        const reply = (data: any) => ({ jsonrpc: '2.0', id, ...data });

        if (method === 'initialize') {
            this.response.type = 'application/json';
            this.response.body = reply({
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {}, resources: {} },
                    serverInfo: { name: 'node-mcp-provider-server', version: '1.0.0' },
                },
            });
            return;
        }

        try {
            if (method === 'tools/list') {
                const tools = listNodeTools(true);
                this.response.type = 'application/json';
                this.response.body = reply({ result: { tools } });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                const result = await callNodeTool(this.ctx, { name, arguments: args });
                
                
                this.response.type = 'application/json';
                this.response.body = reply({ result });
                return;
            }
        } catch (e) {
            logger.error('[node-mcp/api] error', e);
            this.response.type = 'application/json';
            this.response.body = reply({ error: { code: -32603, message: (e as Error).message } });
            return;
        }

        this.response.type = 'application/json';
        this.response.body = reply({ error: { code: -32601, message: 'Method not found' } });
    }
}

// WebSocket MCP Handler (作为服务器端)
export class NodeMCPWebSocketHandler extends ConnectionHandler<Context> {
    async open() {
        logger.info('[node-mcp/ws] connection opened');
    }

    async message(data: any) {
        try {
            const request = typeof data === 'string' ? JSON.parse(data) : data;
            const id = request?.id ?? null;
            const method = request?.method;

            logger.info('[node-mcp/ws] incoming', { method, id });

            const reply = (data: any) => ({ jsonrpc: '2.0', id, ...data });

            if (method === 'initialize') {
                this.send(reply({
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {}, resources: {} },
                        serverInfo: { name: 'node-mcp-provider-server', version: '1.0.0' },
                    },
                }));
                return;
            }

            if (method === 'tools/list') {
                const tools = listNodeTools(true);
                this.send(reply({ result: { tools } }));
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                try {
                    const result = await callNodeTool(this.ctx, { name, arguments: args });
                    
                    
                    this.send(reply({ result }));
                } catch (e) {
                    logger.error('[node-mcp/ws] tool call error', e);
                    this.send(reply({ error: { code: -32603, message: (e as Error).message } }));
                }
                return;
            }

            this.send(reply({ error: { code: -32601, message: 'Method not found' } }));
        } catch (e) {
            logger.error('[node-mcp/ws] error', e);
            this.send({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
            });
        }
    }

    async close() {
        logger.info('[node-mcp/ws] connection closed');
    }
}

// HTTP/SSE API Handler (for external access)
class NodeMCPExternalApiHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const tools = listNodeTools(true);
            const payload = {
                jsonrpc: '2.0',
                result: {
                    server: 'Node MCP Provider Server',
                    version: '1.0.0',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                    tools: tools.map((t: any) => t.name),
                    endpoints: {
                        http: '/api',
                        websocket: config.ws?.enabled !== false ? (config.ws?.localEndpoint || '/mcp/ws') : null,
                    },
                },
                id: null,
            };
            this.response.type = 'application/json';
            this.response.body = payload;
        } catch (e) {
            this.response.type = 'application/json';
            this.response.body = { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null };
        }
    }

    async post(params) {
        const request = this.request.body;
        const id = request?.id ?? null;
        const method = request?.method;

        logger.info('[node-mcp-external-api] incoming', {
            method: this.request.method,
            path: this.request.path,
            body: request,
        } as any);

        const reply = (data: any) => ({ jsonrpc: '2.0', id, ...data });

        if (method === 'initialize') {
            this.response.type = 'application/json';
            this.response.body = reply({
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {}, resources: {} },
                    serverInfo: { name: 'node-mcp-provider-server', version: '1.0.0' },
                },
            });
            return;
        }

        try {
            if (method === 'tools/list') {
                const tools = listNodeTools(true);
                this.response.type = 'application/json';
                this.response.body = reply({ result: { tools } });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                const result = await callNodeTool(this.ctx, { name, arguments: args });
                
                
                this.response.type = 'application/json';
                this.response.body = reply({ result });
                return;
            }
        } catch (e) {
            logger.error('[node-mcp-external-api] error', e);
            this.response.type = 'application/json';
            this.response.body = reply({ error: { code: -32603, message: (e as Error).message } });
            return;
        }

        this.response.type = 'application/json';
        this.response.body = reply({ error: { code: -32601, message: 'Method not found' } });
    }
}

export async function apply(ctx: Context) {
    // HTTP MCP API (internal)
    ctx.Route('node_mcp_api', '/mcp/api', NodeMCPApiHandler);
    
    // HTTP/SSE API (external)
    ctx.Route('node_mcp_external_api', '/api', NodeMCPExternalApiHandler);
    
    // WebSocket MCP Handler（作为服务器端，如果启用）
    const wsConfig = (config as any).ws || {};
    if (wsConfig.enabled !== false) {
        const localEndpoint = wsConfig.localEndpoint || '/mcp/ws';
        ctx.Connection('node_mcp_ws', localEndpoint, NodeMCPWebSocketHandler);
        logger.info(`Node MCP WebSocket endpoint (server): ${localEndpoint}`);
    }

}

