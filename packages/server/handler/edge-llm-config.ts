import path from 'node:path';
import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { fs, Logger, randomstring } from '../utils';
import { isEdgeMode } from '../config';
import { requireEdgeAdmin } from './edge-auth';

const logger = new Logger('handler/edge-llm-config');
const dataDir = path.resolve(process.cwd(), 'data');
const configPath = path.join(dataDir, 'llm-config.json');
const secretsPath = path.join(dataDir, 'llm-secrets.json');
const requestTimeoutMs = 15000;

type ModelConfig = {
    id: string;
    name?: string;
    enabled: boolean;
    contextWindow?: number;
    maxTokens?: number;
    [key: string]: any;
};

type ProviderConfig = {
    id: string;
    displayName: string;
    baseURL: string;
    api?: string;
    apiKeyEnv?: string;
    enabled: boolean;
    models: ModelConfig[];
    lastSyncAt?: number;
    [key: string]: any;
};

type LlmConfig = { providers: ProviderConfig[] };
type LlmSecrets = Record<string, string>;

function readJson<T>(file: string, fallback: T): T {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function readConfig(): LlmConfig {
    const config = readJson<LlmConfig>(configPath, { providers: [] });
    if (!config || !Array.isArray(config.providers)) throw new Error('LLM 配置格式无效');
    return config;
}

function readSecrets(): LlmSecrets {
    const secrets = readJson<LlmSecrets>(secretsPath, {});
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
        throw new Error('LLM 凭据文件格式无效');
    }
    return secrets;
}

function writeJson(file: string, value: unknown) {
    fs.ensureDirSync(dataDir);
    const tempPath = `${file}.${process.pid}.${randomstring(6)}.tmp`;
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        fs.chmodSync(tempPath, 0o600);
        fs.renameSync(tempPath, file);
        fs.chmodSync(file, 0o600);
    } finally {
        if (fs.existsSync(tempPath)) fs.removeSync(tempPath);
    }
}

function saveConfig(config: LlmConfig) {
    writeJson(configPath, config);
}

function saveSecrets(secrets: LlmSecrets) {
    writeJson(secretsPath, secrets);
}

function getApiKey(provider: ProviderConfig, secrets: LlmSecrets) {
    return secrets[provider.id] || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '') || '';
}

export function getActiveAgentModel() {
    const config = readConfig();
    const secrets = readSecrets();
    for (const provider of config.providers) {
        if (!provider.enabled) continue;
        const model = (provider.models || []).find((item) => item.enabled);
        if (!model) continue;
        return {
            providerId: provider.id,
            providerName: provider.displayName,
            baseURL: normalizeBaseUrl(provider.baseURL),
            api: provider.api || 'openai-completions',
            apiKey: getApiKey(provider, secrets),
            modelId: model.id,
        };
    }
    return undefined;
}

function publicProvider(provider: ProviderConfig, secrets: LlmSecrets, registered = false) {
    const { apiKey: _apiKey, ...safeProvider } = provider;
    const managedKey = Boolean(secrets[provider.id]);
    const envKey = Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]);
    const enabledModels = (provider.models || []).filter((model) => model.enabled).length;
    return {
        ...safeProvider,
        models: provider.models || [],
        keyConfigured: managedKey || envKey,
        keySource: managedKey ? '托管凭据库' : envKey ? provider.apiKeyEnv : undefined,
        keyMasked: managedKey ? '••••••••' : undefined,
        keyWritable: managedKey,
        enabledModelCount: enabledModels,
        registered,
    };
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function respondError(handler: any, status: number, message: string) {
    handler.response.status = status;
    handler.response.body = { error: message };
}

function providerId(displayName: string, providers: ProviderConfig[]) {
    const base = displayName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
    const ids = new Set(providers.map((provider) => provider.id));
    let id = base;
    let suffix = 2;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    return id;
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

class LlmConfigHandler extends Handler<Context> {
    async get() {
        if (!requireEdgeAdmin(this)) return;
        try {
            const config = readConfig();
            const secrets = readSecrets();
            const activeModel = getActiveAgentModel();
            this.response.body = {
                providers: config.providers.map((provider) => publicProvider(provider, secrets, provider.id === activeModel?.providerId)),
                routes: activeModel ? [{ id: activeModel.providerId, name: activeModel.providerName, modelCount: 1 }] : [],
            };
        } catch (error) {
            logger.error('Failed to read LLM configuration: %s', errorMessage(error));
            respondError(this, 500, errorMessage(error));
        }
    }
}

class LlmProvidersHandler extends Handler<Context> {
    async post() {
        if (!requireEdgeAdmin(this)) return;
        const body = this.request.body || {};
        try {
            const config = readConfig();
            const secrets = readSecrets();
            const action = String(body.action || '');

            if (action === 'create') {
                const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
                if (!displayName) return respondError(this, 400, '名称不能为空');
                const baseURL = normalizeBaseUrl(body.baseURL);
                const id = providerId(displayName, config.providers);
                const provider: ProviderConfig = {
                    id,
                    displayName,
                    baseURL,
                    api: typeof body.api === 'string' && body.api ? body.api : 'openai-completions',
                    enabled: body.enabled !== false,
                    models: [],
                };
                if (typeof body.apiKey === 'string' && body.apiKey.trim()) secrets[id] = body.apiKey.trim();
                config.providers.push(provider);
                saveConfig(config);
                saveSecrets(secrets);
                this.response.body = { ok: 1, provider: publicProvider(provider, secrets) };
                return;
            }

            if (action === 'update') {
                const provider = config.providers.find((item) => item.id === body.id);
                if (!provider) return respondError(this, 404, 'Provider 不存在');
                if (typeof body.displayName === 'string' && body.displayName.trim()) provider.displayName = body.displayName.trim();
                if (body.baseURL !== undefined) provider.baseURL = normalizeBaseUrl(body.baseURL);
                if (typeof body.api === 'string' && body.api) provider.api = body.api;
                if (typeof body.enabled === 'boolean') provider.enabled = body.enabled;
                if (typeof body.apiKey === 'string' && body.apiKey.trim()) secrets[provider.id] = body.apiKey.trim();
                saveConfig(config);
                saveSecrets(secrets);
                this.response.body = { ok: 1, provider: publicProvider(provider, secrets) };
                return;
            }

            if (action === 'delete') {
                const index = config.providers.findIndex((provider) => provider.id === body.id);
                if (index < 0) return respondError(this, 404, 'Provider 不存在');
                const [provider] = config.providers.splice(index, 1);
                delete secrets[provider.id];
                saveConfig(config);
                saveSecrets(secrets);
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
            const config = readConfig();
            const provider = config.providers.find((item) => item.id === body.id);
            if (!provider) return respondError(this, 404, 'Provider 不存在');
            const secrets = readSecrets();
            const apiKey = getApiKey(provider, secrets);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
            let response: Response;
            let result: any;
            try {
                response = await fetch(`${normalizeBaseUrl(provider.baseURL)}/models`, {
                    headers: {
                        Accept: 'application/json',
                        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                    },
                    signal: controller.signal,
                });
                result = await response.json().catch(() => ({}));
            } finally {
                clearTimeout(timeout);
            }
            if (!response.ok) {
                const detail = result?.error?.message || result?.error || `${response.status} ${response.statusText}`;
                return respondError(this, 502, typeof detail === 'string' ? detail : JSON.stringify(detail));
            }
            const received = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : null;
            if (!received) return respondError(this, 502, '模型列表响应格式无效');

            const previous = new Map((provider.models || []).map((model) => [model.id, model]));
            let added = 0;
            let updated = 0;
            const models = received
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
                        ...(Number.isFinite(model.context_window) ? { contextWindow: model.context_window } : {}),
                        ...(Number.isFinite(model.max_tokens) ? { maxTokens: model.max_tokens } : {}),
                    };
                });
            provider.models = models;
            provider.lastSyncAt = Date.now();
            saveConfig(config);
            this.response.body = {
                added,
                updated,
                total: models.length,
                enabled: models.filter((model) => model.enabled).length,
            };
        } catch (error) {
            const message = error instanceof Error && error.name === 'AbortError'
                ? '获取模型列表超时'
                : errorMessage(error);
            logger.warn('LLM model sync failed: %s', message);
            respondError(this, 502, message);
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
            const config = readConfig();
            const provider = config.providers.find((item) => item.id === body.providerId);
            if (!provider) return respondError(this, 404, 'Provider 不存在');
            const model = (provider.models || []).find((item) => item.id === body.modelId);
            if (!model) return respondError(this, 404, '模型不存在');
            model.enabled = body.enabled;
            saveConfig(config);
            this.response.body = { ok: 1 };
        } catch (error) {
            logger.error('Failed to update LLM model: %s', errorMessage(error));
            respondError(this, 500, errorMessage(error));
        }
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    ctx.Route('llm-config', '/api/llm-config', LlmConfigHandler);
    ctx.Route('llm-config-providers', '/api/llm-config/providers', LlmProvidersHandler);
    ctx.Route('llm-config-provider-sync', '/api/llm-config/providers/sync', LlmProviderSyncHandler);
    ctx.Route('llm-config-models', '/api/llm-config/models', LlmModelsHandler);
}
