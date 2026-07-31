// @ts-nocheck
import { Service } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config, isEdgeMode } from '../config';
import { edgeRegistry } from '../edge/registry';
import { EdgeEnvelope, endpointWithToken, maskEndpoint, prepareEnvelope } from '../edge/protocol';

const logger = new Logger('edge');

export default class EdgeService extends Service<any> {
    private ws: any;

    constructor(ctx: any) {
        super(ctx, 'edge');
    }
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private retryDelay = 3000;
    private unsubscribe?: () => void;

    async [Service.init]() {
        if (!isEdgeMode) return;
        edgeRegistry.init();
        (global as any).__edge_upstream = this;
        this.unsubscribe = edgeRegistry.onEnvelope((node, envelope) => this.handleNodeEnvelope(node, envelope));
        this.bindLocalBroker();
        if ((config as any).upstream?.enabled && (config as any).upstream?.endpoint) this.connect();
    }

    private endpoint() {
        const upstream = (config as any).upstream || {};
        return endpointWithToken(String(upstream.endpoint || ''), String(upstream.token || ''));
    }

    status() {
        return {
            enabled: Boolean((config as any).upstream?.enabled),
            configured: Boolean((config as any).upstream?.endpoint),
            connected: Boolean(this.ws && this.ws.readyState === 1),
            endpoint: maskEndpoint(String((config as any).upstream?.endpoint || '')),
        };
    }

    private sendUpstream(payload: any) {
        if (!this.ws || this.ws.readyState !== 1) return false;
        try {
            this.ws.send(JSON.stringify(payload));
            return true;
        } catch {
            return false;
        }
    }

    private publishLocal(envelope: EdgeEnvelope) {
        if (envelope.protocol !== 'mqtt' || envelope.action !== 'publish' || !envelope.channel) return;
        const aedes = (global as any).__ejunz_aedes;
        if (!aedes?.publish) return;
        const payload = Buffer.from(typeof envelope.payload === 'string' ? envelope.payload : JSON.stringify(envelope.payload ?? {}));
        try {
            aedes.publish({ topic: envelope.channel, payload, qos: envelope.qos || 0, retain: false }, null);
        } catch (e) {
            logger.warn('Failed to publish node state to edge broker: %s', (e as Error).message);
        }
    }

    private handleNodeEnvelope(node: any, envelope: EdgeEnvelope) {
        const prepared = prepareEnvelope(envelope, 'outbound', node.nodeId);
        this.publishLocal(prepared);
        this.sendUpstream(prepared);
    }

    private bindLocalBroker() {
        const aedes = (global as any).__ejunz_aedes;
        if (!aedes?.on) return;
        aedes.on('publish', (packet: any, client: any) => {
            if (!client || !packet?.topic || packet.topic.startsWith('$SYS/')) return;
            const channel = String(packet.topic);
            let payload: any = packet.payload?.toString?.() || '';
            try { payload = JSON.parse(payload); } catch {}
            const nodeMatch = channel.match(/^node\/([^/]+)\//);
            if (!nodeMatch) return;
            const envelope = prepareEnvelope({
                protocol: 'mqtt',
                action: 'publish',
                channel,
                payload,
            }, 'outbound', nodeMatch[1]);
            const nodeId = nodeMatch[1];
            if (channel.endsWith('/set')) edgeRegistry.send(nodeId, { ...envelope, direction: 'inbound' });
            this.sendUpstream(envelope);
        });
    }

    private routeUpstreamEnvelope(envelope: EdgeEnvelope) {
        const nodeId = String(envelope.nodeId || '') || this.nodeFromChannel(envelope.channel || '') || this.nodeFromTool(envelope);
        if (nodeId) {
            edgeRegistry.send(nodeId, { ...envelope, direction: 'inbound', nodeId });
            return;
        }
        logger.warn('Dropping upstream envelope without a target node: %o', envelope);
    }

    private nodeFromChannel(channel: string) {
        return channel.match(/^node\/([^/]+)\//)?.[1] || '';
    }

    private nodeFromTool(envelope: EdgeEnvelope) {
        const name = envelope.payload?.params?.name;
        if (!name) return '';
        return edgeRegistry.list().find((node: any) => node.tools?.some((tool: any) => tool.name === name))?.nodeId || '';
    }

    private async handleMessage(data: any) {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return; }
        if (parsed?.type === 'edge/auth_required' || parsed?.type === 'edge/auth_success' || parsed?.type === 'edge/auth_expired') return;
        const envelope = parsed?.protocol
            ? parsed
            : parsed?.jsonrpc
                ? { protocol: 'mcp', action: 'jsonrpc', payload: parsed }
                : null;
        if (envelope) this.routeUpstreamEnvelope(envelope);
    }

    private scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 1.5, 30000);
    }

    private connect() {
        if (this.stopped || this.ws) return;
        const endpoint = this.endpoint();
        if (!endpoint) return;
        let WS: any;
        try { WS = require('ws'); } catch (e) { logger.error('Missing ws dependency: %s', (e as Error).message); return; }
        logger.info('Connecting Edge upstream: %s', maskEndpoint(endpoint));
        try { this.ws = new WS(endpoint, { perMessageDeflate: false, handshakeTimeout: 20000 }); } catch (e) {
            logger.warn('Failed to create upstream connection: %s', (e as Error).message);
            this.scheduleReconnect();
            return;
        }
        this.ws.on('open', () => {
            this.retryDelay = 3000;
            logger.success('Edge upstream connected');
            this.sendUpstream({ jsonrpc: '2.0', method: 'notifications/initialized' });
            this.heartbeatTimer = setInterval(() => {
                try { this.ws?.ping?.(); } catch {}
            }, 30000);
        });
        this.ws.on('message', (data: any) => this.handleMessage(data));
        this.ws.on('close', () => {
            this.ws = undefined;
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            this.scheduleReconnect();
        });
        this.ws.on('error', (error: Error) => logger.warn('Edge upstream error: %s', error.message));
    }

    async restart() {
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = undefined;
        }
        if ((config as any).upstream?.enabled) this.connect();
    }

    async [Service.dispose]() {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.unsubscribe?.();
        try { this.ws?.close(); } catch {}
        this.ws = undefined;
        if ((global as any).__edge_upstream === this) (global as any).__edge_upstream = undefined;
    }
}
