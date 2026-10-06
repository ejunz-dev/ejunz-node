import {
  Badge, Button, Group, Paper, ScrollArea, Table, Text, Title,
} from '@mantine/core';
import React, { useCallback, useEffect, useState } from 'react';
import { api, EdgeNode } from '../api';

function statusColor(status: string) {
  if (status === 'online') return 'green';
  if (status === 'pending') return 'yellow';
  if (status === 'revoked') return 'red';
  return 'gray';
}

function statusLabel(status: string) {
  if (status === 'online') return '在线';
  if (status === 'pending') return '待授权';
  if (status === 'revoked') return '已撤销';
  return '离线';
}

export default function Nodes() {
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [error, setError] = useState('');
  const [busyNode, setBusyNode] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError('');
      const result = await api<{ nodes: EdgeNode[] }>('/api/edge/nodes');
      setNodes(result.nodes || []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const action = async (nodeId: string, operation: 'authorize' | 'revoke') => {
    try {
      setBusyNode(nodeId);
      setError('');
      await api(`/api/edge/nodes/${encodeURIComponent(nodeId)}/${operation}`, {
        method: 'POST',
        body: '{}',
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyNode('');
    }
  };

  return (
    <div>
      <Group justify="space-between" mb="lg">
        <Title order={2}>Node 管理</Title>
        <Button variant="light" onClick={() => void refresh()}>刷新</Button>
      </Group>

      {error && <Paper withBorder p="md" mb="lg"><Text c="red">{error}</Text></Paper>}

      <Paper withBorder p="md" radius="md">
        <ScrollArea>
          <Table striped highlightOnHover miw={760}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Node ID</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>地址</Table.Th>
                <Table.Th>MCP 工具</Table.Th>
                <Table.Th>最近在线</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {nodes.map((node) => (
                <Table.Tr key={node.nodeId}>
                  <Table.Td><Text fw={500}>{node.nodeId}</Text></Table.Td>
                  <Table.Td><Badge color={statusColor(node.status)}>{statusLabel(node.status)}</Badge></Table.Td>
                  <Table.Td>{node.host}:{node.port || '-'}</Table.Td>
                  <Table.Td>{node.tools?.length || 0}</Table.Td>
                  <Table.Td>{node.lastSeen ? new Date(node.lastSeen).toLocaleString() : '-'}</Table.Td>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Button
                        size="xs"
                        loading={busyNode === node.nodeId}
                        disabled={node.status !== 'pending'}
                        onClick={() => void action(node.nodeId, 'authorize')}
                      >授权</Button>
                      <Button
                        size="xs"
                        color="red"
                        variant="light"
                        loading={busyNode === node.nodeId}
                        disabled={!node.tokenConfigured}
                        onClick={() => void action(node.nodeId, 'revoke')}
                      >撤销</Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        {!nodes.length && <Text c="dimmed" ta="center" mt="md">尚未连接 Node</Text>}
      </Paper>
    </div>
  );
}
