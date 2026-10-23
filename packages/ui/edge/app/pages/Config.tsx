import {
  Alert, Badge, Button, Card, Divider, Group, Modal, PasswordInput, Stack, Switch,
  Table, Text, TextInput, Title,
} from '@mantine/core';
import {
  IconCloudDownload, IconEdit, IconPlus, IconRefresh, IconTrash,
} from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { api } from '../api';

type ModelConfig = {
  id: string;
  name?: string;
  enabled: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

type ProviderConfig = {
  id: string;
  displayName: string;
  baseURL: string;
  api?: string;
  enabled: boolean;
  models: ModelConfig[];
  lastSyncAt?: number;
  keyConfigured?: boolean;
  keySource?: string;
  keyMasked?: string;
  keyWritable?: boolean;
  enabledModelCount?: number;
  registered?: boolean;
};

type ProviderForm = {
  displayName: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
};

const emptyForm: ProviderForm = {
  displayName: '',
  baseURL: '',
  apiKey: '',
  enabled: true,
};

export default function Config() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState('');
  const [updatingModel, setUpdatingModel] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async (quiet = false) => {
    try {
      if (!quiet) setLoading(true);
      setError('');
      const result = await api<{ providers?: ProviderConfig[] }>('/api/llm-config');
      setProviders(result.providers || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setError('');
    setNotice('');
    setModalOpen(true);
  };

  const openEdit = (provider: ProviderConfig) => {
    setEditing(provider);
    setForm({
      displayName: provider.displayName,
      baseURL: provider.baseURL,
      apiKey: '',
      enabled: provider.enabled,
    });
    setError('');
    setNotice('');
    setModalOpen(true);
  };

  const saveProvider = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = editing
        ? {
          action: 'update',
          id: editing.id,
          displayName: form.displayName.trim(),
          baseURL: form.baseURL.trim(),
          api: 'openai-completions',
          enabled: form.enabled,
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        }
        : {
          action: 'create',
          displayName: form.displayName.trim(),
          baseURL: form.baseURL.trim(),
          api: 'openai-completions',
          apiKey: form.apiKey.trim(),
          enabled: form.enabled,
        };
      await api('/api/llm-config/providers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setModalOpen(false);
      setNotice(editing ? 'Provider 配置已更新' : 'Provider 已添加');
      await load(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const syncProvider = async (provider: ProviderConfig) => {
    setSyncingId(provider.id);
    setError('');
    setNotice('');
    try {
      const result = await api<{ added: number; updated: number; total: number }>(
        '/api/llm-config/providers/sync',
        { method: 'POST', body: JSON.stringify({ id: provider.id }) },
      );
      setNotice(`${provider.displayName} 同步完成：新增 ${result.added}，更新 ${result.updated}，共 ${result.total} 个模型`);
      await load(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncingId('');
    }
  };

  const deleteProvider = async (provider: ProviderConfig) => {
    if (!window.confirm(`确定删除「${provider.displayName}」？此操作也会删除该 Provider 下的模型和托管 API Key。`)) return;
    setError('');
    setNotice('');
    try {
      await api('/api/llm-config/providers', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', id: provider.id }),
      });
      setNotice(`${provider.displayName} 已删除`);
      await load(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleModel = async (provider: ProviderConfig, model: ModelConfig, enabled: boolean) => {
    const key = `${provider.id}:${model.id}`;
    setUpdatingModel(key);
    setError('');
    setNotice('');
    try {
      await api('/api/llm-config/models', {
        method: 'POST',
        body: JSON.stringify({ providerId: provider.id, modelId: model.id, enabled }),
      });
      await load(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUpdatingModel('');
    }
  };

  const activeProvider = providers.find((provider) => provider.registered);

  return (
    <Stack gap="lg" py="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>模型配置</Title>
          <Text c="dimmed" size="sm" mt={4}>
            管理 OpenAI-compatible API 提供商，并选择 Edge Agent 可用的模型。
          </Text>
        </div>
        <Group>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>添加 Provider</Button>
        </Group>
      </Group>

      {error && <Alert color="red" title="操作失败">{error}</Alert>}
      {notice && <Alert color="green">{notice}</Alert>}

      <Alert color={activeProvider ? 'green' : 'yellow'} title={activeProvider ? 'Agent 模型已就绪' : '尚未选择可用模型'}>
        {activeProvider
          ? `当前由 ${activeProvider.displayName} 提供服务。Edge Agent 使用第一个已启用 Provider 下的第一个已启用模型。`
          : '启用至少一个 Provider 和一个模型后，Agent Chat 才能发送消息。'}
      </Alert>

      {loading && providers.length === 0 ? (
        <Text c="dimmed">正在加载模型配置…</Text>
      ) : providers.length === 0 ? (
        <Card withBorder radius="md" p="xl">
          <Stack align="center" gap="xs">
            <Text fw={600}>还没有模型 Provider</Text>
            <Text c="dimmed" size="sm" ta="center">添加兼容 OpenAI Chat Completions 的服务，然后同步模型列表。</Text>
            <Button mt="sm" leftSection={<IconPlus size={16} />} onClick={openCreate}>添加 Provider</Button>
          </Stack>
        </Card>
      ) : (
        <Stack gap="md">
          {providers.map((provider) => (
            <Card key={provider.id} withBorder radius="md" p="md">
              <Stack gap="md">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <div style={{ minWidth: 0 }}>
                    <Group gap="xs" mb={4}>
                      <Text fw={650} size="lg">{provider.displayName}</Text>
                      {provider.registered && <Badge color="green">当前 Agent Provider</Badge>}
                      <Badge color={provider.enabled ? 'blue' : 'gray'} variant="light">
                        {provider.enabled ? '已启用' : '已禁用'}
                      </Badge>
                    </Group>
                    <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{provider.baseURL}</Text>
                    <Group gap="xs" mt={6}>
                      <Badge variant="outline">{provider.api || 'openai-completions'}</Badge>
                      <Text size="xs" c="dimmed">
                        API Key：{provider.keyConfigured ? `${provider.keyMasked || '••••••••'}${provider.keySource ? ` · ${provider.keySource}` : ''}` : '未配置'}
                      </Text>
                      <Text size="xs" c="dimmed">
                        上次同步：{provider.lastSyncAt ? new Date(provider.lastSyncAt).toLocaleString() : '尚未同步'}
                      </Text>
                    </Group>
                  </div>
                  <Group gap="xs" wrap="nowrap">
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconCloudDownload size={14} />}
                      loading={syncingId === provider.id}
                      onClick={() => void syncProvider(provider)}
                    >
                      同步模型
                    </Button>
                    <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={() => openEdit(provider)}>
                      编辑
                    </Button>
                    <Button size="xs" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => void deleteProvider(provider)}>
                      删除
                    </Button>
                  </Group>
                </Group>

                <Divider />
                <Group justify="space-between">
                  <Text fw={600} size="sm">可用模型</Text>
                  <Text size="xs" c="dimmed">
                    {(provider.models || []).filter((model) => model.enabled).length} / {(provider.models || []).length} 已启用
                  </Text>
                </Group>
                {(provider.models || []).length === 0 ? (
                  <Text size="sm" c="dimmed">还没有模型。点击“同步模型”从 Provider 拉取。</Text>
                ) : (
                  <Table.ScrollContainer minWidth={600}>
                    <Table verticalSpacing="xs" highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>状态</Table.Th>
                          <Table.Th>模型</Table.Th>
                          <Table.Th>上下文</Table.Th>
                          <Table.Th>最大输出</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {provider.models.map((model) => (
                          <Table.Tr key={model.id}>
                            <Table.Td>
                              <Switch
                                size="xs"
                                aria-label={`启用 ${model.id}`}
                                checked={model.enabled}
                                disabled={!provider.enabled || updatingModel === `${provider.id}:${model.id}`}
                                onChange={(event) => void toggleModel(provider, model, event.currentTarget.checked)}
                              />
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm" fw={500}>{model.name || model.id}</Text>
                              {model.name && <Text size="xs" c="dimmed" ff="monospace">{model.id}</Text>}
                            </Table.Td>
                            <Table.Td>{model.contextWindow ? model.contextWindow.toLocaleString() : '—'}</Table.Td>
                            <Table.Td>{model.maxTokens ? model.maxTokens.toLocaleString() : '—'}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
      )}

      <Modal opened={modalOpen} onClose={() => setModalOpen(false)} title={editing ? '编辑 Provider' : '添加 Provider'} centered>
        <form onSubmit={(event) => void saveProvider(event)}>
          <Stack gap="md">
            <TextInput
              label="名称"
              placeholder="DeepSeek"
              required
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })}
            />
            <TextInput
              label="Base URL"
              description="填写 API 根地址，例如 https://api.deepseek.com/v1"
              placeholder="https://api.example.com/v1"
              required
              value={form.baseURL}
              onChange={(event) => setForm({ ...form, baseURL: event.currentTarget.value })}
            />
            <TextInput label="API 类型" value="OpenAI-compatible Chat Completions" readOnly />
            <PasswordInput
              label="API Key"
              description={editing ? '留空会保留现有密钥；密钥不会再次显示。' : '密钥仅保存在本机受限权限文件中。'}
              placeholder={editing ? '留空保持不变' : '输入 API Key'}
              required={!editing}
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.currentTarget.value })}
              autoComplete="new-password"
            />
            <Switch
              label="启用此 Provider"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setModalOpen(false)}>取消</Button>
              <Button type="submit" loading={saving}>{editing ? '保存更改' : '添加 Provider'}</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
