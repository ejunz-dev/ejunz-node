import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { AgentLlmConfig, AgentLlmProviderConfig, AgentMongoModel, llmCredentialRef } from '../model/agent';
import { isEdgeMode } from '../config';
import { Logger } from '../utils';
import { requireEdgeAdmin } from './edge-auth';

const logger = new Logger('handler/edge-llm-config');
let agentService: any;

type RuntimeProvider = { provider: string; displayName: string; active: boolean };

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function respondError(handler: any, status: number, message: string) {
    handler.response.status = status;
    handler.response.body = { error: message };
}

function normalizeBaseUrl(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Base URL 不能为空');
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error('Base URL 格式无效');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Base URL 必须是有效的 HTTP(S) 地址，且不能包含凭据、查询参数或片段');
    }
    return url.toString().replace(/\/+$/, '');
}

function getStore(): AgentMongoModel {
    const store = agentService?.getStore?.();
    if (!store) throw new Error('Mongo model is not ready');
    return store;
}

async function runtimeCall(method: string, payload: Record<string, unknown> = {}) {
    if (!agentService?.getRuntime?.()) throw new Error('Agent runtime is not ready');
    const response = await agentService.call(`/api/${method}`, agentService.createEnvelope(method, payload));
    if (response?.result?.ok === false) throw new Error(response.result.error?.message || 'Agent request failed');
    if (response?.result?.ok === true) return response.result.value;
    if (response?.error?.message) throw new Error(response.error.message);
    return response?.result?.value ?? response?.value ?? response;
}

async function runtimeProviders(): Promise<RuntimeProvider[]> {
    const result = await runtimeCall('llm.providers');
    return Array.isArray(result?.providers) ? result.providers : [];
}

function activeModel(config: AgentLlmConfig) {
    for (const provider of config.providers) {
        if (!provider.enabled) continue;
        const model = (provider.models || []).find((item) => item.enabled);
        if (model) return { providerId: provider.id, providerName: provider.displayName, modelId: model.id };
    }
    return undefined;
}

async function publicProvider(provider: AgentLlmProviderConfig, store: AgentMongoModel, registered?: boolean) {
    const { apiKey: _apiKey, apiKeyEnv: _apiKeyEnv, ...safeProvider } = provider;
    const credentialRef = provider.apiKeyEnv || llmCredentialRef(provider.id);
    const mongoCredentialExists = await store.describeCredential(credentialRef);
    const environmentCredentialExists = Boolean(process.env[credentialRef]);
    let keyReadable = true;
    if (mongoCredentialExists) {
        try {
            await store.resolveCredential(credentialRef);
        } catch {
            keyReadable = false;
        }
    }
    const keyConfigured = mongoCredentialExists || environmentCredentialExists;
    return {
        ...safeProvider,
        models: provider.models || [],
        keyConfigured,
        keyReadable,
        keySource: keyConfigured ? (mongoCredentialExists ? (keyReadable ? 'MongoDB 凭据库' : 'MongoDB 凭据不可解密') : credentialRef) : undefined,
        keyMasked: keyConfigured ? '••••••••' : undefined,
        keyWritable: await store.hasCredentialEncryptionKey(),
        enabledModelCount: (provider.models || []).filter((model) => model.enabled).length,
        registered,
    };
}

async function persistAndApply(config: AgentLlmConfig, expectedRevision: number) {
    const store = getStore();
    await store.saveLlmConfig(config, expectedRevision);
    try {
        await agentService.syncLlmConfiguration();
    } catch (error) {
        throw new Error(`配置已保存到 Mongo，但 Agent runtime 尚未应用：${errorMessage(error)}`);
    }
}

function providerId(displayName: string, providers: AgentLlmProviderConfig[]) {
    const base = displayName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
    const ids = new Set(providers.map((provider) => provider.id));
    let id = base;
    let suffix = 2;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    return id;
}

class LlmConfigHandler extends Handler<Context> {
    async get() {
        if (!requireEdgeAdmin(this)) return;
        try {
            const store = getStore();
            const config = await store.loadLlmConfig();
            let registered = new Set<string>();
            let runtimeInspectionAvailable = false;
            try {
                registered = new Set((await runtimeProviders()).filter((provider) => provider.active).map((provider) => provider.provider));
                runtimeInspectionAvailable = true;
            } catch (error) {
                logger.warn('Unable to inspect Agent runtime model providers: %s', errorMessage(error));
            }
            const providers = await Promise.all(config.providers.map((provider) => publicProvider(provider, store, runtimeInspectionAvailable ? registered.has(provider.id) : undefined)));
            const active = activeModel(config);
            const current = active ? providers.find((provider) => provider.id === active.providerId) : undefined;
            this.response.body = {
                providers,
                routes: current?.registered ? [{ id: current.id, name: current.displayName, modelCount: current.enabledModelCount }] : [],
                activeModel: active ? {
                    providerId: active.providerId,
                    modelId: active.modelId,
                    runtimeRegistered: current?.registered,
                    credentialConfigured: current?.keyConfigured === true,
                    credentialReadable: current?.keyReadable !== false,
                } : undefined,
                runtimeInspectionAvailable,
                credentialEncryptionReady: await store.hasCredentialEncryptionKey(),
            };
        } catch (error) {
            logger.error('Failed to read Mongo LLM configuration: %s', errorMessage(error));
            respondError(this, 500, errorMessage(error));
        }
    }
}

class LlmProvidersHandler extends Handler<Context> {
    async post() {
        if (!requireEdgeAdmin(this)) return;
        const body = this.request.body || {};
        const store = getStore();
        try {
            const { config, revision } = await store.loadLlmConfigState();
            const action = String(body.action || '');

            if (action === 'create') {
                const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
                if (!displayName) return respondError(this, 400, '名称不能为空');
                const id = providerId(displayName, config.providers);
                const provider: AgentLlmProviderConfig = {
                    id,
                    displayName,
                    baseURL: normalizeBaseUrl(body.baseURL),
                    api: typeof body.api === 'string' && body.api ? body.api : 'openai-completions',
                    apiKeyEnv: llmCredentialRef(id),
                    enabled: body.enabled !== false,
                    models: [],
                };
                if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
                    if (!(await store.hasCredentialEncryptionKey())) return respondError(this, 400, '请先配置 NODE_AGENT_CREDENTIALS_ENCRYPTION_KEY，再保存 API Key');
                    await store.setCredential(provider.apiKeyEnv!, body.apiKey.trim());
                }
                config.providers.push(provider);
                try {
                    await persistAndApply(config, revision);
                } catch (error) {
                    if (typeof body.apiKey === 'string' && body.apiKey.trim()) await store.unsetCredential(provider.apiKeyEnv!);
                    throw error;
                }
                this.response.body = { ok: 1, provider: await publicProvider(provider, store) };
                return;
            }

            if (action === 'update') {
                const provider = config.providers.find((item) => item.id === body.id);
                if (!provider) return respondError(this, 404, 'Provider 不存在');
                if (typeof body.displayName === 'string' && body.displayName.trim()) provider.displayName = body.displayName.trim();
                if (body.baseURL !== undefined) provider.baseURL = normalizeBaseUrl(body.baseURL);
                if (typeof body.api === 'string' && body.api) provider.api = body.api;
                if (typeof body.enabled === 'boolean') provider.enabled = body.enabled;
                provider.apiKeyEnv ||= llmCredentialRef(provider.id);
                if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
                    if (!(await store.hasCredentialEncryptionKey())) return respondError(this, 400, '请先配置 NODE_AGENT_CREDENTIALS_ENCRYPTION_KEY，再保存 API Key');
                    await store.setCredential(provider.apiKeyEnv, body.apiKey.trim());
                }
                await persistAndApply(config, revision);
                this.response.body = { ok: 1, provider: await publicProvider(provider, store) };
                return;
            }

            if (action === 'delete') {
                const index = config.providers.findIndex((provider) => provider.id === body.id);
                if (index < 0) return respondError(this, 404, 'Provider 不存在');
                const [provider] = config.providers.splice(index, 1);
                await persistAndApply(config, revision);
                await store.unsetCredential(provider.apiKeyEnv || llmCredentialRef(provider.id));
                this.response.body = { ok: 1 };
                return;
            }

            respondError(this, 400, '不支持的 Provider 操作');
        } catch (error) {
            logger.warn('LLM provider update failed: %s', errorMessage(error));
            respondError(this, 400, errorMessage(error));
        }
    }
}

class LlmProviderSyncHandler extends Handler<Context> {
    async post() {
        if (!requireEdgeAdmin(this)) return;
        const body = this.request.body || {};
        try {
            const store = getStore();
            const { config, revision } = await store.loadLlmConfigState();
            const provider = config.providers.find((item) => item.id === body.id);
            if (!provider) return respondError(this, 404, 'Provider 不存在');
            const credentialRef = provider.apiKeyEnv || llmCredentialRef(provider.id);
            const apiKey = await store.resolveCredential(credentialRef) || process.env[credentialRef];
            const discovered = await runtimeCall('llm.discoverModels', {
                settingsNs: 'llm-pi-ai',
                provider: provider.id,
                baseURL: provider.baseURL,
                api: provider.api || 'openai-completions',
                ...(apiKey ? { apiKey } : {}),
            });
            const received = Array.isArray(discovered?.models) ? discovered.models : [];
            const previous = new Map((provider.models || []).map((model) => [model.id, model]));
            let added = 0;
            let updated = 0;
            provider.models = received
                .filter((model: any) => model && typeof model.id === 'string' && model.id.trim())
                .map((model: any) => {
                    const id = model.id.trim();
                    const old = previous.get(id);
                    if (old) updated += 1;
                    else added += 1;
                    return {
                        ...(old || {}),
                        id,
                        name: typeof model.name === 'string' ? model.name : old?.name || id,
                        enabled: typeof old?.enabled === 'boolean' ? old.enabled : true,
                        ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
                        ...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
                    };
                });
            provider.lastSyncAt = Date.now();
            await persistAndApply(config, revision);
            this.response.body = {
                added,
                updated,
                total: provider.models.length,
                enabled: provider.models.filter((model) => model.enabled).length,
            };
        } catch (error) {
            logger.warn('LLM model sync failed: %s', errorMessage(error));
            respondError(this, 502, errorMessage(error));
        }
    }
}

class LlmModelsHandler extends Handler<Context> {
    async post() {
        if (!requireEdgeAdmin(this)) return;
        const body = this.request.body || {};
        if (typeof body.providerId !== 'string' || typeof body.modelId !== 'string' || typeof body.enabled !== 'boolean') {
            return respondError(this, 400, 'providerId、modelId 和 enabled 参数无效');
        }
        try {
            const store = getStore();
            const { config, revision } = await store.loadLlmConfigState();
            const provider = config.providers.find((item) => item.id === body.providerId);
            if (!provider) return respondError(this, 404, 'Provider 不存在');
            const model = (provider.models || []).find((item) => item.id === body.modelId);
            if (!model) return respondError(this, 404, '模型不存在');
            model.enabled = body.enabled;
            await persistAndApply(config, revision);
            this.response.body = { ok: 1 };
        } catch (error) {
            logger.error('Failed to update Mongo LLM model: %s', errorMessage(error));
            respondError(this, 500, errorMessage(error));
        }
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    ctx.inject(['agent'], ({ agent }: any) => {
        agentService = agent;
        ctx.Route('llm-config', '/api/llm-config', LlmConfigHandler);
        ctx.Route('llm-config-providers', '/api/llm-config/providers', LlmProvidersHandler);
        ctx.Route('llm-config-provider-sync', '/api/llm-config/providers/sync', LlmProviderSyncHandler);
        ctx.Route('llm-config-models', '/api/llm-config/models', LlmModelsHandler);
    });
}
