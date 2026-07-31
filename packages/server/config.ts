import path from 'node:path';
import Schema from 'schemastery';
import { version as packageVersion } from './package.json';
import {
    fs, Logger, randomstring, yaml,
} from './utils';

const logger = new Logger('init');

export const isEdgeMode = process.argv.includes('--edge');
export const isNodeMode = !isEdgeMode;
const configName = isEdgeMode ? 'config.edge.yaml' : 'config.node.yaml';
const exampleName = isEdgeMode ? 'config.edge.example.yaml' : 'config.example.yaml';
const configPath = path.resolve(process.cwd(), configName);
fs.ensureDirSync(path.resolve(process.cwd(), 'data'));

export let exit: Promise<void> | null = null;

if (!fs.existsSync(configPath)) {
    exit = new Promise((resolve) => (async () => {
        const example = path.resolve(process.cwd(), exampleName);
        if (fs.existsSync(example)) {
            fs.copyFileSync(example, configPath);
            logger.info('Created %s from %s', configName, exampleName);
        }
        resolve();
    })());
}

const brokerSchema = Schema.object({
    enabled: Schema.boolean().default(true),
    port: Schema.number().default(1883),
    wsPort: Schema.number().default(8083),
});

const nodeSchema = Schema.object({
    nodeId: Schema.string().default(''),
    port: Schema.number().default(5284),
    publicHost: Schema.string().default(''),
    publicPort: Schema.number().default(0),
    viewPass: Schema.string().default(randomstring(8)),
    broker: brokerSchema.default({ enabled: true, port: 1883, wsPort: 8083 }),
    mqttBridge: Schema.object({
        enabled: Schema.boolean().default(true),
        reconnect: Schema.object({
            enabled: Schema.boolean().default(true),
            period: Schema.number().default(5000),
        }).default({ enabled: true, period: 5000 }),
        brokers: Schema.array(Schema.object({
            name: Schema.string().required(),
            mqttUrl: Schema.string().required(),
            baseTopic: Schema.string().default('zigbee2mqtt'),
            username: Schema.string().default(''),
            password: Schema.string().default(''),
            enabled: Schema.boolean().default(true),
            reconnect: Schema.object({
                enabled: Schema.boolean().default(true),
                period: Schema.number().default(5000),
            }).default({ enabled: true, period: 5000 }),
        })).default([]),
    }).default({
        enabled: true,
        reconnect: { enabled: true, period: 5000 },
        brokers: [],
    }),
    zigbee2mqtt: Schema.object({
        enabled: Schema.boolean().default(true),
        baseTopic: Schema.string().default('zigbee2mqtt'),
        autoStart: Schema.boolean().default(true),
        adapter: Schema.string().default('/dev/ttyUSB0'),
    }).default({
        enabled: true,
        baseTopic: 'zigbee2mqtt',
        autoStart: true,
        adapter: '/dev/ttyUSB0',
    }),
    ws: Schema.object({
        endpoint: Schema.string().default(''),
        token: Schema.string().default(''),
        localEndpoint: Schema.string().default('/mcp/ws'),
        enabled: Schema.boolean().default(true),
    }).default({ endpoint: '', token: '', localEndpoint: '/mcp/ws', enabled: true }),
}).description('Node Config');

const edgeSchema = Schema.object({
    port: Schema.number().default(5283),
    publicHost: Schema.string().default(''),
    viewPass: Schema.string().default(randomstring(8)),
    nodePath: Schema.string().default('/node/conn'),
    broker: brokerSchema.default({ enabled: true, port: 1883, wsPort: 8083 }),
    auth: Schema.object({
        tokenFile: Schema.string().default('data/edge-nodes.json'),
        requestTtl: Schema.number().default(300000),
    }).default({ tokenFile: 'data/edge-nodes.json', requestTtl: 300000 }),
    upstream: Schema.object({
        enabled: Schema.boolean().default(false),
        endpoint: Schema.string().default(''),
        token: Schema.string().default(''),
    }).default({ enabled: false, endpoint: '', token: '' }),
}).description('Edge Config');

export const config = (isEdgeMode ? edgeSchema : nodeSchema)(
    fs.existsSync(configPath)
        ? (yaml.load(fs.readFileSync(configPath, 'utf8')) as any)
        : {},
);

// Secrets may be supplied by systemd without committing them to config.edge.yaml.
if (isEdgeMode) {
    if (process.env.EDGE_VIEW_PASS) config.viewPass = process.env.EDGE_VIEW_PASS;
    if (process.env.EDGE_UPSTREAM_ENDPOINT) config.upstream.endpoint = process.env.EDGE_UPSTREAM_ENDPOINT;
    if (process.env.EDGE_UPSTREAM_TOKEN) config.upstream.token = process.env.EDGE_UPSTREAM_TOKEN;
}

const envPort = process.env.PORT || process.env.NODE_PORT || (isEdgeMode ? process.env.EDGE_PORT : '');
if (envPort != null && envPort !== '' && !Number.isNaN(Number(envPort))) {
    config.port = Number(envPort);
}

export const saveConfig = () => {
    fs.writeFileSync(configPath, yaml.dump(config));
};

export const getConfigPath = () => configPath;
export const version = packageVersion;

logger.info(`Loading ${isEdgeMode ? 'edge' : 'node'} config from ${configPath}`);
logger.info(`ejunz-node version: ${packageVersion}`);
