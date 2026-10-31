import { Executor } from '@ejunz/framework';
import { Context } from 'cordis';
import Schema from 'schemastery';
import { edgeRegistry, EdgeNodeRecord } from '../model/edge-registry';

export const inject = ['server'];

type EdgeToolArguments = Record<string, string>;
type EdgeToolParameter = {
    type: 'string' | 'enum';
    description: string;
    required?: boolean;
    values?: readonly string[];
    normalize?: 'trim' | 'trim-uppercase';
};
type EdgeToolDefinition = {
    description: string;
    parameters: Record<string, EdgeToolParameter>;
    execute: (args: EdgeToolArguments) => unknown;
};

const edgeToolGuidance = 'Use edge_status, edge_list_nodes, and edge_list_devices for Edge and Zigbee status questions. Use zigbee_control_device only for a direct user request to change a device; the user must approve each control action.';

const edgeToolDefinitions: Record<string, EdgeToolDefinition> = {
    edge_status: {
        description: 'Read Edge service, upstream connection, and node status.',
        parameters: {},
        execute: () => getEdgeStatus(),
    },
    edge_list_nodes: {
        description: 'List authorized Edge nodes and their connection status.',
        parameters: {},
        execute: () => getEdgeNodes(),
    },
    edge_list_devices: {
        description: 'List devices and their latest reported state for one Edge node.',
        parameters: {
            nodeId: { type: 'string', description: 'Edge node id whose reported devices should be listed.', required: true, normalize: 'trim' },
        },
        execute: (args) => getEdgeDevices(args.nodeId),
    },
    zigbee_control_device: {
        description: 'Control a Zigbee switch. Call only when the user explicitly asks to turn a device on, off, or toggle it; execution also requires user approval.',
        parameters: {
            nodeId: { type: 'string', description: 'Edge node that owns the Zigbee device.', required: true, normalize: 'trim' },
            deviceId: { type: 'string', description: 'Zigbee device id or friendly name.', required: true, normalize: 'trim' },
            state: { type: 'enum', description: 'Desired switch action.', values: ['ON', 'OFF', 'TOGGLE'], required: true, normalize: 'trim-uppercase' },
        },
        execute: (args) => sendNodeDeviceControl(args.nodeId, args.deviceId, args.state),
    },
};

function toJsonSchema(definition: EdgeToolDefinition) {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [name, parameter] of Object.entries(definition.parameters)) {
        properties[name] = {
            type: 'string',
            description: parameter.description,
            ...(parameter.type === 'enum' ? { enum: [...(parameter.values || [])] } : {}),
        };
        if (parameter.required) required.push(name);
    }
    return {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
    };
}

function toCordisSchema(definition: EdgeToolDefinition) {
    const properties = Object.fromEntries(Object.entries(definition.parameters).map(([name, parameter]) => {
        const schema = parameter.type === 'enum'
            ? (Schema.union as any)(parameter.values || [])
            : Schema.string();
        return [name, (parameter.required ? schema.required() : schema).description(parameter.description)];
    }));
    return Schema.object(properties).description(definition.description);
}

export const edgeHostToolCatalog = {
    tools: Object.entries(edgeToolDefinitions).map(([name, definition]) => ({
        name,
        description: definition.description,
        inputSchema: toJsonSchema(definition),
    })),
    guidance: edgeToolGuidance,
};

export function validateEdgeHostToolArgs(name: string, raw: unknown): EdgeToolArguments {
    const definition = edgeToolDefinitions[name];
    if (!definition) throw new Error(`Unknown Edge tool: ${name}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Tool arguments must be an object');
    const args = raw as Record<string, unknown>;
    const allowed = Object.keys(definition.parameters);
    const extra = Object.keys(args).find((key) => !allowed.includes(key));
    if (extra) throw new Error(`Unexpected argument: ${extra}`);

    const normalized: EdgeToolArguments = {};
    for (const [key, parameter] of Object.entries(definition.parameters)) {
        const value = args[key];
        if (typeof value !== 'string') {
            if (parameter.type === 'enum') {
                const values = parameter.values || [];
                throw new Error(`${key} must be ${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`);
            }
            if (parameter.required) throw new Error(`${key} is required`);
            continue;
        }
        const result = parameter.normalize === 'trim-uppercase'
            ? value.trim().toUpperCase()
            : parameter.normalize === 'trim' ? value.trim() : value;
        if (parameter.required && !result) throw new Error(`${key} is required`);
        if (parameter.type === 'enum' && !(parameter.values || []).includes(result)) {
            const values = parameter.values || [];
            throw new Error(`${key} must be ${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`);
        }
        normalized[key] = result;
    }
    return normalized;
}

export function executeEdgeHostTool(name: string, rawArgs: unknown = {}) {
    const definition = edgeToolDefinitions[name];
    if (!definition) throw new Error(`Unknown Edge tool: ${name}`);
    return definition.execute(validateEdgeHostToolArgs(name, rawArgs));
}

export function getEdgeStatus() {
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

export function getEdgeNodes() {
    const nodes = edgeRegistry.list().map((node: any) => ({
        nodeId: node.nodeId,
        status: node.status,
        connected: Boolean(node.connected),
        host: node.host,
        lastSeen: node.lastSeen,
    }));
    return { count: nodes.length, nodes };
}

export function getEdgeDevices(nodeId: string) {
    if (!nodeId) throw new Error('nodeId is required');
    const node = edgeRegistry.get(nodeId);
    if (!node) throw new Error(`Edge node not found: ${nodeId}`);
    const devices = Object.keys(node.deviceStates || {}).map((deviceId) => ({
        deviceId,
        currentState: getCurrentDeviceState(node, deviceId) || null,
        updatedAt: node.deviceStateUpdatedAt?.[deviceId] || null,
    }));
    devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    return { nodeId, count: devices.length, devices };
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

const edgeToolExecutors = Object.fromEntries(Object.keys(edgeToolDefinitions).map((name) => [
    name,
    class extends Executor<Context, EdgeToolArguments> {
        async execute() {
            return executeEdgeHostTool(name, this.args);
        }
    },
])) as Record<string, any>;

export function apply(ctx: Context) {
    for (const [name, definition] of Object.entries(edgeToolDefinitions)) {
        ctx.Tool('edge', name, edgeToolExecutors[name], toCordisSchema(definition));
    }
}
