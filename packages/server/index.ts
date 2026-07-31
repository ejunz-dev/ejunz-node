import os from 'node:os';
import path from 'node:path';
import LoggerService from '@cordisjs/plugin-logger';
import { TimerService } from '@cordisjs/plugin-timer';
import { Context } from 'cordis';
import { fs, Logger } from './utils';

const logger = new Logger('tools');

process.on('unhandledRejection', (e) => { logger.error(e); });
process.on('uncaughtException', (e) => { logger.error(e); });
Error.stackTraceLimit = 50;
const app = new Context();
fs.ensureDirSync(path.resolve(os.tmpdir(), 'ejunz-node'));

let config;
try {
    config = require('./config').config;
} catch (e) {
    if (e.message !== 'no-config') throw e;
}

function applyNode(ctx: Context) {
    ctx.plugin(require('./service/server'));
    const brokerSvc = require('./service/broker');
    ctx.plugin(brokerSvc.default || brokerSvc);
    const zigbee2mqttSvc = require('./service/zigbee2mqtt');
    ctx.plugin(zigbee2mqttSvc.default || zigbee2mqttSvc);
    const mqttBridgeSvc = require('./service/mqtt-bridge');
    ctx.plugin(mqttBridgeSvc.default || mqttBridgeSvc);
    ctx.inject(['server'], (c) => {
        c.plugin(require('./handler/node-ui'));
        c.plugin(require('./handler/zigbee2mqtt'));
        c.plugin(require('./handler/mqtt-bridge-config'));
        c.plugin(require('./handler/zigbee-console'));
        c.plugin(require('./handler/node-mcp-tools'));
        c.plugin(require('./handler/node-mcp-provider'));
        c.plugin(require('./handler/node-mcp-config'));
        c.server.listen();
    });
    ctx.plugin(require('./client/node'));
}

function applyEdge(ctx: Context) {
    ctx.plugin(require('./service/server'));
    const brokerSvc = require('./service/broker');
    ctx.plugin(brokerSvc.default || brokerSvc);
    const edgeSvc = require('./service/edge');
    ctx.plugin(edgeSvc.default || edgeSvc);
    ctx.inject(['server'], (c) => {
        c.plugin(require('./handler/edge-node'));
        c.plugin(require('./handler/edge-api'));
        c.plugin(require('./handler/edge-ui'));
        c.server.listen();
    });
}

async function apply(ctx: Context) {
    (global as any).__cordis_ctx = ctx;
    if (process.argv.includes('--edge')) applyEdge(ctx);
    else applyNode(ctx);
    logger.success(`${process.argv.includes('--edge') ? 'Edge' : 'Node'} started`);
    process.send?.('ready');
    await ctx.parallel('app/ready');
}

app.plugin(TimerService);
app.plugin(LoggerService, {
    console: {
        showDiff: false,
        showTime: 'dd hh:mm:ss',
        label: { align: 'right', width: 9, margin: 1 },
        levels: { default: process.env.DEV ? 3 : 2 },
    },
});

if (config) app.inject(['logger', 'timer'], (ctx) => apply(ctx));
