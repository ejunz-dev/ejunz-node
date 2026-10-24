import { useEffect, useState } from 'react';
import { Button } from '@ejunz/ui-next/components/button';
import { Callout } from '@ejunz/ui-next/components/callout';
import { Card } from '@ejunz/ui-next/components/card';
import { Field } from '@ejunz/ui-next/components/field';
import { api } from '../api';
type UpstreamConfig = { enabled: boolean; endpoint: string; connected: boolean };
export default function Upstream() {
  const [config, setConfig] = useState<UpstreamConfig>({ enabled: false, endpoint: '', connected: false }); const [endpoint, setEndpoint] = useState(''); const [token, setToken] = useState(''); const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const load = async () => { try { setError(''); const result = await api<UpstreamConfig>('/api/edge/upstream'); setConfig(result); setEndpoint(result.endpoint || ''); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { void load(); }, []);
  const save = async () => { try { setSaving(true); setError(''); setMessage(''); await api('/api/edge/upstream', { method: 'POST', body: JSON.stringify({ enabled: config.enabled, endpoint, token: token || undefined }) }); setToken(''); setMessage('Upstream settings saved'); await load(); } catch (e) { setError((e as Error).message); } finally { setSaving(false); } };
  return <section className="edge-page"><header className="edge-page-heading"><h1>Upstream connection</h1></header><Card title="Ejunz upstream WebSocket"><div className="edge-form">
    <p>Node MQTT status and device events are forwarded to this service.</p><label className="edge-check"><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig({ ...config, enabled: event.currentTarget.checked })} />Enable upstream</label>
    <div className="edge-form"><Field label="WebSocket endpoint" placeholder="wss://…" value={endpoint} onChange={(event) => setEndpoint(event.currentTarget.value)} /><p className="edge-muted">Enter the address provided by the upstream Edge WebSocket service.</p></div>
    <div className="edge-form"><Field label="Token" type="password" placeholder="Leave blank to keep current token" value={token} onChange={(event) => setToken(event.currentTarget.value)} /><p className="edge-muted">Saved tokens are not displayed. Leave empty to keep the current token.</p></div>
    <p className="edge-muted">Connection status: <span className={config.connected ? 'edge-status-online' : ''}>{config.connected ? 'Connected' : 'Disconnected'}</span></p>
    {message && <p role="status">{message}</p>}{error && <Callout type="warn" title="Operation failed">{error}</Callout>}<div className="edge-actions"><Button onClick={() => void load()}>Refresh</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save and reconnect'}</Button></div>
  </div></Card></section>;
}
