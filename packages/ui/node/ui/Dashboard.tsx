import { useEffect, useState } from 'react';
import { Button } from '@ejunz/ui-next/components/button';
import { Callout } from '@ejunz/ui-next/components/callout';
import { Card } from '@ejunz/ui-next/components/card';

type BridgeStatus = {
    status?: { enabled?: boolean; brokers?: Array<{ connected?: boolean }> };
};

type ZigbeeStatus = { connected?: boolean };

async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json() as Promise<T>;
}

export default function Dashboard() {
    const [bridge, setBridge] = useState<BridgeStatus>();
    const [zigbee, setZigbee] = useState<ZigbeeStatus>();
    const [error, setError] = useState('');

    useEffect(() => {
        let disposed = false;
        const refresh = async () => {
            try {
                const [nextBridge, nextZigbee] = await Promise.all([
                    getJson<BridgeStatus>('/api/mqtt-bridge-config/status'),
                    getJson<ZigbeeStatus>('/zigbee2mqtt/status'),
                ]);
                if (disposed) return;
                setBridge(nextBridge);
                setZigbee(nextZigbee);
                setError('');
            } catch (cause) {
                if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
            }
        };
        void refresh();
        const timer = window.setInterval(() => void refresh(), 5000);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, []);

    const brokers = bridge?.status?.brokers || [];
    const connectedBrokers = brokers.filter((broker) => broker.connected).length;

    return (
        <section className="node-ui-form">
            <div>
                <h1>Node Dashboard</h1>
                <p>MQTT 与 Zigbee2MQTT 运行状态</p>
            </div>
            {error && <Callout type="warn" title="状态读取失败">{error}</Callout>}
            <div className="node-ui-grid">
                <Card title="MQTT Bridge">
                    <strong>{bridge?.status?.enabled ? '已启用' : '已禁用'}</strong>
                </Card>
                <Card title="已连接 Broker">
                    <strong>{connectedBrokers}/{brokers.length}</strong>
                </Card>
                <Card title="Zigbee 状态">
                    <strong>{zigbee?.connected ? '已连接' : '未连接'}</strong>
                </Card>
                <Card title="设备管理">
                    <Button href="/node-ui/console" variant="primary">打开 Zigbee 控制台</Button>
                </Card>
            </div>
        </section>
    );
}
