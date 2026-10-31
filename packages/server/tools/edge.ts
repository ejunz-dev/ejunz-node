import { Executor } from '@ejunz/framework';
import { Context } from 'cordis';
import Schema from 'schemastery';
import { edgeRegistry, EdgeNodeRecord } from '../model/edge-registry';

export const inject = ['server'];

export const EdgeStatusSchema = Schema.object({}).description('Read Edge service, upstream connection, and node status.');
export const EdgeListNodesSchema = Schema.object({}).description('List authorized Edge nodes and their connection status.');
export const EdgeListDevicesSchema = Schema.object({
    nodeId: Schema.string().required().description('Edge node id whose reported devices should be listed.'),
}).description('List devices and their latest reported state for one Edge node.');
export const ZigbeeControlDeviceSchema = Schema.object({
    nodeId: Schema.string().required().description('Edge node that owns the Zigbee device.'),
    deviceId: Schema.string().required().description('Zigbee device id or friendly name.'),
    state: Schema.union(['ON', 'OFF', 'TOGGLE'] as const).required().description('Desired switch action.'),
}).description(
    'Control a Zigbee switch. Call only when the user explicitly asks to turn a device on, off, or toggle it; execution also requires user approval.',
);

class EdgeStatusExecutor extends Executor<Context, Record<string, never>> {
    async execute() {
        const args = this.args as Record<string, unknown>;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
        const extra = Object.keys(args)[0];
        if (extra) throw new Error(`Unexpected argument: ${extra}`);
        EdgeStatusSchema(args);

        const upstream = (global as any).__edge_upstream;
        const nodes = edgeRegistry.list();
        return {
            mode: 'edge',
            broker: Boolean((global as any).__ejunz_aedes),
            upstream: upstream?.status?.() || { enabled: false, connected: false },
            nodeCount: nodes.length,
            onlineNodes: nodes.filter((node: any) => node.connected || node.status === 'online').length,
        };
    }
}

class EdgeListNodesExecutor extends Executor<Context, Record<string, never>> {
    async execute() {
        const args = this.args as Record<string, unknown>;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
        const extra = Object.keys(args)[0];
        if (extra) throw new Error(`Unexpected argument: ${extra}`);
        EdgeListNodesSchema(args);

        const nodes = edgeRegistry.list().map((node: any) => ({
            nodeId: node.nodeId,
            status: node.status,
            connected: Boolean(node.connected),
            host: node.host,
            lastSeen: node.lastSeen,
        }));
        return { count: nodes.length, nodes };
    }
}

class EdgeListDevicesExecutor extends Executor<Context, { nodeId: string }> {
    async execute() {
        const raw = this.args as Record<string, unknown>;
        const extra = Object.keys(raw || {}).find((key) => key !== 'nodeId');
        if (extra) throw new Error(`Unexpected argument: ${extra}`);
        const nodeId = typeof raw?.nodeId === 'string' ? raw.nodeId.trim() : '';
        if (!nodeId) throw new Error('nodeId is required');
        const args = EdgeListDevicesSchema({ nodeId });
        const node = edgeRegistry.get(args.nodeId);
        if (!node) throw new Error(`Edge node not found: ${args.nodeId}`);
        const devices = Object.keys(node.deviceStates || {}).map((deviceId) => ({
            deviceId,
            currentState: getCurrentDeviceState(node, deviceId) || null,
            updatedAt: node.deviceStateUpdatedAt?.[deviceId] || null,
        }));
        devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
        return { nodeId: args.nodeId, count: devices.length, devices };
    }
}

class ZigbeeControlDeviceExecutor extends Executor<Context, { nodeId: string; deviceId: string; state: string }> {
    async execute() {
        const raw = this.args as Record<string, unknown>;
        const allowed = ['nodeId', 'deviceId', 'state'];
        const extra = Object.keys(raw || {}).find((key) => !allowed.includes(key));
        if (extra) throw new Error(`Unexpected argument: ${extra}`);
        const nodeId = typeof raw?.nodeId === 'string' ? raw.nodeId.trim() : '';
        const deviceId = typeof raw?.deviceId === 'string' ? raw.deviceId.trim() : '';
        const state = typeof raw?.state === 'string' ? raw.state.trim().toUpperCase() : '';
        if (!nodeId) throw new Error('nodeId is required');
        if (!deviceId) throw new Error('deviceId is required');
        if (!['ON', 'OFF', 'TOGGLE'].includes(state)) throw new Error('state must be ON, OFF, or TOGGLE');
        const args = ZigbeeControlDeviceSchema({ nodeId, deviceId, state });
        return sendNodeDeviceControl(args.nodeId, args.deviceId, args.state);
    }
}

export function getCurrentDeviceState(node: EdgeNodeRecord | undefined, deviceId: string): 'ON' | 'OFF' | undefined {
    const states = node?.deviceStates || {};
    const direct = states[deviceId];
    const read = (value: any): 'ON' | 'OFF' | undefined => {
        if (!value || typeof value !== 'object') return undefined;
        if (value.state === 'ON' || value.state === 'OFF') return value.state;
        if (value.power === 'ON' || value.power === 'OFF') return value.power;
        return undefined;
    };
    const directState = read(direct);
    const endpoint = String(deviceId).match(/^(.+)_(l\d+)$/);
    if (endpoint) {
        const baseId = endpoint[1];
        const baseState = states[baseId];
        const endpointState = baseState?.[`state_${endpoint[2]}`];
        const hasEndpointState = endpointState === 'ON' || endpointState === 'OFF';
        const directUpdatedAt = Number(node?.deviceStateUpdatedAt?.[deviceId] || 0);
        const baseUpdatedAt = Number(node?.deviceStateUpdatedAt?.[baseId] || 0);
        if (hasEndpointState && (!directState || baseUpdatedAt > directUpdatedAt)) return endpointState;
        if (directState) return directState;
        if (hasEndpointState) return endpointState;
        if (baseState?.state === 'ON' || baseState?.state === 'OFF') return baseState.state;
    }
    return directState;
}

export function sendNodeDeviceControl(nodeId: string, deviceId: string, state: string) {
    if (!['ON', 'OFF', 'TOGGLE'].includes(state)) throw new Error('state must be ON, OFF, or TOGGLE');
    const sent = edgeRegistry.send(nodeId, {
        protocol: 'mqtt',
        action: 'publish',
        channel: `node/${nodeId}/devices/${deviceId}/set`,
        payload: { state },
    });
    if (!sent) throw new Error(`Node ${nodeId} is not connected`);
    return { success: true, nodeId, deviceId, state };
}

export function apply(ctx: Context) {
    ctx.Tool('edge', 'edge_status', EdgeStatusExecutor, EdgeStatusSchema);
    ctx.Tool('edge', 'edge_list_nodes', EdgeListNodesExecutor, EdgeListNodesSchema);
    ctx.Tool('edge', 'edge_list_devices', EdgeListDevicesExecutor, EdgeListDevicesSchema);
    ctx.Tool('edge', 'zigbee_control_device', ZigbeeControlDeviceExecutor, ZigbeeControlDeviceSchema);
}
