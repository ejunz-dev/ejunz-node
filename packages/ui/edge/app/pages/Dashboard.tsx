import {
  Button, CopyButton, Group, Paper, SimpleGrid, Text, TextInput, Title,
} from '@mantine/core';
import {
  IconApi, IconCheck, IconCopy, IconDeviceDesktop, IconPlug, IconShieldCheck,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api, EdgeNode, EdgeStatus } from '../api';

export function StatsCard({ title, value, Icon, color = 'blue' }) {
  return (
    <Paper withBorder p="md" radius="md" key={title}>
      <Group justify="space-between">
        <Text size="md" c="dimmed">{title}</Text>
        <Icon size="2rem" stroke={1.5} color={color} />
      </Group>
      <Group align="flex-end" gap="xs" mt={25}>
        <Text size="xl" fw={700}>{value}</Text>
      </Group>
    </Paper>
  );
}

export default function Dashboard() {
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError('');
      const [nodeResult, statusResult] = await Promise.all([
        api<{ nodes: EdgeNode[] }>('/api/edge/nodes'),
        api<EdgeStatus>('/api/edge/status'),
      ]);
      setNodes(nodeResult.nodes || []);
      setStatus(statusResult);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const onlineNodes = nodes.filter((node) => node.status === 'online').length;
  const pendingNodes = nodes.filter((node) => node.status === 'pending').length;
  const brokerEnabled = status?.broker ?? false;
  const upstreamConnected = status?.upstream?.connected ?? false;

  return (
    <div>
      <Group justify="space-between" mb="lg">
        <Title order={2}>Edge Dashboard</Title>
        <Button variant="light" onClick={() => void refresh()}>刷新</Button>
      </Group>

      {error && <Paper withBorder p="md" mb="lg"><Text c="red">{error}</Text></Paper>}

      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} m="lg">
        <StatsCard
          title="在线 Node"
          value={`${onlineNodes}/${nodes.length}`}
          Icon={IconDeviceDesktop}
          color={onlineNodes > 0 ? 'green' : 'gray'}
        />
        <StatsCard
          title="Edge Broker"
          value={brokerEnabled ? '已启用' : '已禁用'}
          Icon={IconPlug}
          color={brokerEnabled ? 'green' : 'red'}
        />
        <StatsCard
          title="上游连接"
          value={upstreamConnected ? '已连接' : '未连接'}
          Icon={IconApi}
          color={upstreamConnected ? 'green' : 'gray'}
        />
        <StatsCard
          title="待授权 Node"
          value={pendingNodes}
          Icon={IconShieldCheck}
          color={pendingNodes > 0 ? 'orange' : 'gray'}
        />
      </SimpleGrid>

      <Paper withBorder p="md" radius="md" m="lg">
        <Text size="md" c="dimmed" mb="xs">Node WebSocket Endpoint</Text>
        <Group align="flex-end" wrap="nowrap">
          <TextInput
            value={status?.nodeEndpoint || ''}
            readOnly
            style={{ flex: 1 }}
            description="Copy this endpoint into the Node ws.endpoint setting."
          />
          <CopyButton value={status?.nodeEndpoint || ''} timeout={1800}>
            {({ copied, copy }) => (
              <Button
                variant={copied ? 'light' : 'default'}
                color={copied ? 'green' : undefined}
                leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                disabled={!status?.nodeEndpoint}
                onClick={copy}
              >
                {copied ? '已复制' : '复制'}
              </Button>
            )}
          </CopyButton>
        </Group>
      </Paper>
    </div>
  );
}
