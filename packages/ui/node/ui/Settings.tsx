import { useCallback, useEffect, useState } from 'react';
import { Button } from '@ejunz/ui-next/components/button';
import { Callout } from '@ejunz/ui-next/components/callout';
import { Card } from '@ejunz/ui-next/components/card';
import { Field } from '@ejunz/ui-next/components/field';

type Broker = {
    name: string;
    mqttUrl: string;
    baseTopic: string;
    username: string;
    password: string;
    enabled: boolean;
    reconnect: { enabled: boolean; period: number };
};

type Config = {
    enabled: boolean;
    reconnect: { enabled: boolean; period: number };
    brokers: Broker[];
};

type SchemaProperty = {
    type?: string;
    description?: string;
    default?: unknown;
    required?: boolean;
    properties?: Record<string, SchemaProperty>;
    items?: SchemaProperty;
};
type Status = { enabled?: boolean; brokers?: Array<Record<string, unknown> & { name: string; connected?: boolean }> };

async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json() as Promise<T>;
}

function TextField({ label, value, type = 'text', onChange }: {
    label: string;
    value: string | number;
    type?: string;
    onChange: (value: string) => void;
}) {
    return <Field label={label} type={type} value={String(value ?? '')} onChange={(event) => onChange(event.currentTarget.value)} />;
}

function CheckField({ label, checked, onChange }: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label className="node-ui-check">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
            <span>{label}</span>
        </label>
    );
}

function SchemaList({ schema, path = '' }: { schema: Record<string, SchemaProperty>; path?: string }) {
    return (
        <ul>
            {Object.entries(schema).map(([key, property]) => {
                const name = path ? `${path}.${key}` : key;
                return (
                    <li key={name}>
                        <strong>{name}</strong> <code>{property.type || 'object'}</code>
                        {property.required && <span>（必填）</span>}
                        {property.description && <p>{property.description}</p>}
                        {property.default !== undefined && <p>默认值: <code>{JSON.stringify(property.default)}</code></p>}
                        {property.properties && <SchemaList schema={property.properties} path={name} />}
                        {property.items && <p>数组项类型: <code>{property.items.type || 'object'}</code></p>}
                    </li>
                );
            })}
        </ul>
    );
}

export default function Settings() {
    const [config, setConfig] = useState<Config | null>(null);
    const [status, setStatus] = useState<Status>();
    const [schema, setSchema] = useState<Record<string, SchemaProperty>>();
    const [rawJson, setRawJson] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const loadStatus = useCallback(async () => {
        const result = await getJson<{ status?: Status }>('/api/mqtt-bridge-config/status');
        setStatus(result.status);
    }, []);

    const loadConfig = useCallback(async () => {
        const result = await getJson<{ config: Config }>('/api/mqtt-bridge-config');
        setConfig(result.config);
        setRawJson(JSON.stringify(result.config, null, 2));
    }, []);

    useEffect(() => {
        let disposed = false;
        Promise.all([
            getJson<{ config: Config }>('/api/mqtt-bridge-config'),
            getJson<{ status?: Status }>('/api/mqtt-bridge-config/status'),
            getJson<{ schema?: Record<string, SchemaProperty> }>('/api/mqtt-bridge-config/schema'),
        ]).then(([configResult, statusResult, schemaResult]) => {
            if (disposed) return;
            setConfig(configResult.config);
            setRawJson(JSON.stringify(configResult.config, null, 2));
            setStatus(statusResult.status);
            setSchema(schemaResult.schema);
            setError('');
        }).catch((cause) => {
            if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => {
            if (!disposed) setLoading(false);
        });
        const timer = window.setInterval(() => {
            void loadStatus().catch((cause) => {
                if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
            });
        }, 5000);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [loadStatus]);

    const updateConfig = (patch: Partial<Config>) => {
        setConfig((current) => current ? { ...current, ...patch } : current);
    };
    const updateReconnect = (patch: Partial<Config['reconnect']>) => {
        setConfig((current) => current ? { ...current, reconnect: { ...current.reconnect, ...patch } } : current);
    };
    const updateBroker = (index: number, patch: Partial<Broker>) => {
        setConfig((current) => current ? {
            ...current,
            brokers: current.brokers.map((broker, i) => i === index ? { ...broker, ...patch } : broker),
        } : current);
    };
    const addBroker = () => {
        setConfig((current) => current ? {
            ...current,
            brokers: [...current.brokers, {
                name: `broker-${Date.now()}`,
                mqttUrl: 'mqtt://localhost:1883',
                baseTopic: 'zigbee2mqtt',
                username: '',
                password: '',
                enabled: true,
                reconnect: { enabled: true, period: 5000 },
            }],
        } : current);
    };
    const removeBroker = (index: number) => {
        setConfig((current) => current ? { ...current, brokers: current.brokers.filter((_, i) => i !== index) } : current);
    };

    const postConfig = async (path: string, value: Config) => {
        const response = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
        return body;
    };
    const runAction = async (action: () => Promise<void>, message: string) => {
        setSaving(true);
        setError('');
        setNotice('');
        try {
            await action();
            setNotice(message);
            await loadStatus();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setSaving(false);
        }
    };
    const saveConfig = () => {
        if (!config) return;
        void runAction(async () => {
            await postConfig('/api/mqtt-bridge-config', config);
            await loadConfig();
        }, '配置已保存');
    };
    const reloadFormConfig = () => {
        if (!config) return;
        void runAction(async () => {
            await postConfig('/api/mqtt-bridge-config/reload', config);
        }, '配置已保存并重新加载');
    };
    const loadRawJson = () => {
        try {
            const parsed = JSON.parse(rawJson) as Config;
            setConfig(parsed);
            setError('');
            setNotice('JSON 已载入表单');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };
    const reloadRawJson = () => {
        let parsed: Config;
        try {
            parsed = JSON.parse(rawJson) as Config;
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return;
        }
        void runAction(async () => {
            await postConfig('/api/mqtt-bridge-config/reload', parsed);
            setConfig(parsed);
        }, 'JSON 配置已保存并重新加载');
    };

    if (loading) return <p>加载中...</p>;
    if (!config) return <Callout type="warn" title="配置读取失败">{error || '没有可用的 MQTT Bridge 配置。'}</Callout>;

    return (
        <section className="node-ui-form">
            <header>
                <h1>配置</h1>
                <p>配置本地 MQTT Bridge 与上游 Broker。</p>
            </header>
            {error && <Callout type="warn" title="操作失败">{error}</Callout>}
            {notice && <p role="status">{notice}</p>}

            <Card title="MQTT Bridge">
                <div className="node-ui-form">
                    <CheckField label="启用 MQTT Bridge" checked={config.enabled} onChange={(enabled) => updateConfig({ enabled })} />
                    <CheckField label="启用自动重连" checked={config.reconnect.enabled} onChange={(enabled) => updateReconnect({ enabled })} />
                    <TextField label="重连间隔（毫秒）" type="number" value={config.reconnect.period} onChange={(value) => updateReconnect({ period: Number(value) || 1000 })} />
                    <div className="node-ui-grid">
                        <Card title="服务状态">{status?.enabled ? '已启用' : '已禁用'}</Card>
                        <Card title="已连接 Broker">{(status?.brokers || []).filter((broker) => broker.connected).length}/{status?.brokers?.length || 0}</Card>
                    </div>
                </div>
            </Card>

            <section aria-labelledby="schema-heading">
                <h2 id="schema-heading">声明配置结构</h2>
                {schema ? <SchemaList schema={schema} /> : <p>未能读取配置结构。</p>}
            </section>

            <Card title="已存储配置">
                <pre><code>{JSON.stringify(config, null, 2)}</code></pre>
                <Button disabled={saving} onClick={saveConfig}>保存配置</Button>
            </Card>

            <Card title="原始 JSON 编辑器">
                <div className="node-ui-form">
                    <label htmlFor="mqtt-config-json">配置 JSON</label>
                    <textarea id="mqtt-config-json" rows={18} value={rawJson} onChange={(event) => setRawJson(event.currentTarget.value)} />
                    <div className="node-ui-section-heading">
                        <Button onClick={loadRawJson}>载入到表单</Button>
                        <Button onClick={() => void loadConfig()}>重置为已存储配置</Button>
                        <Button disabled={saving} onClick={() => void runAction(async () => {
                            const parsed = JSON.parse(rawJson) as Config;
                            await postConfig('/api/mqtt-bridge-config', parsed);
                            setConfig(parsed);
                            await loadConfig();
                        }, 'JSON 配置已保存')}>保存 JSON</Button>
                        <Button variant="primary" disabled={saving} onClick={reloadRawJson}>保存并重载 JSON</Button>
                    </div>
                </div>
            </Card>

            <div className="node-ui-form">
                <div className="node-ui-section-heading">
                    <h2>Broker 列表</h2>
                    <Button onClick={addBroker}>添加 Broker</Button>
                </div>
                {config.brokers.length === 0 && <p>暂无配置的 Broker</p>}
                {config.brokers.map((broker, index) => {
                    const connection = status?.brokers?.find((item) => item.name === broker.name);
                    return (
                        <Card key={broker.name || index} title={broker.name || `Broker ${index + 1}`}>
                            <div className="node-ui-form">
                                <p role="status">连接状态：{connection?.connected ? '已连接' : '未连接'}</p>
                                <TextField label="Broker 名称" value={broker.name} onChange={(name) => updateBroker(index, { name })} />
                                <TextField label="MQTT 连接地址" value={broker.mqttUrl} onChange={(mqttUrl) => updateBroker(index, { mqttUrl })} />
                                <TextField label="基础主题" value={broker.baseTopic} onChange={(baseTopic) => updateBroker(index, { baseTopic })} />
                                <TextField label="用户名" value={broker.username} onChange={(username) => updateBroker(index, { username })} />
                                <TextField label="密码" type="password" value={broker.password} onChange={(password) => updateBroker(index, { password })} />
                                <CheckField label="启用此 Broker" checked={broker.enabled} onChange={(enabled) => updateBroker(index, { enabled })} />
                                <CheckField label="Broker 自动重连" checked={broker.reconnect?.enabled ?? true} onChange={(enabled) => updateBroker(index, { reconnect: { ...broker.reconnect, enabled } })} />
                                <TextField label="Broker 重连间隔（毫秒）" type="number" value={broker.reconnect?.period ?? 5000} onChange={(value) => updateBroker(index, { reconnect: { ...broker.reconnect, period: Number(value) || 1000 } })} />
                                {connection && <details><summary>连接详情</summary><pre><code>{JSON.stringify(connection, null, 2)}</code></pre></details>}
                                <Button variant="ghost" onClick={() => removeBroker(index)}>删除 Broker</Button>
                            </div>
                        </Card>
                    );
                })}
            </div>

            <Button variant="primary" disabled={saving} onClick={reloadFormConfig}>{saving ? '保存中...' : '保存并重载配置'}</Button>
        </section>
    );
}
