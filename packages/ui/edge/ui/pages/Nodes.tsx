import { useCallback, useEffect, useState } from 'react';
import { Button } from '@ejunz/ui-next/components/button';
import { Callout } from '@ejunz/ui-next/components/callout';
import { Card } from '@ejunz/ui-next/components/card';
import { api, EdgeNode } from '../api';
function statusLabel(status: string) { return status === 'online' ? 'Online' : status === 'pending' ? 'Awaiting approval' : status === 'revoked' ? 'Revoked' : 'Offline'; }
export default function Nodes() {
  const [nodes, setNodes] = useState<EdgeNode[]>([]); const [error, setError] = useState(''); const [busyNode, setBusyNode] = useState('');
  const refresh = useCallback(async () => { try { setError(''); const result = await api<{ nodes: EdgeNode[] }>('/api/edge/nodes'); setNodes(result.nodes || []); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);
  const action = async (nodeId: string, operation: 'authorize' | 'revoke') => { try { setBusyNode(nodeId); setError(''); await api(`/api/edge/nodes/${encodeURIComponent(nodeId)}/${operation}`, { method: 'POST', body: '{}' }); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusyNode(''); } };
  return <section className="edge-page"><header className="edge-page-heading"><h1>Node management</h1><Button onClick={() => void refresh()}>Refresh</Button></header>
    {error && <Callout type="warn" title="Operation failed">{error}</Callout>}
    <Card title="Connected Nodes"><div className="edge-table-wrap"><table className="edge-table"><thead><tr><th>Node ID</th><th>Status</th><th>Address</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>{nodes.map((node) => <tr key={node.nodeId}><th scope="row">{node.nodeId}</th><td><span className={`edge-tag edge-tag-${node.status}`}>{statusLabel(node.status)}</span></td><td>{node.host}:{node.port || '-'}</td><td>{node.lastSeen ? new Date(node.lastSeen).toLocaleString() : '-'}</td><td className="edge-actions"><Button disabled={node.status !== 'pending' || busyNode === node.nodeId} onClick={() => void action(node.nodeId, 'authorize')}>Authorize</Button><Button disabled={!node.tokenConfigured || busyNode === node.nodeId} onClick={() => void action(node.nodeId, 'revoke')}>Revoke</Button></td></tr>)}</tbody></table></div>{!nodes.length && <p className="edge-muted">No Nodes connected yet.</p>}</Card>
  </section>;
}
