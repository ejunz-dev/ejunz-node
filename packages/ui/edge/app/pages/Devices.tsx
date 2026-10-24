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
  const [syncMode, setSyncMode] = useState<'connecting' | 'live' | 'polling' | 'auth-error'>('connecting');

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
    if (!nodeId) {
      setSyncMode('polling');
      return;
    }

    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let fallbackTimer: number | undefined;
    let refreshTimer: number | undefined;
    let reconnectDelay = 1000;
    let helloSent = false;
    let subscribeSent = false;
    let subscribed = false;

    const send = (type: string, fields: Record<string, unknown> = {}) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ protocol: 'edge-ws/v1', type, ...fields }));
    };
    const refreshDevices = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        if (!disposed) void loadDevices().catch((e) => setError((e as Error).message));
      }, 80);
    };
    const connect = () => {
      if (disposed) return;
      helloSent = false;
      subscribeSent = false;
      subscribed = false;
      const url = new URL('/api/edge/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      setSyncMode('connecting');
      socket = new WebSocket(url.toString());
      socket.onopen = () => {
        if (disposed || helloSent) return;
        helloSent = true;
        send('hello', { clientId: 'edge-devices-ui' });
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        let message: any;
        try { message = JSON.parse(String(event.data)); } catch { return; }

        if (message.protocol !== 'edge-ws/v1') {
          if (message.type === 'device_state' && String(message.topic || '').startsWith(`node/${nodeId}/`)) refreshDevices();
          return;
        }
        if (message.type === 'hello' && !helloSent) {
          helloSent = true;
          send('hello', { clientId: 'edge-devices-ui' });
        } else if (message.type === 'hello_ack' && !subscribeSent) {
          subscribeSent = true;
          send('subscribe', { nodeIds: [nodeId] });
        } else if (message.type === 'subscribed') {
          subscribed = true;
          setSyncMode('live');
          send('snapshot_request', { nodeIds: [nodeId] });
        } else if (message.type === 'device_snapshot') {
          if (message.nodes?.some((node: any) => node.nodeId === nodeId)) refreshDevices();
        } else if (message.type === 'device_state' && message.nodeId === nodeId) {
          refreshDevices();
        } else if (message.type === 'ping') {
          send('ping', { timestamp: message.timestamp ?? Date.now() });
        }
      };
      socket.onclose = (event) => {
        if (disposed) return;
        subscribed = false;
        if (event.code === 4001 || event.code === 4003) {
          setSyncMode('auth-error');
          return;
        }
        setSyncMode('polling');
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      };
      socket.onerror = () => {
        try { socket?.close(); } catch {}
      };
    };

    connect();
    fallbackTimer = window.setInterval(() => {
      if (!subscribed) void loadDevices().catch((e) => setError((e as Error).message));
    }, 30000);

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (fallbackTimer !== undefined) window.clearInterval(fallbackTimer);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      try { socket?.close(); } catch {}
    };
  }, [loadDevices, nodeId]);

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
        <Group gap="sm">
          <Title order={2}>设备控制</Title>
          <Badge color={syncMode === 'live' ? 'green' : syncMode === 'auth-error' ? 'red' : syncMode === 'connecting' ? 'yellow' : 'gray'}>
            {syncMode === 'live' ? '实时同步' : syncMode === 'auth-error' ? '实时连接认证失败' : syncMode === 'connecting' ? '实时连接中' : '轮询兜底'}
          </Badge>
        </Group>
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
