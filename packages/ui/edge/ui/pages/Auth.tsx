import { useEffect, useState } from 'react';
import { Button } from '@ejunz/ui-next/components/button';
import { Callout } from '@ejunz/ui-next/components/callout';
import { Card } from '@ejunz/ui-next/components/card';
import { Field } from '@ejunz/ui-next/components/field';
import { api } from '../api';

type AuthConfig = { enabled: boolean; username: string; passwordConfigured: boolean };

export default function Auth() {
  const [config, setConfig] = useState<AuthConfig>({ enabled: true, username: 'admin', passwordConfigured: false });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const load = async () => {
    try { setError(''); const result = await api<AuthConfig>('/api/edge/auth-config'); setConfig(result); setUsername(result.username || 'admin'); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    try {
      setSaving(true); setError(''); setMessage('');
      const result = await api<AuthConfig & { ok: number }>('/api/edge/auth-config', { method: 'POST', body: JSON.stringify({ enabled: config.enabled, username, password: password || undefined }) });
      setPassword(''); setMessage(result.enabled ? '认证配置已保存。若刚启用认证或修改了密码，请刷新页面后重新登录。' : '认证已关闭，面板与管理 API 将不再要求登录。'); await load();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  return <section className="edge-page"><header className="edge-page-heading"><h1>认证设置</h1></header>
    <Card title="控制面板 Basic Auth"><div className="edge-form">
      <label className="edge-check"><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig({ ...config, enabled: event.currentTarget.checked })} /><span>启用认证</span></label>
      <p className="edge-muted">关闭后，Edge UI 与管理 API 不再要求用户名/密码。</p>
      <Field label="用户名" value={username} disabled={!config.enabled} onChange={(event) => setUsername(event.currentTarget.value)} />
      <Field label="密码" type="password" value={password} disabled={!config.enabled} placeholder="留空保持当前密码" onChange={(event) => setPassword(event.currentTarget.value)} />
      <p className="edge-muted">{config.passwordConfigured ? '已配置密码；留空表示保持原密码。' : '尚未配置独立密码时会回退到 viewPass。'}</p>
      {message && <p role="status">{message}</p>}{error && <Callout type="warn" title="操作失败">{error}</Callout>}
      <div className="edge-actions"><Button onClick={() => void load()}>刷新</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</Button></div>
    </div></Card>
  </section>;
}
