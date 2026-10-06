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

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body as T;
}
