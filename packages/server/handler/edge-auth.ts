// @ts-nocheck
import { config } from '../config';

export function getEdgeAuthConfig() {
    const auth = (config as any).auth || {};
    return {
        enabled: auth.enabled !== false,
        username: String(auth.username || 'admin'),
        password: String(auth.password || (config as any).viewPass || ''),
    };
}

function requestQuery(request: any) {
    if (request?.query) return request.query;
    try {
        return Object.fromEntries(new URL(String(request?.url || ''), 'http://localhost').searchParams.entries());
    } catch {
        return {};
    }
}

function bearerToken(request: any) {
    const headers = request?.headers || {};
    const authorization = String(headers.authorization || '');
    if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
    return String(headers['x-edge-token'] || headers['x-api-token'] || '').trim();
}

/** Shared auth check for HTTP handlers and raw WebSocket upgrade requests. */
export function isEdgeAdminAuthorized(request: any) {
    const authConfig = getEdgeAuthConfig();
    if (!authConfig.enabled) return true;

    const headers = request?.headers || {};
    const authorization = String(headers.authorization || '');
    if (authorization.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(authorization.slice(6), 'base64').toString();
            const separator = decoded.indexOf(':');
            const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
            const password = separator >= 0 ? decoded.slice(separator + 1) : '';
            if (username === authConfig.username && password === authConfig.password) return true;
        } catch {}
    }

    const query = requestQuery(request);
    const token = String(query.token || query.access_token || bearerToken(request) || '');
    return Boolean(token) && token === authConfig.password;
}

export function requireEdgeAdmin(handler: any) {
    if (isEdgeAdminAuthorized(handler.request)) return true;
    handler.response.status = 401;
    handler.response.addHeader('WWW-Authenticate', 'Basic realm="Ejunz Edge"');
    handler.response.body = { error: 'edge admin authentication required' };
    return false;
}
