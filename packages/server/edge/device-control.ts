import { edgeRegistry } from './registry';
import { EdgeEnvelope } from './protocol';

export async function callNodeMcp(nodeId: string, name: string, args: any = {}) {
    return edgeRegistry.request(nodeId, {
        protocol: 'mcp',
        action: 'jsonrpc',
        payload: {
            jsonrpc: '2.0',
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            method: 'tools/call',
            params: { name, arguments: args },
        },
    });
}

/** Execute the existing Zigbee control path and publish the resulting state. */
export async function controlEdgeDevice(nodeId: string, deviceId: string, state: string) {
    const result = await callNodeMcp(nodeId, 'zigbee_control_device', { deviceId, state });
    const envelope: EdgeEnvelope = {
        protocol: 'mqtt',
        action: 'publish',
        channel: `node/${nodeId}/devices/${deviceId}/state`,
        payload: { state },
    };
    edgeRegistry.receive(nodeId, envelope);
    return result;
}
