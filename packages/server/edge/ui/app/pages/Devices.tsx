import {
  Badge, Button, Group, Paper, Select, SimpleGrid, Stack, Switch, Text, Title,
} from '@mantine/core';
import React, { useCallback, useEffect, useState } from 'react';
import { api, EdgeNode } from '../api';

type Device = {
  deviceId: string;
  friendlyName: string;
  model?: string;
  vendor?: string;
  type?: string;
  supportsOnOff?: boolean;
  currentState?: string;
  online?: boolean;
};

export default function Devices() {
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState('');
  const [busyDevice, setBusyDevice] = useState('');

  const loadNodes = useCallback(async () => {
    const result = await api<{ nodes: EdgeNode[] }>('/api/edge/nodes');
    setNodes(result.nodes || []);
    if (!nodeId || !result.nodes.some((node) => node.nodeId === nodeId)) {
      setNodeId(result.nodes.find((node) => node.status === 'online')?.nodeId || result.nodes[0]?.nodeId || null);
    }
  }, [nodeId]);

  const loadDevices = useCallback(async () => {
    if (!nodeId) {
      setDevices([]);
      return;
    }
    const result = await api<{ devices?: Device[] }>('/api/edge/nodes/' + encodeURIComponent(nodeId) + '/devices');
    setDevices(result.devices || []);
  }, [nodeId]);

  useEffect(() => {
    void loadNodes().catch((e) => setError((e as Error).message));
    const timer = window.setInterval(() => void loadNodes().catch((e) => setError((e as Error).message)), 5000);
    return () => window.clearInterval(timer);
  }, [loadNodes]);

  useEffect(() => {
    void loadDevices().catch((e) => setError((e as Error).message));
    const timer = window.setInterval(() => void loadDevices().catch((e) => setError((e as Error).message)), 2000);
    return () => window.clearInterval(timer);
  }, [loadDevices]);

  const control = async (deviceId: string, state: 'ON' | 'OFF' | 'TOGGLE') => {
    if (!nodeId) return;
    try {
      setBusyDevice(deviceId);
      setError('');
      await api(`/api/edge/nodes/${encodeURIComponent(nodeId)}/devices/control`, {
        method: 'POST',
        body: JSON.stringify({ deviceId, state }),
      });
      await loadDevices();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyDevice('');
    }
  };

  return (
    <div>
      <Group justify="space-between" mb="lg">
        <Title order={2}>设备控制</Title>
        <Button variant="light" onClick={() => void loadDevices()}>刷新</Button>
      </Group>

      {error && <Paper withBorder p="md" mb="lg"><Text c="red">{error}</Text></Paper>}

      <Paper withBorder p="md" radius="md" mb="lg">
        <Select
          label="选择 Node"
          placeholder="选择要控制的 Node"
          data={nodes.map((node) => ({ value: node.nodeId, label: `${node.nodeId} (${node.status})` }))}
          value={nodeId}
          onChange={setNodeId}
          searchable
          clearable
        />
      </Paper>

      {!nodeId && <Text c="dimmed" ta="center">暂无已连接 Node</Text>}
      {nodeId && !devices.length && <Text c="dimmed" ta="center">没有获取到设备，或 Node 尚未完成 Zigbee 初始化</Text>}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {devices.map((device) => (
          <Paper key={device.deviceId} withBorder p="md" radius="md">
            <Stack gap="xs">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Text fw={600}>{device.friendlyName || device.deviceId}</Text>
                  <Text size="xs" c="dimmed">{device.deviceId}</Text>
                </div>
                <Badge color={device.online === false ? 'gray' : 'green'}>{device.online === false ? '离线' : '在线'}</Badge>
              </Group>
              <Text size="sm" c="dimmed">{device.vendor || '未知厂商'} · {device.model || '未知型号'}</Text>
              <Group justify="space-between" align="center" mt="sm">
                <Text size="sm" c={device.currentState === 'ON' ? 'green' : 'dimmed'}>
                  状态：{device.currentState === 'ON' ? '开启' : device.currentState === 'OFF' ? '关闭' : '未知'}
                </Text>
                <Switch
                  size="md"
                  onLabel="ON"
                  offLabel="OFF"
                  checked={device.currentState === 'ON'}
                  disabled={device.supportsOnOff === false || busyDevice === device.deviceId}
                  onChange={(event) => void control(device.deviceId, event.currentTarget.checked ? 'ON' : 'OFF')}
                />
              </Group>
            </Stack>
          </Paper>
        ))}
      </SimpleGrid>
    </div>
  );
}
