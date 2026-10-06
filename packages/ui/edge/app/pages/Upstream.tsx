import {
  Alert, Button, Group, Paper, PasswordInput, Stack, Switch, Text, TextInput, Title,
} from '@mantine/core';
import React, { useEffect, useState } from 'react';
import { api } from '../api';

type UpstreamConfig = {
  enabled: boolean;
  endpoint: string;
  connected: boolean;
};

export default function Upstream() {
  const [config, setConfig] = useState<UpstreamConfig>({ enabled: false, endpoint: '', connected: false });
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setError('');
      const result = await api<UpstreamConfig>('/api/edge/upstream');
      setConfig(result);
      setEndpoint(result.endpoint || '');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    try {
      setSaving(true);
      setError('');
      setMessage('');
      await api('/api/edge/upstream', {
        method: 'POST',
        body: JSON.stringify({ enabled: config.enabled, endpoint, token: token || undefined }),
      });
      setToken('');
      setMessage('上游配置已保存');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Title order={2} mb="lg">上游连接</Title>
      <Paper withBorder p="md" radius="md" maw={720}>
        <Stack gap="md">
          <Group justify="space-between">
            <div>
              <Text fw={500}>Ejunz 上游 WebSocket</Text>
              <Text size="sm" c="dimmed">Node 的状态和工具会通过 Edge 转发到这里。</Text>
            </div>
            <Switch
              label={config.enabled ? '已启用' : '已禁用'}
              checked={config.enabled}
              onChange={(event) => setConfig({ ...config, enabled: event.currentTarget.checked })}
            />
          </Group>
          <TextInput
            label="WebSocket Endpoint"
            description="例如 wss://example.com/mcp/ws"
            placeholder="wss://..."
            value={endpoint}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
          />
          <PasswordInput
            label="Token"
            description="保存后不会在面板中显示；留空表示保持原 Token。"
            placeholder="留空保持当前 Token"
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
          />
          {message && <Alert color="green">{message}</Alert>}
          {error && <Alert color="red">{error}</Alert>}
          <Group justify="space-between">
            <Text size="sm" c={config.connected ? 'green' : 'dimmed'}>
              当前状态：{config.connected ? '已连接' : '未连接'}
            </Text>
            <Group gap="xs">
              <Button variant="default" onClick={() => void load()}>刷新</Button>
              <Button loading={saving} onClick={() => void save()}>保存并重连</Button>
            </Group>
          </Group>
        </Stack>
      </Paper>
    </div>
  );
}
