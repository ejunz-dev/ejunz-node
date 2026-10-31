import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@ejunz/ui-next/components/button';
import { Callout } from '@ejunz/ui-next/components/callout';
import { Card } from '@ejunz/ui-next/components/card';
import { api } from '../api';
type AgentStatus = { state: 'ready' | 'waiting' | 'starting' | string; provider?: string; model?: string; message?: string };
type AgentSession = { sessionId: string; updatedAt: number; running: boolean };
type AgentEvent = { type: string; data?: any; timestamp?: number };
type EventRecord = { seq?: number; event: AgentEvent };
type RpcResponse<T> = { result?: { ok: boolean; value?: T }; error?: { message?: string } };
type LiveEvent = { type: 'session/event'; sessionId: string; seq?: number; event: AgentEvent };
type PendingApproval = { rpcId: string; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string };
async function rpc<T>(method: string, payload: Record<string, unknown> = {}) { const response = await api<RpcResponse<T>>('/api/agent/rpc', { method: 'POST', body: JSON.stringify({ method, payload }) }); if (!response.result?.ok) throw new Error(response.error?.message || 'Agent request failed'); return response.result.value as T; }
function textContent(value: unknown): string { if (typeof value === 'string') return value; if (!Array.isArray(value)) return ''; return value.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text || '')).join('\n').trim(); }
function eventKey(record: EventRecord) { return typeof record.seq === 'number' ? `seq:${record.seq}` : `fallback:${record.event.timestamp || 0}:${record.event.type}`; }
function mergeRecords(current: EventRecord[], incoming: EventRecord[]) { const merged = new Map(current.map((record) => [eventKey(record), record])); for (const record of incoming) merged.set(eventKey(record), record); return [...merged.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0)); }
function eventText(event: AgentEvent) { if (event.type === 'user/message') return textContent(event.data?.content); if (event.type === 'assistant/message') return textContent(event.data?.message?.content); if (event.type === 'tool/call') { const args = event.data?.arguments; return `${event.data?.name || 'tool'}${args && Object.keys(args).length ? `\n${JSON.stringify(args, null, 2)}` : ''}`; } if (event.type === 'tool/result') return textContent(event.data?.message?.content) || JSON.stringify(event.data?.message || {}, null, 2); return ''; }
function eventRole(type: string) { return type === 'user/message' ? 'You' : type === 'assistant/message' ? 'Ejunz Agent' : type === 'tool/call' ? 'Tool call' : type === 'tool/result' ? 'Tool result' : type; }
export default function Chat() {
  const [status, setStatus] = useState<AgentStatus | null>(null); const [sessions, setSessions] = useState<AgentSession[]>([]); const [selectedSessionId, setSelectedSessionId] = useState(''); const [records, setRecords] = useState<EventRecord[]>([]); const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]); const [submittedApprovalIds, setSubmittedApprovalIds] = useState<string[]>([]); const [draft, setDraft] = useState(''); const [loading, setLoading] = useState(true); const [historyLoading, setHistoryLoading] = useState(false); const [creating, setCreating] = useState(false); const [deleting, setDeleting] = useState(false); const [sending, setSending] = useState(false); const [turnRunning, setTurnRunning] = useState(false); const [streamConnected, setStreamConnected] = useState(false); const [error, setError] = useState('');
  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId); const isReady = status?.state === 'ready'; const isRunning = sending || turnRunning || Boolean(selectedSession?.running);
  const refreshSessions = useCallback(async () => { const result = await rpc<{ items: AgentSession[] }>('session.list'); const items = result.items || []; setSessions(items); return items; }, []);
  const refreshStatus = useCallback(async () => { try { setStatus(await api<AgentStatus>('/api/agent/status')); } catch (e) { setStatus({ state: 'waiting', message: (e as Error).message }); } }, []);
  useEffect(() => { let active = true; Promise.all([refreshStatus(), refreshSessions()]).then(([, items]) => { if (active && !selectedSessionId && items.length) setSelectedSessionId(items[0].sessionId); }).catch((e) => { if (active) setError((e as Error).message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [refreshSessions, refreshStatus]);
  useEffect(() => {
    if (!selectedSessionId) { setRecords([]); setStreamConnected(false); setTurnRunning(false); return; }
    let active = true; setRecords([]); setPendingApprovals([]); setSubmittedApprovalIds([]); setHistoryLoading(true); setTurnRunning(false);
    const loadHistory = async () => { try { setHistoryLoading(true); const result = await rpc<{ events: EventRecord[] }>('session.history', { sessionId: selectedSessionId, maxMessages: 500 }); if (active) { setRecords((current) => mergeRecords(current, result.events || [])); const last = result.events?.[result.events.length - 1]?.event; if (last?.type === 'turn/end') { setTurnRunning(false); setSessions((current) => current.map((session) => session.sessionId === selectedSessionId ? { ...session, running: false } : session)); } } } catch (e) { if (active) setError((e as Error).message); } finally { if (active) setHistoryLoading(false); } };
    const source = new EventSource('/api/agent/events'); source.onopen = () => { if (!active) return; setStreamConnected(true); setError(''); void loadHistory(); void refreshSessions().catch((e) => setError((e as Error).message)); };
    source.onmessage = (message) => {
      if (!active) return;
      try {
        const live = JSON.parse(message.data) as LiveEvent;
        if (live.type !== 'session/event' || live.sessionId !== selectedSessionId || !live.event) return;
        if (live.event.type === 'approval/requested') {
          const data = live.event.data || {};
          if (typeof data.rpcId === 'string' && typeof data.approvalId === 'string') {
            setPendingApprovals((current) => current.some((item) => item.approvalId === data.approvalId) ? current : [...current, {
              rpcId: data.rpcId,
              sessionId: live.sessionId,
              approvalId: data.approvalId,
              toolName: String(data.toolName || 'tool'),
              ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
              ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
            }]);
          }
          return;
        }
        if (live.event.type === 'approval/resolved') {
          const approvalId = String(live.event.data?.approvalId || '');
          setPendingApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
          setSubmittedApprovalIds((current) => current.filter((id) => id !== approvalId));
          return;
        }
        setRecords((current) => mergeRecords(current, [{ seq: live.seq, event: live.event }]));
        if (live.event.type === 'turn/end') {
          setTurnRunning(false);
          setSessions((current) => current.map((session) => session.sessionId === selectedSessionId ? { ...session, running: false } : session));
        }
      } catch { setError('Unable to parse live Agent event'); }
    };
    source.onerror = () => { if (active) setStreamConnected(false); };
    return () => { active = false; source.close(); setStreamConnected(false); };
  }, [selectedSessionId, refreshSessions]);
  const createSession = async () => { setCreating(true); setError(''); try { const result = await rpc<{ sessionId: string }>('session.create'); const items = await refreshSessions(); if (!items.some((item) => item.sessionId === result.sessionId)) setSessions([{ sessionId: result.sessionId, updatedAt: Date.now(), running: false }, ...items]); setSelectedSessionId(result.sessionId); setRecords([]); setTurnRunning(false); setDraft(''); } catch (e) { setError((e as Error).message); } finally { setCreating(false); } };
  const deleteAllSessions = async () => {
    if (!sessions.length || deleting || creating || sending || sessions.some((session) => session.running)) return;
    if (!window.confirm(`Delete all ${sessions.length} conversations and their chat history? This cannot be undone.`)) return;
    setDeleting(true); setError('');
    try {
      for (const session of sessions) await rpc('session.delete', { sessionId: session.sessionId });
      setSessions([]); setSelectedSessionId(''); setRecords([]); setDraft(''); setTurnRunning(false);
    } catch (e) {
      setError((e as Error).message);
      try {
        const items = await refreshSessions();
        if (!items.some((session) => session.sessionId === selectedSessionId)) {
          setSelectedSessionId(items[0]?.sessionId || ''); setRecords([]); setTurnRunning(false);
        }
      } catch (refreshError) { setError(`${(e as Error).message}; ${(refreshError as Error).message}`); }
    } finally { setDeleting(false); }
  };
  const respondToApproval = async (approval: PendingApproval, outcome: 'allowed-once' | 'rejected') => {
    if (submittedApprovalIds.includes(approval.approvalId)) return;
    setSubmittedApprovalIds((current) => [...current, approval.approvalId]);
    setError('');
    try {
      const result = await rpc<{ accepted: boolean }>('approval.respond', {
        rpcId: approval.rpcId,
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        outcome,
      });
      if (!result?.accepted) throw new Error('Approval request expired or was already answered');
      setPendingApprovals((current) => current.filter((item) => item.approvalId !== approval.approvalId));
      setSubmittedApprovalIds((current) => current.filter((id) => id !== approval.approvalId));
    } catch (e) {
      setError((e as Error).message);
      setSubmittedApprovalIds((current) => current.filter((id) => id !== approval.approvalId));
    }
  };
  const sendPrompt = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const content = draft.trim(); if (!content || !selectedSessionId || sending || deleting || isRunning) return; if (!streamConnected) { setError('Connect to live Agent events before sending a message.'); return; } setSending(true); setTurnRunning(true); setError(''); try { await rpc<{ accepted: boolean }>('session.prompt', { sessionId: selectedSessionId, content: [{ type: 'text', text: content }] }); setDraft(''); void refreshSessions().catch((e) => setError((e as Error).message)); } catch (e) { setTurnRunning(false); setError((e as Error).message); } finally { setSending(false); } };
  const visibleRecords = records.filter((record) => {
    if (record.event.type === 'user/message') return record.event.data?.source?.kind === 'user';
    return ['assistant/message', 'tool/call', 'tool/result'].includes(record.event.type);
  });
  return <section className="edge-page edge-chat"><header className="edge-page-heading"><div><h1>Agent Chat</h1><p>Ask the Edge Agent about Edge, Nodes, and Zigbee device status.</p></div><div className="edge-actions"><span className={`edge-tag ${isReady ? 'edge-tag-online' : 'edge-tag-pending'}`}>{isReady ? 'Agent ready' : status?.state === 'starting' ? 'Starting' : 'Needs configuration'}</span><Button disabled={deleting} onClick={() => { void refreshStatus(); void refreshSessions(); }}>Refresh</Button><Button variant="primary" disabled={creating || deleting} onClick={() => void createSession()}>{creating ? 'Creating…' : 'New conversation'}</Button></div></header>
    {!isReady && <Callout type="warn" title="Agent is not ready">{status?.message || 'Enable a provider and model in Model configuration and add an API key.'}</Callout>}{isReady && <p className="edge-muted">Provider: {status?.provider || 'Unknown'} · Model: {status?.model || 'Unknown'}</p>}{error && <Callout type="warn" title="Operation failed">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></Callout>}
    <div className="edge-chat-layout"><Card title={`Conversations (${sessions.length})`}>{sessions.length > 0 && <div className="edge-actions"><Button disabled={loading || deleting || creating || sending || isRunning || sessions.some((session) => session.running)} onClick={() => void deleteAllSessions()}>{deleting ? 'Deleting…' : 'Delete all conversations'}</Button></div>}<div className="edge-session-list">{loading ? <p>Loading…</p> : sessions.length ? sessions.map((session) => <button className={session.sessionId === selectedSessionId ? 'edge-session selected' : 'edge-session'} key={session.sessionId} type="button" disabled={deleting} onClick={() => { setError(''); setSelectedSessionId(session.sessionId); }}>{new Date(session.updatedAt).toLocaleString()} {session.running && <span className="edge-tag edge-tag-pending">Running</span>}</button>) : <p className="edge-muted">No conversations yet.</p>}</div></Card>
      <Card title={selectedSessionId ? `Conversation ${selectedSessionId.slice(0, 8)}` : 'Choose or create a conversation'}><div className="edge-chat-status">{selectedSessionId ? (streamConnected ? 'Live connection established' : 'Live connection interrupted; reconnecting…') : 'Agent responses will appear here'} · {isRunning ? 'Working' : 'Idle'}</div>
        <div className="edge-messages" aria-label="Chat messages">{historyLoading && !records.length && <p>Loading conversation history…</p>}{!selectedSessionId && <p className="edge-muted">Create a conversation to start chatting.</p>}{selectedSessionId && !historyLoading && !visibleRecords.length && !pendingApprovals.length && <p className="edge-muted">Send the first message to begin.</p>}{visibleRecords.map((record) => <article className={`edge-message ${record.event.type === 'user/message' ? 'edge-message-user' : ''}`} key={eventKey(record)}><h3>{eventRole(record.event.type)}</h3><pre>{eventText(record.event) || '(No text content)'}</pre><time>{record.event.timestamp ? new Date(record.event.timestamp).toLocaleTimeString() : ''}</time></article>)}{pendingApprovals.filter((approval) => approval.sessionId === selectedSessionId).map((approval) => <article className="edge-message edge-message-approval" key={approval.approvalId}><h3>Approval required · {approval.toolName}</h3><p>{approval.reason || 'The Agent requests a Zigbee device action.'}</p><div className="edge-actions"><Button variant="primary" disabled={submittedApprovalIds.includes(approval.approvalId)} onClick={() => void respondToApproval(approval, 'allowed-once')}>{submittedApprovalIds.includes(approval.approvalId) ? 'Responding…' : 'Approve once'}</Button><Button disabled={submittedApprovalIds.includes(approval.approvalId)} onClick={() => void respondToApproval(approval, 'rejected')}>Reject</Button></div></article>)}{isRunning && <p>Agent is working…</p>}</div>
        <form className="edge-form" onSubmit={(event) => void sendPrompt(event)}><label className="edge-field"><span>Message</span><textarea value={draft} placeholder={selectedSessionId ? 'Write a message… (Ctrl/⌘ + Enter to send)' : 'Create a conversation first'} disabled={!selectedSessionId || !isReady || isRunning || deleting} onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /></label><div className="edge-actions edge-actions-between"><span className="edge-muted">Agent can read Edge, Node, and device status.</span><Button variant="primary" type="submit" disabled={!selectedSessionId || !isReady || isRunning || deleting || !streamConnected || !draft.trim()}>{sending ? 'Sending…' : 'Send'}</Button></div></form>
      </Card></div>
  </section>;
}
