import { useCallback, useEffect, useState } from 'react';
import { Button } from '@ejunz/ui-next/components/button';
import { Callout } from '@ejunz/ui-next/components/callout';
import { Card } from '@ejunz/ui-next/components/card';
import { api, EdgeNode, EdgeStatus } from '../api';

export default function Dashboard() {
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setError(''); const [nodeResult, statusResult] = await Promise.all([api<{ nodes: EdgeNode[] }>('/api/edge/nodes'), api<EdgeStatus>('/api/edge/status')]); setNodes(nodeResult.nodes || []); setStatus(statusResult); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);
  const online = nodes.filter((node) => node.status === 'online').length;
  const pending = nodes.filter((node) => node.status === 'pending').length;
  const stats = [['Online nodes', `${online} / ${nodes.length}`], ['Edge broker', status?.broker ? 'Enabled' : 'Disabled'], ['Upstream', status?.upstream?.connected ? 'Connected' : 'Disconnected'], ['Awaiting approval', String(pending)]];
  return <section className="edge-page"><header className="edge-page-heading"><div><h1>Edge Dashboard</h1><p>Edge network and connected Node health.</p></div><Button onClick={() => void refresh()}>Refresh</Button></header>
    {error && <Callout type="warn" title="Status refresh failed">{error}</Callout>}
    <div className="edge-stat-grid">{stats.map(([title, value]) => <Card key={title} title={title}><strong className="edge-stat-value">{value}</strong></Card>)}</div>
    <Card title="Node WebSocket endpoint"><p className="edge-muted">Copy this endpoint into the Node ws.endpoint setting.</p><div className="edge-inline"><FieldEndpoint value={status?.nodeEndpoint || ''} /><Button disabled={!status?.nodeEndpoint} onClick={() => void navigator.clipboard?.writeText(status?.nodeEndpoint || '')}>Copy endpoint</Button></div></Card>
  </section>;
}
function FieldEndpoint({ value }: { value: string }) { return <input className="edge-endpoint" aria-label="Node WebSocket endpoint" readOnly value={value} />; }
