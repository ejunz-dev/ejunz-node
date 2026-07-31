import {
  Alert, Button, Group, Paper, PasswordInput, Stack, Switch, Text, TextInput, Title,
} from '@mantine/core';
import React, { useEffect, useState } from 'react';
import { api } from '../api';

type AuthConfig = {
  enabled: boolean;
  username: string;
  passwordConfigured: boolean;
};

export default function Auth() {
  const [config, setConfig] = useState<AuthConfig>({
    enabled: true,
    username: 'admin',
    passwordConfigured: false,
  });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setError('');
      const result = await api<AuthConfig>('/api/edge/auth-config');
      setConfig(result);
      setUsername(result.username || 'admin');
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
      const result = await api<AuthConfig & { ok: number }>('/api/edge/auth-config', {
        method: 'POST',
        body: JSON.stringify({
          enabled: config.enabled,
          username,
          password: password || undefined,
        }),
      });
      setPassword('');
      setMessage(result.enabled
        ? '认证配置已保存。若刚启用认证或修改了密码，请刷新页面后重新登录。'
        : '认证已关闭，面板与管理 API 将不再要求登录。');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Title order={2} mb="lg">认证设置</Title>
      <Paper withBorder p="md" radius="md" maw={720}>
        <Stack gap="md">
          <Group justify="space-between">
            <div>
              <Text fw={500}>控制面板 Basic Auth</Text>
              <Text size="sm" c="dimmed">关闭后，Edge UI 与管理 API 不再要求用户名/密码。</Text>
            </div>
            <Switch
              label={config.enabled ? '已启用' : '已禁用'}
              checked={config.enabled}
              onChange={(event) => setConfig({ ...config, enabled: event.currentTarget.checked })}
            />
          </Group>
          <TextInput
            label="用户名"
            description="默认 admin"
            value={username}
            disabled={!config.enabled}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
          <PasswordInput
            label="密码"
            description={config.passwordConfigured
              ? '已配置密码；留空表示保持原密码。'
              : '尚未配置独立密码时会回退到 viewPass。'}
            placeholder="留空保持当前密码"
            value={password}
            disabled={!config.enabled}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          {message && <Alert color="green">{message}</Alert>}
          {error && <Alert color="red">{error}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => void load()}>刷新</Button>
            <Button loading={saving} onClick={() => void save()}>保存</Button>
          </Group>
        </Stack>
      </Paper>
    </div>
  );
}
