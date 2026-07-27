import path from 'node:path';
import Schema from 'schemastery';
import { version as packageVersion } from './package.json';
import {
    fs, Logger, randomstring, yaml,
} from './utils';

const logger = new Logger('init');

logger.info('Loading config');
const configPath = path.resolve(process.cwd(), 'config.node.yaml');
fs.ensureDirSync(path.resolve(process.cwd(), 'data'));

export let exit: Promise<void> | null = null;

if (!fs.existsSync(configPath)) {
    exit = new Promise((resolve) => (async () => {
        const example = path.resolve(process.cwd(), 'config.example.yaml');
        if (fs.existsSync(example)) {
            fs.copyFileSync(example, configPath);
            logger.info('Created config.node.yaml from config.example.yaml');
        }
        resolve();
    })());
}

const nodeSchema = Schema.object({
    nodeId: Schema.string().default(''),
    port: Schema.number().default(5284),
    publicHost: Schema.string().default(''),
    publicPort: Schema.number().default(0),
    // 本地 MQTT Broker（默认启用，端口1883，无需配置）
    broker: Schema.object({
        enabled: Schema.boolean().default(true),
        port: Schema.number().default(1883),
        wsPort: Schema.number().default(8083),
    }).default({ enabled: true, port: 1883, wsPort: 8083 }),
    // MQTT 桥接配置（支持连接多个 broker）
    mqttBridge: Schema.object({
        enabled: Schema.boolean().default(true),
        reconnect: Schema.object({
            enabled: Schema.boolean().default(true), // 是否启用自动重连
            period: Schema.number().default(5000), // 重连间隔（毫秒）
        }).default({
            enabled: true,
            period: 5000,
        }),
        brokers: Schema.array(Schema.object({
            name: Schema.string().required(),
            mqttUrl: Schema.string().required(),
            baseTopic: Schema.string().default('zigbee2mqtt'),
            username: Schema.string().default(''),
            password: Schema.string().default(''),
            enabled: Schema.boolean().default(true),
            reconnect: Schema.object({
                enabled: Schema.boolean().default(true), // 单个broker是否启用自动重连（继承全局配置）
                period: Schema.number().default(5000), // 单个broker重连间隔（继承全局配置）
            }).default({
                enabled: true,
                period: 5000,
            }),
        })).default([]),
    }).default({
        enabled: true,
        reconnect: {
            enabled: true,
            period: 5000,
        },
        brokers: [],
    }),
    zigbee2mqtt: Schema.object({
        enabled: Schema.boolean().default(true),
        baseTopic: Schema.string().default('zigbee2mqtt'),
        autoStart: Schema.boolean().default(true), // node 模式下默认自动启动
        adapter: Schema.string().default('/dev/ttyUSB0'),
    }).default({
        enabled: true,
        baseTopic: 'zigbee2mqtt',
        autoStart: true,
        adapter: '/dev/ttyUSB0',
    }),
    // Edge WebSocket 连接配置（必需）
    ws: Schema.object({
        endpoint: Schema.string().default(''), // 上游 Edge WebSocket endpoint (完整 URL，如 wss://example.com/mcp/ws?token=xxx)
        localEndpoint: Schema.string().default('/mcp/ws'), // 本地 WebSocket 服务器路径（可选）
        enabled: Schema.boolean().default(true),
    }).default({
        endpoint: '',
        localEndpoint: '/mcp/ws',
        enabled: true,
    }),
}).description('Node Config');

export const config = nodeSchema(
    fs.existsSync(configPath)
        ? (yaml.load(fs.readFileSync(configPath, 'utf8')) as any)
        : {},
);

const envPort = process.env.PORT || process.env.NODE_PORT;
if (envPort != null && envPort !== '' && !Number.isNaN(Number(envPort))) {
    config.port = Number(envPort);
}

export const saveConfig = () => {
    fs.writeFileSync(configPath, yaml.dump(config));
};
export const version = packageVersion;

logger.info(`Config loaded from ${configPath}`);
logger.info(`ejunz-node version: ${packageVersion}`);
