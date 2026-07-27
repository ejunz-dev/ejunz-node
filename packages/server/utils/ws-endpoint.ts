function parseWsEndpoint(endpoint: string): { url: string; token: string } {
    if (!endpoint?.trim()) return { url: '', token: '' };
    try {
        const u = new URL(endpoint.trim());
        const token = u.searchParams.get('token') || '';
        u.searchParams.delete('token');
        let url = u.toString();
        if (url.endsWith('?')) url = url.slice(0, -1);
        return { url, token };
    } catch {
        return { url: endpoint.trim(), token: '' };
    }
}

function maskToken(token: string): string {
    if (!token) return '';
    if (token.length <= 8) return '****';
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function buildWsEndpoint(url: string, token: string): string {
    const base = url.trim();
    if (!base) return '';
    const u = new URL(base);
    const t = token.trim();
    if (t) u.searchParams.set('token', t);
    else u.searchParams.delete('token');
    return u.toString();
}

function maskWsEndpoint(endpoint: string): string {
    const { url, token } = parseWsEndpoint(endpoint);
    if (!token) return url || endpoint;
    return buildWsEndpoint(url, maskToken(token));
}

function ensureEdgeType(endpoint: string, type: string): string {
    const raw = endpoint.trim();
    if (!raw || !type.trim()) return raw;
    try {
        const u = new URL(raw);
        if (!u.searchParams.get('token') && !u.searchParams.get('type')) {
            u.searchParams.set('type', type.trim());
        }
        return u.toString();
    } catch {
        return raw;
    }
}

export {
    parseWsEndpoint,
    maskToken,
    buildWsEndpoint,
    maskWsEndpoint,
    ensureEdgeType,
};
