// @ts-nocheck
import { ConnectionHandler } from '@ejunz/framework';
import { Context } from 'cordis';
import { config, isEdgeMode } from '../config';
import { Logger } from '../utils';
import { edgeRegistry } from '../model/edge-registry';
import { EdgeEnvelope, prepareEnvelope } from '@ejunz/protocol';

const logger = new Logger('edge-node');

function getNodeId(message: any) {
    return String(message?.nodeId || message?.meta?.nodeId || '');
}

function getMetadata(message: any) {
    return {
        host: String(message?.host || 'unknown'),
        port: Number(message?.port || 0),
    };
}

export class EdgeNodeConnectionHandler extends ConnectionHandler<Context> {
    private nodeId = '';
    private authenticated = false;

    private queryToken() {
        return String((this.request as any)?.query?.token || '');
    }

    private sendRaw(payload: any) {
        try { this.send(payload); } catch (e) { logger.debug('send failed: %s', (e as Error).message); }
    }

    sendEnvelope(envelope: EdgeEnvelope) {
        this.sendRaw(prepareEnvelope(envelope, 'outbound', this.nodeId));
    }

    private authUrl(record: any) {
        const host = String((this.request as any)?.headers?.host || 'localhost');
        const protocol = String((this.request as any)?.headers?.['x-forwarded-proto'] || 'http');
        return `${protocol}://${host}/#/authorize/${encodeURIComponent(record.nodeId)}?requestId=${encodeURIComponent(record.requestId || '')}`;
    }

    private requestAuthorization(nodeId: string, metadata: any) {
        const record = edgeRegistry.requestAuthorization(nodeId, metadata, this);
        this.nodeId = record.nodeId;
        this.sendRaw({
            type: 'edge/auth_required',
            nodeId: record.nodeId,
            requestId: record.requestId,
            authUrl: this.authUrl(record),
            expiresAt: record.requestExpiresAt,
            edgeType: 'node',
        });
        logger.warn('Node %s is pending authorization: %s', record.nodeId, this.authUrl(record));
    }

    authorize() {
        if (!this.nodeId) throw new Error('Node has not sent an identity handshake');
        const { record, token } = edgeRegistry.authorize(this.nodeId);
        this.sendRaw({
            type: 'edge/auth_success',
            nodeId: record.nodeId,
            token,
            // Node persists the token separately, so the endpoint itself remains stable.
            wsEndpoint: String((this.request as any)?.headers?.['x-edge-ws-endpoint'] || ''),
        });
        setTimeout(() => {
            try { this.close(4001, 'authorized; reconnect with token'); } catch {}
        }, 100);
        return { nodeId: record.nodeId };
    }

    private ensureAuthenticated(message: any) {
        if (this.authenticated) return true;
        const token = this.queryToken();
        if (token) {
            const record = edgeRegistry.authenticate(token);
            if (!record) {
                this.sendRaw({ type: 'edge/auth_revoked', reason: 'invalid token' });
                try { this.close(4003, 'invalid token'); } catch {}
                return false;
            }
            this.nodeId = record.nodeId;
            this.authenticated = true;
            edgeRegistry.attach(this.nodeId, this, getMetadata(message));
            logger.info('Node %s authenticated with token', this.nodeId);
            return true;
        }

        const nodeId = getNodeId(message);
        if (!nodeId) {
            this.sendRaw({ type: 'edge/auth_error', message: 'nodeId is required in the first handshake' });
            return false;
        }
        this.nodeId = nodeId;
        const existing = edgeRegistry.get(nodeId);
        if (existing?.status === 'revoked') {
            this.sendRaw({ type: 'edge/auth_revoked', nodeId, reason: 'node authorization revoked' });
            try { this.close(4003, 'authorization revoked'); } catch {}
            return false;
        }
        if (!existing?.requestId || (existing.requestExpiresAt || 0) < Date.now() || existing.connection !== this) {
            this.requestAuthorization(nodeId, getMetadata(message));
        }
        return false;
    }

    async message(message: any) {
        try {
            if (!message || typeof message !== 'object') return;
            if (!this.ensureAuthenticated(message)) return;

            if (message.type === 'init') return;
            if (!message.protocol) return;
            const prepared = prepareEnvelope(message, 'inbound', this.nodeId);
            edgeRegistry.receive(this.nodeId, prepared);
        } catch (e) {
            logger.error('Failed to process node %s message: %s', this.nodeId || '?', (e as Error).message);
        }
    }

    async cleanup() {
        if (this.nodeId) edgeRegistry.detach(this.nodeId, this);
        logger.info('Node disconnected: %s', this.nodeId || 'unknown');
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    ctx.Connection('edge-node-connection', (config as any).nodePath || '/node/conn', EdgeNodeConnectionHandler);
}
