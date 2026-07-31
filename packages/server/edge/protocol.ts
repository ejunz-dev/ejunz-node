import crypto from 'node:crypto';

export type EdgeEnvelope = {
    protocol: string;
    action: string;
    channel?: string;
    payload?: any;
    nodeId?: string | number;
    domainId?: string;
    traceId?: string;
    token?: string;
    qos?: 0 | 1 | 2;
    direction?: 'inbound' | 'outbound';
    meta?: Record<string, any>;
};

export function generateTraceId(prefix = 'edge', nodeId = 'system') {
    return `${prefix}-${nodeId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export function prepareEnvelope(envelope: EdgeEnvelope, direction: 'inbound' | 'outbound', nodeId?: string) {
    return {
        traceId: envelope.traceId || generateTraceId(envelope.protocol || 'edge', nodeId || String(envelope.nodeId || 'system')),
        ...envelope,
        ...(nodeId && !envelope.nodeId ? { nodeId } : {}),
        direction,
        meta: envelope.meta || {},
    } satisfies EdgeEnvelope;
}

export function endpointWithToken(endpoint: string, token = '') {
    if (!endpoint || !token) return endpoint;
    const url = new URL(endpoint);
    url.searchParams.set('token', token);
    return url.toString();
}

export function maskToken(token: string) {
    if (!token) return '';
    if (token.length <= 8) return `${token.slice(0, 2)}***`;
    return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

export function maskEndpoint(endpoint: string) {
    if (!endpoint) return '';
    try {
        const url = new URL(endpoint);
        if (url.searchParams.has('token')) url.searchParams.set('token', maskToken(url.searchParams.get('token') || ''));
        return url.toString();
    } catch {
        return endpoint.replace(/([?&]token=)[^&]+/i, '$1***');
    }
}

export function hashToken(token: string) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export function safeTokenEqual(left: string, right: string) {
    const a = Buffer.from(left || '');
    const b = Buffer.from(right || '');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
