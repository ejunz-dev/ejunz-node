// @ts-nocheck
import { Context, Service } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';
import childProcess from 'node:child_process';

let mqtt: typeof import('mqtt') | null = null;
/** Process-level lock: prevent concurrent z2m starts across Service instances */
let z2mSpawnLock: Promise<boolean> | null = null;
let z2mSpawned = false;

type DeviceInfo = Record<string, any>;

export interface Zigbee2MqttState {
    connected: boolean;
    lastError?: string;
    devices: DeviceInfo[];
    deviceStates: Map<string, any>; // live device state cache
    permitJoinEnabled: boolean;
    permitJoinEnd?: number;
    coordinator?: Record<string, any>;
}

declare module 'cordis' {
    interface Context {
        zigbee2mqtt: Zigbee2MqttService;
    }
}

export default class Zigbee2MqttService extends Service {
    constructor(ctx: Context) {
        super(ctx, 'zigbee2mqtt');
        ctx.mixin('zigbee2mqtt', []);
    }

    public state: Zigbee2MqttState = {
        connected: false,
        devices: [],
        deviceStates: new Map(),
        permitJoinEnabled: false,
    };
    private client?: import('mqtt').MqttClient;
    private readonly logger = new Logger('z2m');
    private baseTopic = config.zigbee2mqtt?.baseTopic || 'zigbee2mqtt';
    private child?: import('node:child_process').ChildProcessWithoutNullStreams;
    private zigbee2mqttProcess?: any; // set when z2m was started by this service
    private zigbee2mqttStarting?: Promise<boolean>; // in-flight start promise
    private bridgeReady: boolean = false;
    private bridgeReadyResolve?: () => void;
    private bridgeReadyPromise?: Promise<void>;
    private permitJoinTimer?: ReturnType<typeof setTimeout>;
    private permitJoinCountdown?: ReturnType<typeof setInterval>;
    private mqttUrl?: string;

    async [Service.init](): Promise<void> {
        if (!config.zigbee2mqtt?.enabled) {
            this.logger.info('zigbee2mqtt disabled');
            return;
        }
        // Connect with local config first; WS may later override broker settings
        await this.connectToBroker(
            config.zigbee2mqtt.mqttUrl || 'mqtt://localhost:1883',
            {
                baseTopic: config.zigbee2mqtt.baseTopic,
                username: config.zigbee2mqtt.username,
                password: config.zigbee2mqtt.password,
            }
        );
        // In node mode, auto-start zigbee2mqtt when configured
        if (process.argv.includes('--node') && config.zigbee2mqtt?.autoStart) {
            void this.ensureProcess().then((mode) => {
                if (mode !== 'none') {
                    this.logger.info('zigbee2mqtt process started (mode: %s)', mode);
                }
            }).catch((e) => {
                this.logger.error('failed to auto-start zigbee2mqtt: %s', (e as Error).message);
            });
        }
    }

    async connectToBroker(mqttUrl: string, options?: { baseTopic?: string; username?: string; password?: string }): Promise<void> {
        const nextBaseTopic = options?.baseTopic || this.baseTopic || config.zigbee2mqtt?.baseTopic || 'zigbee2mqtt';
        if (this.client?.connected && this.mqttUrl === mqttUrl && this.baseTopic === nextBaseTopic) {
            return;
        }

        try {
            mqtt = require('mqtt');
        } catch (e) {
            this.logger.error('mqtt dependency missing. Please install it in workspace.');
            this.state.lastError = 'mqtt dependency missing';
            return;
        }

        // Close existing connection before reconnecting
        if (this.client) {
            try {
                // Drop listeners to avoid duplicate handlers
                this.client.removeAllListeners();
                this.client.end(true);
            } catch {}
            this.client = undefined;
        }

        this.mqttUrl = mqttUrl;
        this.baseTopic = nextBaseTopic;

        // Reset bridge ready state
        this.bridgeReady = false;
        this.bridgeReadyResolve = undefined;
        this.bridgeReadyPromise = new Promise((resolve) => {
            this.bridgeReadyResolve = resolve;
        });

        const username = options?.username || undefined;
        const password = options?.password || undefined;

        this.logger.info('connecting mqtt %s', mqttUrl);
        this.client = mqtt.connect(mqttUrl, { username, password });
        this.client.on('connect', () => {
            this.state.connected = true;
            this.logger.success('mqtt connected');
            try { this.ctx.parallel('zigbee2mqtt/connected'); } catch {}
            this.subscribe();
            // Refresh devices after bridge is ready
            void this.waitForBridgeAndRefreshDevices();
        });
        this.client.on('reconnect', () => {
            this.logger.info('mqtt reconnecting');
            // Reset bridge ready on reconnect
            this.bridgeReady = false;
            this.bridgeReadyPromise = new Promise((resolve) => {
                this.bridgeReadyResolve = resolve;
            });
        });
        this.client.on('close', () => {
            this.state.connected = false;
            this.bridgeReady = false;
            this.logger.warn('mqtt closed');
        });
        this.client.on('error', (err) => {
            this.state.lastError = err?.message || String(err);
            this.logger.error(err);
        });
        this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    }

    async [Service.dispose](): Promise<void> {
        if (this.permitJoinTimer) clearTimeout(this.permitJoinTimer);
        this.permitJoinTimer = undefined;
        if (this.permitJoinCountdown) clearInterval(this.permitJoinCountdown);
        this.permitJoinCountdown = undefined;
        if (this.client) try { this.client.end(true); } catch {}
        this.client = undefined;
        // Stop in-process zigbee2mqtt module if it was used
        if (this.zigbee2mqttProcess) {
            try {
                const zigbee2mqtt = require('zigbee2mqtt');
                if (zigbee2mqtt.stop) {
                    await zigbee2mqtt.stop();
                }
            } catch (e) {
                this.logger.warn('failed to stop zigbee2mqtt module: %s', (e as Error).message);
            }
            this.zigbee2mqttProcess = undefined;
        }
        await this.stopProcess();
    }

    private subscribe() {
        if (!this.client) return;
        const topics = [
            `${this.baseTopic}/#`,
            `${this.baseTopic}/bridge/#`,
        ];
        for (const t of topics) this.client.subscribe(t).catch?.(() => {});
    }

    private onMessage(topic: string, payload: Buffer) {
        const normalizedTopic = String(topic);
        let data: any = payload.toString();
        try { data = JSON.parse(data); } catch {}
        try { this.ctx.parallel('zigbee2mqtt/message', normalizedTopic, data); } catch {}

        if (normalizedTopic === `${this.baseTopic}/bridge/info`) {
            if (data && typeof data === 'object') {
                this.updatePermitJoinState(!!data.permit_join, data.permit_join_end);
                if (data.coordinator) {
                    this.state.coordinator = data.coordinator;
                    try { this.ctx.parallel('zigbee2mqtt/coordinator', data.coordinator); } catch {}
                }
            }
        }
        if (normalizedTopic === `${this.baseTopic}/bridge/response/permit_join`) {
            if (data?.status === 'ok' && data?.data) {
                const time = Number(data.data.time ?? 0);
                if (time > 0) {
                    this.updatePermitJoinState(true, Date.now() + time * 1000);
                } else {
                    this.updatePermitJoinState(false);
                }
            }
        }

        // bridge/state indicates whether zigbee2mqtt is ready
        if (normalizedTopic === `${this.baseTopic}/bridge/state`) {
            const state = typeof data === 'string' ? data : (data?.state || '');
            if (state === 'online' && !this.bridgeReady) {
                this.bridgeReady = true;
                this.logger.info('zigbee2mqtt bridge is ready');
                if (this.bridgeReadyResolve) {
                    this.bridgeReadyResolve();
                    this.bridgeReadyResolve = undefined;
                }
            } else if (state === 'offline') {
                this.bridgeReady = false;
                this.logger.warn('zigbee2mqtt bridge is offline');
            }
        }

        const parts = topic.split('/');
        if (parts[0] === this.baseTopic && parts[1] && parts[1] !== 'bridge') {
            const deviceId = parts[1];
            // Cache device state
            this.state.deviceStates.set(deviceId, data);
            try { this.ctx.parallel('zigbee2mqtt/deviceState', deviceId, data); } catch {}
        }
        // Device list updates are published on bridge/devices
        if (topic === `${this.baseTopic}/bridge/devices`) {
            if (data && Array.isArray(data)) {
                this.state.devices = data as DeviceInfo[];
                try { this.ctx.parallel('zigbee2mqtt/devices', this.state.devices); } catch {}
            }
        }
        // Legacy format: bridge/response/devices
        if (topic === `${this.baseTopic}/bridge/response/devices`) {
            if (data && Array.isArray(data.data)) {
                this.state.devices = data.data as DeviceInfo[];
                try { this.ctx.parallel('zigbee2mqtt/devices', this.state.devices); } catch {}
            }
        }
    }

    private async waitForBridgeAndRefreshDevices() {
        // With autoStart, wait for bridge ready (up to 60s for process startup)
        if (process.argv.includes('--node') && config.zigbee2mqtt?.autoStart) {
            this.logger.info('waiting for zigbee2mqtt bridge...');
            try {
                await Promise.race([
                    this.bridgeReadyPromise || Promise.resolve(),
                    new Promise((resolve) => setTimeout(resolve, 60000)), // 60s timeout
                ]);
                if (this.bridgeReady) {
                    this.logger.info('zigbee2mqtt bridge is ready, refreshing device list');
                } else {
                    this.logger.warn('bridge ready timeout (60s); zigbee2mqtt may have failed to start');
                    this.logger.warn('check whether the zigbee2mqtt process is running');
                }
            } catch (e) {
                this.logger.warn('error while waiting for bridge: %s', (e as Error).message);
            }
        } else {
            // Without autoStart, briefly delay before refresh
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Best-effort device list refresh on init
        try {
            await this.refreshDevices(10000);
            this.logger.info('device list refreshed, %d device(s)', this.state.devices.length);
        } catch (e) {
            // Do not throw on init refresh failure
            const errorMsg = (e as Error).message;
            if (errorMsg.includes('timeout')) {
                this.logger.warn('device list refresh timed out; zigbee2mqtt may still be starting');
                this.logger.warn('if zigbee2mqtt failed to start, check logs or start it manually');
            } else {
                this.logger.warn('failed to refresh device list on init: %s', errorMsg);
            }
        }
    }

    async refreshDevices(timeoutMs = 3000): Promise<DeviceInfo[]> {
        if (!this.client) throw new Error('mqtt not connected');
        // zigbee2mqtt publishes the device list on bridge/devices (not bridge/response/devices)
        const devicesTopic = `${this.baseTopic}/bridge/devices`;
        const requestTopic = `${this.baseTopic}/bridge/request/devices`;

        return new Promise<DeviceInfo[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('devices timeout')), timeoutMs);
            let resolved = false;

            const handle = (topic: string, payload: Buffer) => {
                if (topic === devicesTopic) {
                    clearTimeout(timer);
                    this.client?.off('message', handle);
                    if (resolved) return;
                    resolved = true;
                    try {
                        const devices = JSON.parse(payload.toString());
                        if (Array.isArray(devices)) {
                            this.state.devices = devices;
                            resolve(this.state.devices);
                        } else {
                            resolve([]);
                        }
                    } catch (e) {
                        this.logger.warn('failed to parse device list: %s', (e as Error).message);
                        resolve([]);
                    }
                }
            };

            this.client?.on('message', handle);
            // Request a fresh device list publish from zigbee2mqtt
            this.client?.publish(requestTopic, JSON.stringify({}))
                .catch?.((e: any) => {
                    if (!resolved) {
                        clearTimeout(timer);
                        this.client?.off('message', handle);
                        reject(e);
                    }
                });
        });
    }

    async listDevices(): Promise<DeviceInfo[]> {
        let devices = this.state.devices;
        if (!devices.length) {
            try {
                devices = await this.refreshDevices(10000); // 10s timeout
            } catch (e) {
                this.logger.warn('failed to get device list: %s', (e as Error).message);
                return [];
            }
        }
        // Exclude the Coordinator itself; return end devices only
        const filteredDevices = devices.filter((d: any) => {
            const type = d.type || '';
            const friendlyName = (d.friendly_name || '').toLowerCase();
            return type !== 'Coordinator' && !friendlyName.includes('coordinator');
        });

        // Merge cached live state
        return filteredDevices.map((d: any) => {
            const deviceId = d.friendly_name || d.ieee_address;
            const state = this.state.deviceStates.get(deviceId);
            if (state) {
                return { ...d, state };
            }
            return d;
        });
    }

    async setDeviceState(deviceId: string, payload: Record<string, any>): Promise<void> {
        if (!this.client) throw new Error('mqtt not connected');
        const topic = `${this.baseTopic}/${deviceId}/set`;
        await this.client.publish(topic, JSON.stringify(payload));
    }

    getCoordinator(): Record<string, any> | null {
        return this.state.coordinator || null;
    }

    getPermitStatus(): { enabled: boolean; remaining: number } {
        if (!this.state.permitJoinEnabled) {
            return { enabled: false, remaining: 0 };
        }
        const end = this.state.permitJoinEnd;
        if (!end) {
            return { enabled: true, remaining: 0 };
        }
        const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
        return { enabled: remaining > 0, remaining };
    }

    private updatePermitJoinState(enabled: boolean, end?: number) {
        const prev = this.getPermitStatus();
        this.state.permitJoinEnabled = enabled;
        this.state.permitJoinEnd = enabled ? end : undefined;

        if (this.permitJoinTimer) {
            clearTimeout(this.permitJoinTimer);
            this.permitJoinTimer = undefined;
        }
        if (this.permitJoinCountdown) {
            clearInterval(this.permitJoinCountdown);
            this.permitJoinCountdown = undefined;
        }
        if (enabled && end) {
            const delay = Math.max(0, end - Date.now());
            this.permitJoinTimer = setTimeout(() => {
                this.state.permitJoinEnabled = false;
                this.state.permitJoinEnd = undefined;
                this.permitJoinTimer = undefined;
                if (this.permitJoinCountdown) {
                    clearInterval(this.permitJoinCountdown);
                    this.permitJoinCountdown = undefined;
                }
                try { this.ctx.parallel('zigbee2mqtt/permitJoin', this.getPermitStatus()); } catch {}
            }, delay + 100);
            this.permitJoinCountdown = setInterval(() => {
                const status = this.getPermitStatus();
                if (!status.enabled) {
                    if (this.permitJoinCountdown) clearInterval(this.permitJoinCountdown);
                    this.permitJoinCountdown = undefined;
                    return;
                }
                try { this.ctx.parallel('zigbee2mqtt/permitJoin', status); } catch {}
            }, 1000);
        }

        const next = this.getPermitStatus();
        if (prev.enabled !== next.enabled || prev.remaining !== next.remaining) {
            try { this.ctx.parallel('zigbee2mqtt/permitJoin', next); } catch {}
        }
    }

    async permitJoin(value: boolean, timeSec: number = 120): Promise<void> {
        if (!this.client) throw new Error('mqtt not connected');
        const topic = `${this.baseTopic}/bridge/request/permit_join`;
        // zigbee2mqtt permit_join API:
        // - time must be present (not undefined)
        // - time > 0: enable pairing for time seconds
        // - time = 0: disable pairing
        const time = value ? timeSec : 0;
        if (time > 0) {
            this.updatePermitJoinState(true, Date.now() + time * 1000);
        } else {
            this.updatePermitJoinState(false);
        }
        await this.client.publish(topic, JSON.stringify({ time }));
    }

    // -------- Process management: prefer systemd, fall back to local spawn --------
    private systemctl(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            const cp = childProcess.spawn('systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            cp.stdout.on('data', (d) => { stdout += String(d); });
            cp.stderr.on('data', (d) => { stderr += String(d); });
            cp.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        });
    }

    async ensureProcess(): Promise<'systemd' | 'spawn' | 'none'> {
        if (!config.zigbee2mqtt?.autoStart) return 'none';
        // Try systemd first
        const status = await this.systemctl('is-active', '--quiet', 'zigbee2mqtt').catch(() => ({ code: 1, stdout: '', stderr: '' }));
        if (status.code === 0) return 'systemd';
        const start = await this.systemctl('start', 'zigbee2mqtt').catch(() => ({ code: 1, stdout: '', stderr: '' }));
        if (start.code === 0) return 'systemd';
        // Fall back to local spawn
        return await this.spawnLocal() ? 'spawn' : 'none';
    }

    async spawnLocal(): Promise<boolean> {
        try {
            if (this.child && !this.child.killed) return true;
            if (this.zigbee2mqttProcess || z2mSpawned) return true;
            if (z2mSpawnLock) return await z2mSpawnLock;

            z2mSpawnLock = this.spawnLocalUnlocked().finally(() => {
                z2mSpawnLock = null;
            });
            return await z2mSpawnLock;
        } catch (e) {
            this.logger.error('failed to start zigbee2mqtt: %s', (e as Error).message);
            return false;
        }
    }

    private writeZ2mConfig(adapter: string): string {
        const path = require('node:path');
        const fs = require('node:fs');
        const yaml = require('js-yaml');
        const z2mDataDir = process.env.ZIGBEE2MQTT_DATA || path.join(process.env.HOME || process.cwd(), '.z2m');
        if (!fs.existsSync(z2mDataDir)) fs.mkdirSync(z2mDataDir, { recursive: true });

        const z2mConfigFile = path.join(z2mDataDir, 'configuration.yaml');
        let z2mConfig: any = {};
        if (fs.existsSync(z2mConfigFile)) {
            try {
                z2mConfig = yaml.load(fs.readFileSync(z2mConfigFile, 'utf8')) || {};
            } catch (e) {
                this.logger.warn('failed to read zigbee2mqtt config, creating a new one: %s', (e as Error).message);
            }
        }

        const mqttUrl = config.zigbee2mqtt?.mqttUrl || 'mqtt://localhost:1883';
        const url = new URL(mqttUrl);
        if (!z2mConfig.mqtt) z2mConfig.mqtt = {};
        z2mConfig.mqtt.server = `mqtt://${url.hostname}:${url.port || '1883'}`;
        z2mConfig.mqtt.base_topic = config.zigbee2mqtt?.baseTopic || 'zigbee2mqtt';
        if (config.zigbee2mqtt?.username) z2mConfig.mqtt.user = config.zigbee2mqtt.username;
        if (config.zigbee2mqtt?.password) z2mConfig.mqtt.password = config.zigbee2mqtt.password;

        if (!z2mConfig.serial) z2mConfig.serial = {};
        z2mConfig.serial.port = adapter;
        z2mConfig.serial.adapter = (config.zigbee2mqtt as any)?.adapterType || z2mConfig.serial.adapter || 'ember';

        fs.writeFileSync(z2mConfigFile, yaml.dump(z2mConfig));
        this.logger.info(
            'updated zigbee2mqtt config: adapter=%s, type=%s, mqtt=%s',
            adapter,
            z2mConfig.serial.adapter,
            z2mConfig.mqtt.server,
        );
        return z2mDataDir;
    }

    private async spawnLocalUnlocked(): Promise<boolean> {
        try {
            if (this.child && !this.child.killed) return true;
            if (this.zigbee2mqttProcess || z2mSpawned) return true;

            const path = require('node:path');
            const fs = require('node:fs');

            let adapter = config.zigbee2mqtt?.adapter || '/dev/ttyUSB0';
            if (!fs.existsSync(adapter)) {
                this.logger.warn('configured adapter not found: %s, trying auto-detect...', adapter);
                const possibleDevices = ['/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyACM1'];
                for (const device of possibleDevices) {
                    if (fs.existsSync(device)) {
                        adapter = device;
                        this.logger.info('auto-detected adapter: %s', adapter);
                        break;
                    }
                }
                if (!fs.existsSync(adapter)) {
                    this.logger.error('no Zigbee adapter found; check the device or update config.adapter');
                    return false;
                }
            }

            // Write config first. Prefer a child process so z2m process.exit cannot kill this node.
            const z2mDataDir = this.writeZ2mConfig(adapter);
            const pkgPath = require.resolve('zigbee2mqtt/package.json');
            const pkgDir = path.dirname(pkgPath);
            const mainPath = path.join(pkgDir, 'index.js');
            if (!fs.existsSync(mainPath)) {
                this.logger.error('zigbee2mqtt entry not found: %s', mainPath);
                return false;
            }

            // Sync hash file so the child does not trigger a rebuild
            try {
                const hashFile = path.join(pkgDir, 'dist', '.hash');
                const distDir = path.dirname(hashFile);
                if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
                fs.writeFileSync(hashFile, 'unknown');
            } catch {}

            this.logger.info('starting zigbee2mqtt as child process (adapter: %s)', adapter);
            this.child = childProcess.spawn('node', [mainPath], {
                cwd: pkgDir,
                env: {
                    ...process.env,
                    NODE_ENV: process.env.NODE_ENV || 'production',
                    COREPACK_ENABLE_STRICT: '0',
                    npm_config_package_manager: 'yarn',
                    ZIGBEE2MQTT_DATA: z2mDataDir,
                    GIT_DIR: '/dev/null',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.setupChildProcess();
            this.zigbee2mqttProcess = true;
            z2mSpawned = true;
            return true;
        } catch (e) {
            this.logger.error('spawn zigbee2mqtt failed: %s', (e as Error).message);
            z2mSpawned = false;
            this.zigbee2mqttProcess = undefined;
            return false;
        }
    }

    private setupChildProcess() {
        if (!this.child) return;

        this.child.stdout.on('data', (d) => this.logger.info(`[z2m] ${String(d).trim()}`));
        this.child.stderr.on('data', (d) => {
            const msg = String(d).trim();
            this.logger.warn(`[z2m] ${msg}`);
        });
        this.child.on('close', (code) => {
            if (code !== 0 && code !== null) {
                this.logger.error(`zigbee2mqtt process exited abnormally (code: ${code})`);
                this.logger.error('check that zigbee2mqtt is installed correctly, or start the service manually');
            } else {
                this.logger.warn(`z2m exited: ${code}`);
            }
            this.child = undefined;
            this.zigbee2mqttProcess = undefined;
            z2mSpawned = false;
        });
    }

    async stopProcess(): Promise<void> {
        // Try systemd stop first
        const res = await this.systemctl('stop', 'zigbee2mqtt').catch(() => ({ code: 1 } as any));
        if (res.code === 0) return;
        // Local child process
        if (this.child && !this.child.killed) {
            try { this.child.kill('SIGTERM'); } catch {}
            this.child = undefined;
        }
        // In-process module leftover
        if (this.zigbee2mqttProcess) {
            try {
                const zigbee2mqtt = require('zigbee2mqtt');
                if (zigbee2mqtt.stop) await zigbee2mqtt.stop();
            } catch {}
            this.zigbee2mqttProcess = undefined;
        }
        z2mSpawned = false;
    }

    async processStatus(): Promise<{ mode: 'systemd' | 'spawn' | 'none'; active: boolean }> {
        const sys = await this.systemctl('is-active', '--quiet', 'zigbee2mqtt').catch(() => ({ code: 1 } as any));
        if (sys.code === 0) return { mode: 'systemd', active: true };
        if (this.child && !this.child.killed) return { mode: 'spawn', active: true };
        return { mode: 'none', active: false };
    }
}
