import {
  Alert, Badge, Button, Card, Grid, Group, Loader, Paper, ScrollArea, Stack, Text, Textarea, Title,
} from '@mantine/core';
import { IconMessagePlus, IconRefresh, IconSend } from '@tabler/icons-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

type AgentStatus = {
  state: 'ready' | 'waiting' | 'starting' | string;
  provider?: string;
  model?: string;
  message?: string;
};

type AgentSession = {
  sessionId: string;
  updatedAt: number;
  running: boolean;
};

type AgentEvent = {
  type: string;
  data?: any;
  timestamp?: number;
};

type EventRecord = {
  seq?: number;
  event: AgentEvent;
};

type RpcResponse<T> = {
  result?: { ok: boolean; value?: T };
  error?: { message?: string };
};

type LiveEvent = {
  type: 'session/event';
  sessionId: string;
  seq?: number;
  event: AgentEvent;
};

async function rpc<T>(method: string, payload: Record<string, unknown> = {}) {
  const response = await api<RpcResponse<T>>('/api/agent/rpc', {
    method: 'POST',
    body: JSON.stringify({ method, payload }),
  });
  if (!response.result?.ok) throw new Error(response.error?.message || 'Agent 请求失败');
  return response.result.value as T;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => String(part.text || ''))
    .join('\n')
    .trim();
}

function eventKey(record: EventRecord) {
  if (typeof record.seq === 'number') return `seq:${record.seq}`;
  return `fallback:${record.event.timestamp || 0}:${record.event.type}`;
}

function mergeRecords(current: EventRecord[], incoming: EventRecord[]) {
  const merged = new Map(current.map((record) => [eventKey(record), record]));
  for (const record of incoming) merged.set(eventKey(record), record);
  return [...merged.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

function eventText(event: AgentEvent) {
  if (event.type === 'user/message') return textContent(event.data?.content);
  if (event.type === 'assistant/message') return textContent(event.data?.message?.content);
  if (event.type === 'tool/call') {
    const args = event.data?.arguments;
    return `${event.data?.name || 'tool'}${args && Object.keys(args).length ? `\n${JSON.stringify(args, null, 2)}` : ''}`;
  }
  if (event.type === 'tool/result') return textContent(event.data?.message?.content) || JSON.stringify(event.data?.message || {}, null, 2);
  return '';
}

function eventRole(type: string) {
  if (type === 'user/message') return '你';
  if (type === 'assistant/message') return 'Ejunz Agent';
  if (type === 'tool/call') return '工具调用';
  if (type === 'tool/result') return '工具结果';
  return type;
}

export default function Chat() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [records, setRecords] = useState<EventRecord[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [turnRunning, setTurnRunning] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [error, setError] = useState('');

  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId);
  const isReady = status?.state === 'ready';
  const isRunning = sending || turnRunning || Boolean(selectedSession?.running);

  const refreshSessions = useCallback(async () => {
    const result = await rpc<{ items: AgentSession[] }>('session.list');
    const items = result.items || [];
    setSessions(items);
    return items;
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const result = await api<AgentStatus>('/api/agent/status');
      setStatus(result);
    } catch (e) {
      setStatus({ state: 'waiting', message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([refreshStatus(), refreshSessions()])
      .then(([, items]) => {
        if (active && !selectedSessionId && items.length) setSelectedSessionId(items[0].sessionId);
      })
      .catch((e) => { if (active) setError((e as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshSessions, refreshStatus]);

  useEffect(() => {
    if (!selectedSessionId) {
      setRecords([]);
      setStreamConnected(false);
      setTurnRunning(false);
      return undefined;
    }

    let active = true;
    setRecords([]);
    setHistoryLoading(true);
    setTurnRunning(false);
    const loadHistory = async () => {
      try {
        setHistoryLoading(true);
        const result = await rpc<{ events: EventRecord[] }>('session.history', { sessionId: selectedSessionId, maxMessages: 500 });
        if (active) {
          setRecords((current) => mergeRecords(current, result.events || []));
          const lastEvent = result.events?.[result.events.length - 1]?.event;
          if (lastEvent?.type === 'turn/end') {
            setTurnRunning(false);
            setSessions((current) => current.map((session) => (
              session.sessionId === selectedSessionId ? { ...session, running: false } : session
            )));
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setHistoryLoading(false);
      }
    };

    const source = new EventSource('/api/agent/events');
    source.onopen = () => {
      if (!active) return;
      setStreamConnected(true);
      setError('');
      // The SSE connection is open before history is fetched, so events emitted
      // during the fetch are received live and deduplicated by sequence number.
      void loadHistory();
      void refreshSessions().catch((e) => setError((e as Error).message));
    };
    source.onmessage = (message) => {
      if (!active) return;
      try {
        const live = JSON.parse(message.data) as LiveEvent;
        if (live.type !== 'session/event' || live.sessionId !== selectedSessionId || !live.event) return;
        setRecords((current) => mergeRecords(current, [{ seq: live.seq, event: live.event }]));
        if (live.event.type === 'turn/end') {
          setTurnRunning(false);
          setSessions((current) => current.map((session) => (
            session.sessionId === selectedSessionId ? { ...session, running: false } : session
          )));
        }
      } catch {
        setError('无法解析 Agent 实时事件');
      }
    };
    source.onerror = () => {
      if (active) setStreamConnected(false);
      // EventSource retries automatically. History is reloaded from onopen.
    };

    return () => {
      active = false;
      source.close();
      setStreamConnected(false);
    };
  }, [selectedSessionId, refreshSessions]);

  const createSession = async () => {
    setCreating(true);
    setError('');
    try {
      const result = await rpc<{ sessionId: string }>('session.create');
      const items = await refreshSessions();
      if (!items.some((item) => item.sessionId === result.sessionId)) {
        setSessions([{ sessionId: result.sessionId, updatedAt: Date.now(), running: false }, ...items]);
      }
      setSelectedSessionId(result.sessionId);
      setRecords([]);
      setTurnRunning(false);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const sendPrompt = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !selectedSessionId || sending || isRunning) return;
    if (!streamConnected) {
      setError('正在连接 Agent 实时事件，请连接成功后再发送。');
      return;
    }
    setSending(true);
    setTurnRunning(true);
    setError('');
    try {
      await rpc<{ accepted: boolean }>('session.prompt', {
        sessionId: selectedSessionId,
        content: [{ type: 'text', text: content }],
      });
      setDraft('');
      void refreshSessions().catch((e) => setError((e as Error).message));
    } catch (e) {
      setTurnRunning(false);
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const visibleRecords = records.filter((record) => ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(record.event.type));

  return (
    <Stack gap="lg" py="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Agent Chat</Title>
          <Text c="dimmed" size="sm" mt={4}>与当前 Edge Agent 对话，查询 Edge、Node 和 Zigbee 设备状态。</Text>
        </div>
        <Group>
          <Badge color={isReady ? 'green' : 'yellow'} variant="light">
            {isReady ? 'Agent 就绪' : status?.state === 'starting' ? '正在启动' : '待配置'}
          </Badge>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => { void refreshStatus(); void refreshSessions(); }}>
            刷新
          </Button>
          <Button leftSection={<IconMessagePlus size={16} />} onClick={() => void createSession()} loading={creating}>
            新建对话
          </Button>
        </Group>
      </Group>

      {!isReady && (
        <Alert color="yellow" title="Agent 尚未就绪">
          {status?.message || '请先在“模型配置”中启用 Provider 和模型，并配置 API Key。'}
        </Alert>
      )}
      {status?.state === 'ready' && (
        <Group gap="xs">
          <Badge variant="outline">Provider：{status.provider || '未知'}</Badge>
          <Badge variant="outline">Model：{status.model || '未知'}</Badge>
        </Group>
      )}
      {error && <Alert color="red" title="操作失败" withCloseButton onClose={() => setError('')}>{error}</Alert>}

      <Grid align="stretch" gutter="md">
        <Grid.Col span={{ base: 12, md: 3 }}>
          <Card withBorder radius="md" p="sm" h={620}>
            <Group justify="space-between" mb="sm">
              <Text fw={600}>对话</Text>
              <Badge variant="light">{sessions.length}</Badge>
            </Group>
            {loading ? (
              <Group justify="center" py="xl"><Loader size="sm" /></Group>
            ) : sessions.length === 0 ? (
              <Stack align="center" gap="xs" py="xl">
                <Text size="sm" c="dimmed" ta="center">还没有对话</Text>
                <Button size="xs" variant="light" onClick={() => void createSession()} loading={creating}>开始新对话</Button>
              </Stack>
            ) : (
              <Stack gap={6}>
                {sessions.map((session) => (
                  <Button
                    key={session.sessionId}
                    variant={session.sessionId === selectedSessionId ? 'light' : 'subtle'}
                    color={session.sessionId === selectedSessionId ? 'blue' : 'gray'}
                    justify="space-between"
                    fullWidth
                    onClick={() => { setError(''); setSelectedSessionId(session.sessionId); }}
                    rightSection={session.running ? <Badge size="xs" color="yellow">运行中</Badge> : null}
                  >
                    {new Date(session.updatedAt).toLocaleString()}
                  </Button>
                ))}
              </Stack>
            )}
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 9 }}>
          <Card withBorder radius="md" p="md" h={620}>
            <Stack h="100%" gap="sm">
              <Group justify="space-between">
                <div>
                  <Text fw={600}>{selectedSessionId ? `对话 ${selectedSessionId.slice(0, 8)}` : '选择或新建对话'}</Text>
                  <Text size="xs" c={streamConnected ? 'green' : 'dimmed'}>
                    {selectedSessionId ? (streamConnected ? '实时连接已建立' : '实时连接中断，正在重连…') : 'Agent 输出会显示在这里'}
                  </Text>
                </div>
                {selectedSessionId && <Badge color={isRunning ? 'yellow' : 'gray'}>{isRunning ? '处理中' : '空闲'}</Badge>}
              </Group>

              <ScrollArea type="auto" offsetScrollbars style={{ flex: 1 }} viewportProps={{ 'aria-label': '聊天消息' }}>
                <Stack gap="sm" p="xs">
                  {historyLoading && records.length === 0 && <Text size="sm" c="dimmed">正在加载历史消息…</Text>}
                  {!selectedSessionId && <Text size="sm" c="dimmed" ta="center" py="xl">新建一个对话，开始与 Agent 聊天。</Text>}
                  {selectedSessionId && !historyLoading && visibleRecords.length === 0 && (
                    <Text size="sm" c="dimmed" ta="center" py="xl">发送第一条消息开始对话。</Text>
                  )}
                  {visibleRecords.map((record) => {
                    const event = record.event;
                    const isUser = event.type === 'user/message';
                    const isTool = event.type === 'tool/call' || event.type === 'tool/result';
                    const content = eventText(event);
                    return (
                      <Group key={eventKey(record)} justify={isUser ? 'flex-end' : 'flex-start'} align="flex-start" wrap="nowrap">
                        {!isUser && <Badge mt={4} color={isTool ? 'gray' : 'blue'} variant="light">{eventRole(event.type)}</Badge>}
                        <Paper
                          withBorder
                          p="sm"
                          radius="md"
                          maw="85%"
                          bg={isUser ? 'blue.0' : isTool ? 'gray.0' : undefined}
                        >
                          {isUser && <Text size="xs" fw={600} c="blue" mb={4}>{eventRole(event.type)}</Text>}
                          <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content || '（无文本内容）'}</Text>
                          <Text size="xs" c="dimmed" ta="right" mt={6}>
                            {event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''}
                          </Text>
                        </Paper>
                      </Group>
                    );
                  })}
                  {isRunning && <Text size="sm" c="dimmed">Agent 正在处理…</Text>}
                </Stack>
              </ScrollArea>

              <form onSubmit={(event) => void sendPrompt(event)}>
                <Stack gap="xs">
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={selectedSessionId ? '输入消息…（Ctrl/⌘ + Enter 发送）' : '先新建一个对话'}
                    minRows={2}
                    maxRows={5}
                    autosize
                    disabled={!selectedSessionId || !isReady || isRunning}
                  />
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">Agent 当前只允许读取 Edge、Node 和设备状态。</Text>
                    <Button
                      type="submit"
                      leftSection={<IconSend size={15} />}
                      loading={sending}
                      disabled={!selectedSessionId || !isReady || isRunning || !streamConnected || !draft.trim()}
                    >
                      发送
                    </Button>
                  </Group>
                </Stack>
              </form>
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
