import { useEffect, useRef, useState } from 'react';
import { Button } from '@ejunz/ui-next/components/button';
import { Callout } from '@ejunz/ui-next/components/callout';
import { Card } from '@ejunz/ui-next/components/card';
import { Field } from '@ejunz/ui-next/components/field';

type Device = {
    friendly_name?: string;
    ieee_address?: string;
    type?: string;
    definition?: { model?: string };
    state?: { state?: string; power?: string; [key: string]: unknown };
};
type Message = {
    type?: string;
    connected?: boolean;
    coordinator?: { ieee_address?: string };
    enabled?: boolean;
    remaining?: number;
    devices?: Device[];
    deviceId?: string;
    device?: Device;
    state?: unknown;
    success?: boolean;
    error?: string;
    message?: string;
};

export default function Console() {
    const [socketStatus, setSocketStatus] = useState('未连接');
    const [connected, setConnected] = useState(false);
    const [zigbeeConnected, setZigbeeConnected] = useState<boolean>();
    const [coordinator, setCoordinator] = useState('-');
    const [permitStatus, setPermitStatus] = useState('-');
    const [joinTime, setJoinTime] = useState(120);
    const [devices, setDevices] = useState<Device[]>([]);
    const [error, setError] = useState('');
    const socketRef = useRef<WebSocket | null>(null);
    const reconnectRef = useRef<number | undefined>();
    const errorTimerRef = useRef<number | undefined>();

    useEffect(() => {
        let disposed = false;
        const connect = () => {
            if (disposed || socketRef.current?.readyState === WebSocket.OPEN) return;
            setSocketStatus('连接中...');
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(`${protocol}//${window.location.host}/zigbee-ws`);
            socketRef.current = ws;
            ws.onopen = () => {
                if (disposed) return ws.close();
                setSocketStatus('已连接');
                setConnected(true);
                if (reconnectRef.current !== undefined) window.clearTimeout(reconnectRef.current);
                reconnectRef.current = undefined;
                ['getStatus', 'getCoordinator', 'getPermitStatus', 'getDevices'].forEach((type) => ws.send(JSON.stringify({ type })));
            };
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data) as Message;
                    switch (msg.type) {
                        case 'status': setZigbeeConnected(!!msg.connected); break;
                        case 'coordinator': setCoordinator(msg.coordinator?.ieee_address || '-'); break;
                        case 'permitStatus': setPermitStatus(msg.enabled ? `配对中 ${msg.remaining ?? 0}s` : '已关闭'); break;
                        case 'devices': setDevices(msg.devices || []); break;
                        case 'deviceState': {
                            const id = msg.device?.friendly_name || msg.device?.ieee_address || msg.deviceId;
                            if (msg.device && id) setDevices((current) => current.some((d) => (d.friendly_name || d.ieee_address) === id)
                                ? current.map((d) => (d.friendly_name || d.ieee_address) === id ? msg.device! : d)
                                : current);
                            else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'getDevices' }));
                            break;
                        }
                        case 'controlResult': if (!msg.success) showError(`控制失败: ${msg.error || '未知错误'}`); break;
                        case 'error': showError(msg.message || '未知错误'); break;
                    }
                } catch {
                    showError('无法解析服务器消息');
                }
            };
            ws.onerror = () => { setSocketStatus('连接错误'); setConnected(false); };
            ws.onclose = () => {
                if (disposed) return;
                setSocketStatus('已断开');
                setConnected(false);
                if (reconnectRef.current === undefined) reconnectRef.current = window.setTimeout(connect, 3000);
            };
        };
        const showError = (message: string) => {
            setError(message);
            if (errorTimerRef.current !== undefined) window.clearTimeout(errorTimerRef.current);
            errorTimerRef.current = window.setTimeout(() => setError(''), 5000);
        };
        connect();
        const onVisibility = () => {
            if (!document.hidden && socketRef.current?.readyState !== WebSocket.OPEN) connect();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            disposed = true;
            document.removeEventListener('visibilitychange', onVisibility);
            if (reconnectRef.current !== undefined) window.clearTimeout(reconnectRef.current);
            if (errorTimerRef.current !== undefined) window.clearTimeout(errorTimerRef.current);
            socketRef.current?.close();
            socketRef.current = null;
        };
    }, []);

    const send = (type: string, payload?: unknown) => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            setError('WebSocket 未连接');
            return false;
        }
        ws.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
        return true;
    };
    const permitJoin = (enabled: boolean) => send('permitJoin', { value: enabled, time: joinTime || 120 });
    const toggleDevice = (device: Device, state: string) => {
        const deviceId = device.friendly_name || device.ieee_address;
        if (deviceId) send('controlDevice', { deviceId, state });
    };

    return (
        <section className="node-ui-form">
            <div><h1>Zigbee 控制台</h1><p>Zigbee2MQTT 设备与配对管理</p></div>
            <p role="status">WebSocket：{socketStatus}</p>
            {error && <Callout type="warn" title="操作失败">{error}</Callout>}
            <div className="node-ui-grid">
                <Card title="Zigbee 状态"><strong>{zigbeeConnected === undefined ? '-' : zigbeeConnected ? '已连接' : '未连接'}</strong></Card>
                <Card title="协调器 IEEE 地址"><strong>{coordinator}</strong></Card>
                <Card title="配对状态"><strong>{permitStatus}</strong></Card>
            </div>
            <Card title="配对管理">
                <div className="node-ui-form">
                    <Field label="配对窗口（秒）" type="number" min={10} max={600} value={String(joinTime)} onChange={(event) => setJoinTime(Math.min(600, Math.max(10, Number(event.currentTarget.value) || 120)))} />
                    <div className="node-ui-section-heading">
                        <Button variant="primary" disabled={!connected} onClick={() => permitJoin(true)}>开启配对</Button>
                        <Button variant="ghost" disabled={!connected} onClick={() => permitJoin(false)}>关闭配对</Button>
                    </div>
                </div>
            </Card>
            <Card title="设备列表">
                {devices.length === 0 ? <p>暂无设备</p> : <div style={{ overflowX: 'auto' }}><table>
                    <thead><tr><th>地址/ID</th><th>名称</th><th>型号</th><th>类型</th><th>状态</th><th>操作</th></tr></thead>
                    <tbody>{devices.map((device, index) => {
                        const state = device.state?.state === 'ON' || device.state?.state === 'OFF' ? device.state.state
                            : device.state?.power === 'ON' || device.state?.power === 'OFF' ? device.state.power : '';
                        const id = device.friendly_name || device.ieee_address || String(index);
                        return <tr key={id}>
                            <td>{device.ieee_address || ''}</td><td>{device.friendly_name || ''}</td>
                            <td>{device.definition?.model || ''}</td>
                            <td>{device.type === 'Router' ? '路由器' : device.type === 'EndDevice' ? '终端设备' : device.type || '未知'}</td>
                            <td>{state || '未知'}</td>
                            <td><label><input aria-label={`控制 ${device.friendly_name || device.ieee_address || '设备'}`} type="checkbox" checked={state === 'ON'} disabled={!connected} onChange={(event) => toggleDevice(device, event.currentTarget.checked ? 'ON' : 'OFF')} /> 开关</label></td>
                        </tr>;
                    })}</tbody>
                </table></div>}
            </Card>
        </section>
    );
}
