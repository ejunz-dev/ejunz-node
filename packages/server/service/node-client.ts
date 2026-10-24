// @ts-nocheck
import os from 'node:os';
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config, saveConfig } from '../config';
import { endpointWithToken } from '@ejunz/protocol';

const logger = new Logger('node-client');

type EdgeEnvelope = {
    protocol: string;
    action: string;
    channel?: string;
    payload?: any;
    nodeId?: string | number;
    domainId?: string;
    traceId?: string;
    token?: string;
    qos?: 0 | 1 | 2;
    direction?: 'inbound' | 'outbound';
    meta?: Record<string, any>;
};

interface EdgeBridgeHandle {
    send: (envelope: EdgeEnvelope) => void;
    dispose: () => void;
}

const EDGE_EVENT_INBOUND = 'edge/ws/inbound';
const EDGE_EVENT_OUTBOUND = 'edge/ws/outbound';

let cachedNodeId: string | null = null;
let edgeBridgeHandle: EdgeBridgeHandle | null = null;
// 防重复处理：记录最近处理的命令（基于 traceId 或 channel+payload）
const processedCommands = new Map<string, number>();

function getResolvedNodeId(): string {
    if (!cachedNodeId) cachedNodeId = resolveNodeId();
    return cachedNodeId;
}

function generateTraceId(prefix = 'edge'): string {
    return `${prefix}-${getResolvedNodeId()}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function emitEdgeEvent(ctx: Context | undefined, direction: 'inbound' | 'outbound', envelope: EdgeEnvelope) {
    if (!ctx || typeof ctx.parallel !== 'function') return;
    const eventName = direction === 'inbound' ? EDGE_EVENT_INBOUND : EDGE_EVENT_OUTBOUND;
    try {
        ctx.parallel(eventName, envelope);
    } catch (e) {
        logger.debug?.('emitEdgeEvent failed: %s', (e as Error).message);
    }
}

function prepareEnvelopeForSend(envelope: EdgeEnvelope, direction: 'outbound' | 'inbound' = 'outbound'): EdgeEnvelope {
    const prepared: EdgeEnvelope = {
        traceId: envelope.traceId || generateTraceId(envelope.protocol || 'edge'),
        ...envelope,
        direction,
    };
    // 不再自动添加 nodeId，由上游从 token 或其他方式识别
    prepared.meta = prepared.meta || {};
    return prepared;
}

function sendEdgeEnvelope(envelope: EdgeEnvelope) {
    if (!edgeBridgeHandle) {
        logger.debug?.('Edge WS bridge not ready, drop envelope: %s/%s', envelope.protocol, envelope.action);
        return;
    }
    edgeBridgeHandle.send(envelope);
}

// 连接到本地MQTT Broker（用于zigbee2mqtt控制，默认 localhost:1883）
function connectToLocalMqttBroker(ctx?: Context) {
    if (!ctx) return;
    
    // 使用本地broker（默认 localhost:1883，无需配置）
    const mqttUrl = 'mqtt://localhost:1883';
    const z2mConfig = (config as any).zigbee2mqtt || {};
    const baseTopic = z2mConfig.baseTopic || 'zigbee2mqtt';
    
    logger.info('连接到本地MQTT Broker: %s', mqttUrl);
    
    try {
        ctx.inject(['zigbee2mqtt'], async (c) => {
            const z2mSvc = c.zigbee2mqtt;
            if (z2mSvc?.state?.connected) {
                logger.debug('Zigbee2MQTT MQTT 连接已就绪');
                return;
            }
            if (z2mSvc && typeof z2mSvc.connectToBroker === 'function') {
                await z2mSvc.connectToBroker(mqttUrl, { baseTopic });
                logger.info('已连接到本地MQTT Broker: %s', mqttUrl);
            }
        });
    } catch (e) {
        logger.error('连接本地MQTT Broker失败: %s', (e as Error).message);
    }
}

// 注意：远程MQTT Broker连接已移除，所有通信通过Edge WebSocket进行

// 检测设备是否有多个端点（多开关）
function detectEndpoints(device: any): string[] {
    const endpoints: string[] = [];
    const deviceId = device.friendly_name || device.ieee_address;
    
    // 检查 definition.exposes 中的端点信息
    if (device.definition?.exposes) {
        const exposes = device.definition.exposes;
        for (const expose of exposes) {
            // 查找带有 endpoint 属性的开关
            if (expose.endpoint) {
                endpoints.push(expose.endpoint);
                logger.debug('[detectEndpoints] %s: 在 exposes 中找到端点: %s', deviceId, expose.endpoint);
            }
            // 查找嵌套的 features
            if (expose.features && Array.isArray(expose.features)) {
                for (const feature of expose.features) {
                    if (feature.endpoint && !endpoints.includes(feature.endpoint)) {
                        endpoints.push(feature.endpoint);
                        logger.debug('[detectEndpoints] %s: 在 features 中找到端点: %s', deviceId, feature.endpoint);
                    }
                }
            }
        }
    }
    
    // 检查设备状态中的 state_l1, state_l2 等属性
    if (device.state || device.state === undefined) {
        const state = device.state || {};
        const stateKeys = Object.keys(state);
        for (const key of stateKeys) {
            // 匹配 state_l1, state_l2, state_l3 等模式
            const match = key.match(/^state_l(\d+)$/);
            if (match) {
                const endpoint = `l${match[1]}`;
                if (!endpoints.includes(endpoint)) {
                    endpoints.push(endpoint);
                    logger.debug('[detectEndpoints] %s: 在 state 中找到端点: %s', deviceId, endpoint);
                }
            }
        }
    }
    
    // 如果没有找到端点，返回空数组
    if (endpoints.length > 0) {
        logger.info('[detectEndpoints] %s: 检测到 %d 个端点: %o', deviceId, endpoints.length, endpoints);
    }
    return endpoints.sort();
}

// 为多端点设备创建虚拟子设备
function expandMultiEndpointDevice(device: any, endpoints: string[]): any[] {
    const devices: any[] = [];
    const baseId = device.friendly_name || device.ieee_address;
    
    for (const endpoint of endpoints) {
        const endpointDevice = {
            ...device,
            friendly_name: `${baseId}_${endpoint}`,
            ieee_address: device.ieee_address,
            endpoint: endpoint,
            originalDeviceId: baseId,
            isEndpointDevice: true,
            // 提取该端点的状态
            state: extractEndpointState(device.state, endpoint),
        };
        devices.push(endpointDevice);
    }
    
    return devices;
}

// 提取特定端点的状态
function extractEndpointState(state: any, endpoint: string): any {
    if (!state) return {};
    
    const endpointState: any = {};
    const stateKey = `state_${endpoint}`;
    
    // 如果有 state_l1, state_l2 等属性，提取该端点的状态
    if (state[stateKey] !== undefined) {
        endpointState.state = state[stateKey];
    }
    
    // 复制其他可能相关的属性（如 linkquality 等）
    if (state.linkquality !== undefined) {
        endpointState.linkquality = state.linkquality;
    }
    
    return endpointState;
}

// 发送设备发现消息
async function sendDeviceDiscovery(ctx: Context, client: any, nodeId: number) {
    try {
        await ctx.inject(['zigbee2mqtt'], async (c) => {
            const z2mSvc = c.zigbee2mqtt;
            if (!z2mSvc) {
                logger.warn('Zigbee2MQTT 服务未初始化，无法发送设备发现消息');
                return;
            }
            
            const devices = await z2mSvc.listDevices();
            logger.info('准备发送设备发现消息，共 %d 个设备', devices.length);
            
            // 转换设备格式，展开多端点设备
            const deviceList: any[] = [];
            for (const d of devices) {
                // 检测设备是否有多个端点
                const endpoints = detectEndpoints(d);
                
                if (endpoints.length > 0) {
                    // 多端点设备：为每个端点创建一个虚拟设备
                    logger.info('检测到多端点设备: %s，端点: %o', d.friendly_name || d.ieee_address, endpoints);
                    const endpointDevices = expandMultiEndpointDevice(d, endpoints);
                    
                    for (const ed of endpointDevices) {
                        const deviceId = ed.friendly_name || ed.ieee_address;
                        const state: any = {};
                        
                        // 从设备信息中提取状态
                        if (ed.state) {
                            Object.assign(state, ed.state);
                        }
                        
                        // 构建能力列表
                        const capabilities: string[] = [];
                        if (ed.supportsOnOff !== false) {
                            capabilities.push('on', 'off');
                        }
                        if (ed.state?.brightness !== undefined) {
                            capabilities.push('brightness');
                        }
                        if (ed.state?.color !== undefined) {
                            capabilities.push('color');
                        }
                        
                        deviceList.push({
                            id: deviceId,
                            name: ed.friendly_name || deviceId,
                            type: ed.type === 'Router' ? 'router' : (ed.type === 'EndDevice' ? 'enddevice' : 'unknown'),
                            manufacturer: ed.definition?.vendor || ed.vendor || '未知厂商',
                            model: ed.definition?.model || ed.model || '未知型号',
                            state: state,
                            capabilities: capabilities.length > 0 ? capabilities : ['on', 'off'],
                            endpoint: ed.endpoint,
                            originalDeviceId: ed.originalDeviceId,
                        });
                    }
                } else {
                    // 单端点设备：正常处理
                    const deviceId = d.friendly_name || d.ieee_address;
                    const state: any = {};
                    
                    // 从设备信息中提取状态
                    if (d.state) {
                        Object.assign(state, d.state);
                    }
                    
                    // 构建能力列表
                    const capabilities: string[] = [];
                    if (d.supportsOnOff !== false) {
                        capabilities.push('on', 'off');
                    }
                    if (d.state?.brightness !== undefined) {
                        capabilities.push('brightness');
                    }
                    if (d.state?.color !== undefined) {
                        capabilities.push('color');
                    }
                    
                    deviceList.push({
                        id: deviceId,
                        name: d.friendly_name || deviceId,
                        type: d.type === 'Router' ? 'router' : (d.type === 'EndDevice' ? 'enddevice' : 'unknown'),
                        manufacturer: d.definition?.vendor || d.vendor || '未知厂商',
                        model: d.definition?.model || d.model || '未知型号',
                        state: state,
                        capabilities: capabilities.length > 0 ? capabilities : ['on', 'off'],
                    });
                }
            }
            
            const topic = `node/${nodeId}/devices/discover`;
            const payload = JSON.stringify({ devices: deviceList });
            
            client.publish(topic, payload, (err: Error | null) => {
                if (err) {
                    logger.error('发布设备发现消息失败: %s', err.message);
                } else {
                    logger.success('设备发现消息已发送: %s (共 %d 个设备)', topic, deviceList.length);
                }
            });
        });
    } catch (e) {
        logger.error('发送设备发现消息失败: %s', (e as Error).message);
        throw e;
    }
}

// 执行设备控制指令
async function executeDeviceControl(ctx: Context, deviceId: string, command: any) {
    try {
        await ctx.inject(['zigbee2mqtt'], async (c) => {
            const z2mSvc = c.zigbee2mqtt;
            if (!z2mSvc || typeof z2mSvc.setDeviceState !== 'function') {
                logger.error('Zigbee2MQTT 服务未初始化或不支持设备控制');
                return;
            }
            
            // 检查 deviceId 是否包含端点信息（格式：deviceName_l1）
            let targetDeviceId = deviceId;
            let endpoint: string | undefined;
            
            const endpointMatch = deviceId.match(/^(.+)_(l\d+)$/);
            if (endpointMatch) {
                // 提取原始设备ID和端点
                targetDeviceId = endpointMatch[1];
                endpoint = endpointMatch[2];
                logger.info('检测到端点控制: 设备=%s, 端点=%s', targetDeviceId, endpoint);
            }
            
            // 构建控制命令
            let controlCommand = { ...command };
            if (endpoint) {
                // 对于多端点设备，需要使用特定的状态键
                // 例如：{ state_l1: "ON" } 而不是 { state: "ON" }
                if (command.state !== undefined) {
                    controlCommand = { [`state_${endpoint}`]: command.state };
                    // 删除通用的 state 属性
                    delete controlCommand.state;
                }
            }
            
            logger.info('执行设备控制: %s, 命令: %o', targetDeviceId, controlCommand);
            await z2mSvc.setDeviceState(targetDeviceId, controlCommand);
            logger.success('设备控制执行成功: %s', deviceId);
        });
    } catch (e) {
        logger.error('执行设备控制失败: %s', (e as Error).message);
        throw e;
    }
}

// 更新设备状态
async function updateDeviceState(ctx: Context, client: any, nodeId: number, deviceId: string, state: any) {
    try {
        const topic = `node/${nodeId}/devices/${deviceId}/state`;
        const payload = JSON.stringify(state);
        
        client.publish(topic, payload, (err: Error | null) => {
            if (err) {
                logger.error('发布状态更新失败: %s', err.message);
            } else {
                logger.debug('状态更新已发送: %s', topic);
            }
        });
    } catch (e) {
        logger.error('更新设备状态失败: %s', (e as Error).message);
    }
}

// 设置设备状态监听器，监听 zigbee2mqtt 设备状态并通过 Edge WS 上报
function setupDeviceStateListener(ctx?: Context) {
    if (!ctx) return () => {};
    const nodeId = getResolvedNodeId();
    const baseTopic = ((config as any).zigbee2mqtt?.baseTopic || 'zigbee2mqtt').replace(/\/+$/, '');

    const forwardState = (deviceId: string, state: any) => {
        if (!deviceId) return;
        const normalizedState = state ?? {};
        sendEdgeEnvelope({
            protocol: 'mqtt',
            action: 'publish',
            channel: `node/${nodeId}/devices/${deviceId}/state`,
            payload: normalizedState,
        });
        sendEdgeEnvelope({
            protocol: 'mqtt',
            action: 'publish',
            channel: `${baseTopic}/${deviceId}`,
            payload: normalizedState,
            meta: { mirrored: true },
        });
    };

    const dispose = ctx.on?.('zigbee2mqtt/deviceState' as any, (deviceId: string, state: any) => {
        forwardState(deviceId, state);
    });

    logger.info('已设置 Zigbee 设备状态上报监听');

    return typeof dispose === 'function' ? dispose : () => {};
}

function resolveEdgeEndpoint(): string {
    const wsConfig = (config as any).ws || {};
    const explicit = (wsConfig.endpoint || '').trim();
    if (explicit) return explicit;
    // Node 只连接 Edge；上游 Ejunz endpoint 由 Edge 模式负责。
    logger.warn('未配置 ws.endpoint，请设置 Edge WebSocket endpoint');
    return '';
}

function extractDeviceIdFromChannel(channel: string): string | null {
    if (!channel) return null;
    const normalized = channel.replace(/^\/+|\/+$/g, '');
    
    // 匹配 node/<任意nodeId>/devices/<deviceId>/set 或 node/<任意nodeId>/devices/<deviceId>
    const nodeDevicesMatch = normalized.match(/^node\/[^/]+\/devices\/([^/]+)(?:\/set)?$/);
    if (nodeDevicesMatch) {
        return nodeDevicesMatch[1] || null;
    }
    
    // 匹配 zigbee2mqtt/<deviceId>/set 或 zigbee2mqtt/<deviceId>
    const baseTopic = ((config as any).zigbee2mqtt?.baseTopic || 'zigbee2mqtt').replace(/\/+$/, '');
    if (normalized.startsWith(`${baseTopic}/`)) {
        const rest = normalized.slice(baseTopic.length + 1);
        const [deviceId] = rest.split('/');
        // 排除 bridge 相关的 topic
        if (deviceId && deviceId !== 'bridge') {
            return deviceId || null;
        }
    }
    
    return null;
}

async function handleInboundMqttEnvelope(ctx: Context | undefined, envelope: EdgeEnvelope) {
    if (!ctx) return;
    if (envelope.action !== 'publish') return;
    const channel = envelope.channel || '';
    const deviceId = extractDeviceIdFromChannel(channel);
    if (!deviceId) {
        logger.debug?.('无法解析 MQTT channel: %s', channel);
        return;
    }
    let payload = envelope.payload;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch {
            payload = { value: payload };
        }
    }
    if (payload === undefined || payload === null) payload = {};

    // 命令格式转换：将 on: true/false 转换为 state: "ON"/"OFF"
    if (typeof payload.on === 'boolean' && payload.state === undefined) {
        const onValue = payload.on;
        payload.state = onValue ? 'ON' : 'OFF';
        delete payload.on;
        logger.debug?.('命令格式转换: on=%s -> state=%s', onValue ? 'true' : 'false', payload.state);
    }

    // 防重复处理：检查是否在最近 2 秒内处理过相同的命令
    const commandKey = envelope.traceId || `${channel}:${JSON.stringify(payload)}`;
    const now = Date.now();
    const lastProcessed = processedCommands.get(commandKey);
    if (lastProcessed && (now - lastProcessed) < 2000) {
        logger.debug?.('跳过重复命令: %s (距离上次处理 %dms)', commandKey, now - lastProcessed);
        return;
    }
    processedCommands.set(commandKey, now);
    
    // 清理过期的记录（超过 10 秒）
    for (const [key, timestamp] of processedCommands.entries()) {
        if (now - timestamp > 10000) {
            processedCommands.delete(key);
        }
    }

    try {
        await executeDeviceControl(ctx, deviceId, payload);
        sendEdgeEnvelope({
            protocol: 'mqtt',
            action: 'publish',
            channel: `node/${getResolvedNodeId()}/devices/${deviceId}/ack`,
            payload: { ok: 1, timestamp: Date.now(), channel },
            traceId: envelope.traceId,
            meta: { source: 'node', type: 'ack' },
        });
    } catch (e) {
        sendEdgeEnvelope({
            protocol: 'mqtt',
            action: 'error',
            channel,
            payload: { message: (e as Error).message, deviceId },
            traceId: envelope.traceId,
        });
    }
}

function startEdgeEnvelopeBridge(ctx?: Context) {
    if (!ctx) return () => {};
    if (!resolveEdgeEndpoint()) {
        logger.warn('未配置 ws.endpoint，跳过 Edge WS 信道');
        return () => {};
    }

    let WS: any;
    try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        WS = require('ws');
    } catch (e) {
        logger.error('缺少 ws 依赖，请先安装：yarn add -W ws');
        return () => {};
    }

    let ws: any = null;
    let stopped = false;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let retryDelay = 5000;
    let heartbeatInterval: NodeJS.Timeout | null = null;
    const queue: EdgeEnvelope[] = [];
    const maxQueueSize = 200;

    const flushQueue = () => {
        if (!ws || ws.readyState !== WS.OPEN) return;
        while (queue.length) {
            const item = queue.shift();
            if (!item) break;
            try {
                ws.send(JSON.stringify(item));
                emitEdgeEvent(ctx, 'outbound', item);
            } catch (e) {
                queue.unshift(item);
                logger.warn('发送队列消息失败: %s', (e as Error).message);
                break;
            }
        }
    };

    const enqueueEnvelope = (envelope: EdgeEnvelope) => {
        const prepared = prepareEnvelopeForSend(envelope, 'outbound');
        if (ws && ws.readyState === WS.OPEN) {
            try {
                ws.send(JSON.stringify(prepared));
                emitEdgeEvent(ctx, 'outbound', prepared);
                return;
            } catch (e) {
                logger.warn('发送 Envelope 失败，将进入队列: %s', (e as Error).message);
            }
        }
        queue.push(prepared);
        if (queue.length > maxQueueSize) queue.shift();
    };

    const sendHandshake = () => {
        if (!ws || ws.readyState !== WS.OPEN) return;
        try {
            ws.send(JSON.stringify({
                type: 'init',
                nodeId: getResolvedNodeId(),
                host: resolveAdvertisedHost(),
                port: resolveAdvertisedPort(),
            }));
        } catch (error) {
            logger.warn('发送 Edge Node 握手失败: %s', (error as Error).message);
        }
    };

    const handleInboundMessage = async (data: any) => {
        let text: string;
        if (typeof data === 'string') text = data;
        else if (Buffer.isBuffer(data)) text = data.toString('utf8');
        else text = String(data);
        let parsed: any;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            logger.warn('Edge WS 收到非法 JSON: %s', (e as Error).message);
            return;
        }
        if (parsed?.type === 'edge/auth_required') {
            logger.warn('Edge 需要授权（node=%s），请打开：%s', parsed.nodeId || getResolvedNodeId(), parsed.authUrl || '');
            return;
        }
        if (parsed?.type === 'edge/auth_success' && parsed.token) {
            const wsConfig = (config as any).ws || ((config as any).ws = {});
            wsConfig.token = String(parsed.token);
            if (parsed.wsEndpoint) {
                try {
                    const url = new URL(String(parsed.wsEndpoint));
                    url.searchParams.delete('token');
                    wsConfig.endpoint = url.toString();
                } catch { /* keep the configured endpoint */ }
            }
            saveConfig();
            logger.success('Edge 授权成功，Token 已保存；准备使用 Token 重连');
            setTimeout(() => { try { ws?.close(4001, 'authorized'); } catch {} }, 50);
            return;
        }
        if (parsed?.type === 'edge/auth_expired' || parsed?.type === 'edge/auth_revoked') {
            const wsConfig = (config as any).ws || ((config as any).ws = {});
            wsConfig.token = '';
            saveConfig();
            logger.warn('Edge Token 已失效，需要重新授权');
            return;
        }
        if (!parsed.protocol) {
            logger.debug?.('忽略未知消息: %s', text);
            return;
        }
        const envelope: EdgeEnvelope = parsed;
        envelope.direction = 'inbound';
        // 不再自动设置 nodeId，由上游从 token 或其他方式识别
        emitEdgeEvent(ctx, 'inbound', envelope);
        if (envelope.protocol === 'mqtt') await handleInboundMqttEnvelope(ctx, envelope);
        else logger.debug?.('未知协议 Envelope: %s', envelope.protocol);
    };

    const stopHeartbeat = () => {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    };

    const startHeartbeat = () => {
        if (heartbeatInterval) return;
        heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WS.OPEN) {
                try { ws.ping?.(); } catch {}
            }
        }, 30000);
    };

    const scheduleReconnect = () => {
        if (stopped) return;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, retryDelay);
        logger.info('Edge WS 将在 %d 秒后尝试重连', Math.round(retryDelay / 1000));
        retryDelay = Math.min(retryDelay * 1.5, 30000);
    };

    const connect = () => {
        if (stopped) return;
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) return;
        const endpoint = resolveEdgeEndpoint();
        if (!endpoint) {
            logger.warn('未配置 ws.endpoint，跳过 Edge WS 信道');
            return;
        }
        const socketEndpoint = endpointWithToken(endpoint, String((config as any).ws?.token || ''));
        logger.info('尝试连接 Edge WS: %s', socketEndpoint.replace(/([?&]token=)[^&]+/i, '$1***'));
        try {
            ws = new WS(socketEndpoint, { perMessageDeflate: false, handshakeTimeout: 20000 });
        } catch (e) {
            logger.error('Edge WS 连接创建失败: %s', (e as Error).message);
            scheduleReconnect();
            return;
        }

        ws.on('open', () => {
            logger.success('Edge WS 连接成功: %s', socketEndpoint.replace(/([?&]token=)[^&]+/i, '$1***'));
            retryDelay = 5000;
            startHeartbeat();
            sendHandshake();
            if (String((config as any).ws?.token || '')) flushQueue();
        });

        ws.on('message', (data: any) => {
            handleInboundMessage(data).catch((err) => {
                logger.warn('处理 Edge WS 消息失败: %s', err.message);
            });
        });

        ws.on('close', (code: number, reason: Buffer) => {
            logger.warn('Edge WS 连接关闭 (%s): %s', code, reason?.toString?.() || '');
            ws = null;
            stopHeartbeat();
            if (!stopped) scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            logger.warn('Edge WS 错误: %s', err.message);
        });
    };

    connect();

    const handle: EdgeBridgeHandle = {
        send: enqueueEnvelope,
        dispose: () => {
            stopped = true;
            stopHeartbeat();
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (ws) {
                try { ws.close(); } catch { /* ignore */ }
                ws = null;
            }
        },
    };

    edgeBridgeHandle = handle;

    return () => {
        if (edgeBridgeHandle === handle) edgeBridgeHandle = null;
        handle.dispose();
    };
}

function normalizeNodeUpstream(target: string): string | null {
    if (!target) return null;
    let value = String(target).trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) {
        const url = new URL(value);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const path = url.pathname.replace(/\/+$/, '');
        if (!path || path === '') url.pathname = '/node/conn';
        else if (!/\/node\/conn$/i.test(path)) url.pathname = `${path}/node/conn`;
        return url.toString();
    }
    if (/^wss?:\/\//i.test(value)) {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, '');
        if (!path || path === '') url.pathname = '/node/conn';
        else if (!/\/node\/conn$/i.test(path)) url.pathname = `${path}/node/conn`;
        return url.toString();
    }
    if (!value.includes('://')) {
        return normalizeNodeUpstream(`ws://${value}`);
    }
    try {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, '');
        if (!path || path === '') url.pathname = '/node/conn';
        else if (!/\/node\/conn$/i.test(path)) url.pathname = `${path}/node/conn`;
        return url.toString();
    } catch (e) {
        return null;
    }
}

export function resolveNodeId(): string {
    const explicit = ((config as any).nodeId || process.env.NODE_ID || '').toString().trim();
    if (explicit) return explicit;
    const host = os.hostname();
    if (host) return host;
    return `node-${process.pid}`;
}

function resolveAdvertisedHost(): string {
    const candidates = [
        process.env.NODE_PUBLIC_HOST,
        (config as any).publicHost,
        (config as any).advertiseHost,
        (config as any).host,
        os.hostname(),
        'localhost',
    ];
    for (const candidate of candidates) {
        if (candidate && String(candidate).trim()) return String(candidate).trim();
    }
    return 'localhost';
}

function resolveAdvertisedPort(): number {
    const candidates = [
        process.env.NODE_PUBLIC_PORT,
        (config as any).publicPort,
        (config as any).advertisePort,
        config.port,
        5284,
    ];
    for (const candidate of candidates) {
        const num = Number(candidate);
        if (!Number.isNaN(num) && num > 0) return num;
    }
    return 5284;
}

function startNodeConnecting(ctx?: Context) {
    connectToLocalMqttBroker(ctx);
    const disposeEdge = startEdgeEnvelopeBridge(ctx);
    const disposeState = setupDeviceStateListener(ctx);
    return () => {
        try { disposeEdge?.(); } catch { /* ignore */ }
        try { disposeState?.(); } catch { /* ignore */ }
    };
}

export async function apply(ctx: Context) {
    startNodeConnecting(ctx);
}

