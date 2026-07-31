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

export function isEdgeAdminAuthorized(request: any) {
    const authConfig = getEdgeAuthConfig();
    if (!authConfig.enabled) return true;

    const authorization = request?.headers?.authorization || '';
    if (authorization.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(authorization.slice(6), 'base64').toString();
            const separator = decoded.indexOf(':');
            const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
            const password = separator >= 0 ? decoded.slice(separator + 1) : '';
            if (username === authConfig.username && password === authConfig.password) return true;
        } catch {}
    }

    return String(request?.query?.token || '') === authConfig.password;
}

export function requireEdgeAdmin(handler: any) {
    if (isEdgeAdminAuthorized(handler.request)) return true;
    handler.response.status = 401;
    handler.response.addHeader('WWW-Authenticate', 'Basic realm="Ejunz Edge"');
    handler.response.body = { error: 'edge admin authentication required' };
    return false;
}
