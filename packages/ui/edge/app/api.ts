export type EdgeNode = {
  nodeId: string;
  status: 'pending' | 'online' | 'offline' | 'revoked' | string;
  host: string;
  port: number;
  tools?: any[];
  lastSeen: number;
  tokenConfigured?: boolean;
  requestId?: string;
};

export type EdgeStatus = {
  mode: 'edge';
  nodes: number;
  broker: boolean;
  nodeEndpoint?: string;
  upstream?: {
    enabled: boolean;
    configured: boolean;
    connected: boolean;
    endpoint?: string;
  };
};

function formatApiError(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return undefined;

  const value = error as { message?: unknown; params?: unknown };
  if (typeof value.message === 'string') {
    const params = Array.isArray(value.params) ? value.params.join(', ') : '';
    return params ? `${value.message}: ${params}` : value.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatApiError(body.error) || `${response.status} ${response.statusText}`);
  return body as T;
}
