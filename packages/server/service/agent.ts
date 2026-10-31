// @ts-nocheck
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Context, Service } from 'cordis';
import { resolveEaHome } from '@ejunz/ea-core/home-paths';
import { config, getConfigPath, isEdgeMode } from '../config';
import { AgentMongoModel, llmCredentialRef } from '../model/agent';
import { Logger } from '../utils';

const logger = new Logger('agent');
const PROFILE_NAME = 'node-agent';
const GENERATED_PROFILE_MARKER = 'ejunz-node-agent-profile';

type EmbeddedRuntime = {
    api: { fetch(request: Request): Promise<Response> };
    events: {
        mux(signal: AbortSignal): AsyncIterable<{ rpcId?: string; payload?: any }>;
        host(signal: AbortSignal): AsyncIterable<{ rpcId?: string; payload?: any }>;
    };
    ctx: { fiber: { dispose(): Promise<void> } };
};

async function writeGeneratedFile(file: string, content: string, marker: string) {
    try {
        const existing = await readFile(file, 'utf8');
        if (!existing.includes(marker)) throw new Error(`Refusing to overwrite custom Agent profile file: ${file}`);
        if (existing !== content) await writeFile(file, content, { mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFile(file, content, { flag: 'wx', mode: 0o600 });
    }
}

async function prepareProfileHome() {
    const base = path.dirname(getConfigPath());
    const home = path.resolve(base, 'data', 'agent-runtime-home');
    const profileDir = path.join(home, 'profiles', PROFILE_NAME);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const manifest = {
        name: PROFILE_NAME,
        private: true,
        [GENERATED_PROFILE_MARKER]: 1,
        dependencies: {
            '@ejunz/ea-core': '0.1.4',
            '@ejunz/node-agent-profile': '0.1.0',
            '@ejunz/profile-web': '0.1.2-rc.5',
        },
        ea: { profile: { bundles: ['@ejunz/ea-core', '@ejunz/node-agent-profile'] } },
    };
    await writeGeneratedFile(
        path.join(profileDir, 'package.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        GENERATED_PROFILE_MARKER,
    );
    await writeGeneratedFile(
        path.join(profileDir, 'cordis.patch.yml'),
        '# Standalone Agent profile uses Mongo providers from the @ejunz/node bundle.\n[]\n',
        'Standalone Agent profile',
    );
    return home;
}

export default class AgentService extends Service<Context> {
    static inject = ['db'];
    store?: AgentMongoModel;
    private runtime?: EmbeddedRuntime;
    private bootError?: string;
    private starting?: Promise<void>;
    private muxAbort?: AbortController;
    private readonly hostToolToken = randomBytes(32).toString('base64url');
    private hostToolClient?: any;
    private readonly subscribers = new Set<(event: any) => void>();
    private previousEaHome?: string;
    private previousAgentLegacyHome?: string;

    constructor(ctx: Context) {
        super(ctx, 'agent');
    }

    async [Service.init]() {
        if (!isEdgeMode) return;
        const dbService = (this.ctx as any).db;
        if (!dbService?.client || !dbService?.db || !dbService?.agent) throw new Error('MongoDB service is not ready');
        this.store = dbService.agent;
        const legacyHome = resolveEaHome();
        this.previousEaHome = process.env.EA_HOME;
        this.previousAgentLegacyHome = process.env.NODE_AGENT_LEGACY_HOME;
        process.env.NODE_AGENT_LEGACY_HOME = legacyHome;
        process.env.EA_HOME = await prepareProfileHome();
        void this.bootRuntime();
    }

    collection(name: string) {
        return (this.ctx as any).db.collection(name);
    }

    getStore() {
        return this.store;
    }

    getHostToolToken() {
        return this.hostToolToken;
    }

    getRuntime() {
        return this.runtime;
    }

    getBootError() {
        return this.bootError;
    }

    getStarting() {
        return this.starting;
    }

    subscribe(listener: (event: any) => void) {
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }

    async boot() {
        return this.bootRuntime();
    }

    async bootRuntime() {
        if (this.runtime || this.starting) return this.starting;
        this.starting = (async () => {
            this.bootError = undefined;
            const [{ embedAgentRuntime }, { createHostToolBridge, createHostToolClient }] = await Promise.all([
                import('@ejunz/ea-core/embed'),
                import('@ejunz/ea-core/tool-host'),
            ]);
            const origin = `http://127.0.0.1:${Number((config as any).port) || 5283}`;
            const hostToolClient = createHostToolClient(createHostToolBridge(origin, this.hostToolToken));
            this.hostToolClient = hostToolClient;
            (globalThis as any).__ejunz_edge_host_tool_client = hostToolClient;
            const runtime = await embedAgentRuntime({ profile: PROFILE_NAME }) as EmbeddedRuntime;
            this.runtime = runtime;
            try {
                await this.syncLlmConfiguration();
                this.startMuxBridge();
            } catch (error) {
                this.runtime = undefined;
                await runtime.ctx.fiber.dispose();
                throw error;
            }
            logger.info('Standalone Agent runtime ready (Mongo settings, credentials, and session persistence)');
        })().catch((error) => {
            this.runtime = undefined;
            if ((globalThis as any).__ejunz_edge_host_tool_client === this.hostToolClient) delete (globalThis as any).__ejunz_edge_host_tool_client;
            this.hostToolClient = undefined;
            this.bootError = (error as Error).message;
            logger.error('Failed to boot standalone Agent runtime: %s', this.bootError);
        }).finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    async getActiveLlmModel() {
        const config = await this.store?.loadLlmConfig();
        if (!config) return undefined;
        for (const provider of config.providers) {
            if (!provider.enabled) continue;
            const model = (provider.models || []).find((item) => item.enabled);
            if (!model) continue;
            const credentialRef = provider.apiKeyEnv || llmCredentialRef(provider.id);
            let storedCredential = false;
            let credentialReadable = true;
            try {
                storedCredential = await this.store.describeCredential(credentialRef);
                if (storedCredential) await this.store.resolveCredential(credentialRef);
            } catch {
                credentialReadable = false;
            }
            const credentialConfigured = storedCredential || Boolean(process.env[credentialRef]);
            return { provider: provider.id, model: model.id, credentialConfigured, credentialReadable };
        }
        return undefined;
    }

    async syncLlmConfiguration() {
        if (!this.runtime) throw new Error('Agent runtime is not ready');
        if (!this.store) throw new Error('Mongo model is not ready');
        const config = await this.store.loadLlmConfig();
        const providers: Record<string, any> = {};
        for (const provider of config.providers) {
            if (!provider.enabled) continue;
            const models = (provider.models || []).filter((model) => model.enabled).map((model) => ({
                id: model.id,
                ...(model.name ? { name: model.name } : {}),
                ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
                ...(Number.isInteger(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
            }));
            if (!models.length) continue;
            providers[provider.id] = {
                displayName: provider.displayName,
                api: provider.api || 'openai-completions',
                baseURL: provider.baseURL,
                apiKeyEnv: provider.apiKeyEnv || llmCredentialRef(provider.id),
                models,
            };
        }
        const response = await this.call('/api/settings.replace', this.createEnvelope('settings.replace', {
            ns: 'llm-pi-ai',
            section: { providers },
        }));
        const result = response?.result;
        if (result?.ok === false) throw new Error(result.error?.message || 'Agent rejected LLM configuration');
        if (response?.error?.message) throw new Error(response.error.message);
        return result?.value ?? response?.value ?? response;
    }

    private startMuxBridge() {
        if (!this.runtime) return;
        const runtime = this.runtime;
        const controller = new AbortController();
        this.muxAbort = controller;
        void (async () => {
            try {
                for await (const frame of runtime.events.mux(controller.signal)) {
                    const payload = frame?.payload;
                    if (!payload || typeof payload !== 'object') continue;
                    const nestedSessionEvent = payload.type === 'session/event' && payload.event && typeof payload.event === 'object';
                    const event = nestedSessionEvent ? payload.event : payload;
                    const sessionId = String(payload.sessionId || event.sessionId || payload.session?.id || '');
                    const seq = Number(payload.seq ?? event?.seq ?? Date.now());
                    if (!sessionId || !event?.type) continue;
                    const eventData = nestedSessionEvent
                        ? event.data ?? {}
                        : { ...payload, ...(typeof frame.rpcId === 'string' ? { rpcId: frame.rpcId } : {}) };
                    const mapped = {
                        type: 'session/event',
                        sessionId,
                        seq,
                        event: {
                            type: String(event.type),
                            data: eventData,
                            timestamp: Number(event.time || event.timestamp || Date.now()),
                        },
                    };
                    for (const subscriber of this.subscribers) {
                        try { subscriber(mapped); } catch { /* subscriber failure must not break others */ }
                    }
                }
            } catch (error) {
                if (!controller.signal.aborted) logger.warn('Agent mux stream ended: %s', (error as Error).message);
            }
        })();
    }

    async call(pathname: string, body: unknown, signal?: AbortSignal) {
        const runtime = this.runtime;
        if (!runtime) throw new Error(this.bootError || 'Agent runtime is not ready');
        const response = await runtime.api.fetch(new Request(`http://127.0.0.1${pathname}`, {
            method: 'POST',
            headers: { host: '127.0.0.1', 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
            ...(signal ? { signal } : {}),
        }));
        const text = await response.text();
        let payload: any = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: { message: text || `HTTP ${response.status}` } }; }
        if (!response.ok) {
            const message = payload?.error?.message || payload?.result?.error?.message || `Agent request failed (HTTP ${response.status})`;
            throw new Error(message);
        }
        return payload;
    }

    createEnvelope(method: string, payload: unknown = {}) {
        return { type: 'client-request', rpcId: randomUUID(), method, payload };
    }

    async [Service.dispose]() {
        this.muxAbort?.abort();
        this.muxAbort = undefined;
        this.subscribers.clear();
        await this.starting;
        const runtime = this.runtime;
        this.runtime = undefined;
        if ((globalThis as any).__ejunz_edge_host_tool_client === this.hostToolClient) delete (globalThis as any).__ejunz_edge_host_tool_client;
        this.hostToolClient = undefined;
        if (runtime) await runtime.ctx.fiber.dispose();
        await this.store?.close();
        this.store = undefined;
        if (this.previousEaHome === undefined) delete process.env.EA_HOME;
        else process.env.EA_HOME = this.previousEaHome;
        if (this.previousAgentLegacyHome === undefined) delete process.env.NODE_AGENT_LEGACY_HOME;
        else process.env.NODE_AGENT_LEGACY_HOME = this.previousAgentLegacyHome;
        this.previousEaHome = undefined;
        this.previousAgentLegacyHome = undefined;
    }
}
