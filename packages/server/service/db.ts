// @ts-nocheck
import { MongoClient } from 'mongodb';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Context, Service } from 'cordis';
import { config, isEdgeMode } from '../config';
import { AgentLlmConfig, AgentLlmProviderConfig, AgentMongoModel, llmCredentialRef } from '../model/agent';
import { loadCredentialEncryptionKey } from '../model/credential-key';
import { Logger } from '../utils';

const logger = new Logger('db');

async function readLegacyJson(file: string) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

function normalizeLegacyProvider(raw: any): AgentLlmProviderConfig | undefined {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.displayName !== 'string' || typeof raw.baseURL !== 'string') return undefined;
    const models = Array.isArray(raw.models) ? raw.models
        .filter((model: any) => model && typeof model.id === 'string' && model.id.trim())
        .map((model: any) => ({
            ...model,
            id: model.id.trim(),
            enabled: model.enabled !== false,
        })) : [];
    const { apiKey: _apiKey, ...safeProvider } = raw;
    return {
        ...safeProvider,
        id: raw.id,
        displayName: raw.displayName,
        baseURL: raw.baseURL,
        api: typeof raw.api === 'string' && raw.api ? raw.api : 'openai-completions',
        enabled: raw.enabled !== false,
        models,
        apiKeyEnv: llmCredentialRef(raw.id),
    };
}

async function migrateLegacyLlmConfig(model: AgentMongoModel) {
    const configExists = await model.hasLlmConfig();
    const dataDir = path.resolve(process.cwd(), 'data');
    let legacyConfig: any;
    try {
        legacyConfig = await readLegacyJson(path.join(dataDir, 'llm-config.json'));
    } catch {
        logger.warn('Legacy LLM configuration could not be parsed; leaving Mongo configuration unchanged');
        return;
    }
    if (!legacyConfig) return;
    if (!Array.isArray(legacyConfig.providers)) {
        logger.warn('Legacy LLM configuration has an invalid shape; leaving Mongo configuration unchanged');
        return;
    }

    let legacySecrets: Record<string, string> = {};
    try {
        const parsed = await readLegacyJson(path.join(dataDir, 'llm-secrets.json'));
        if (parsed !== undefined) {
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid secrets shape');
            legacySecrets = parsed;
        }
    } catch {
        logger.warn('Legacy LLM credentials could not be parsed; leaving Mongo configuration unchanged');
        return;
    }

    const providers = legacyConfig.providers.map(normalizeLegacyProvider).filter(Boolean) as AgentLlmProviderConfig[];
    const pendingCredentials = legacyConfig.providers.flatMap((raw: any) => {
        const provider = normalizeLegacyProvider(raw);
        if (!provider) return [];
        const storedValue = legacySecrets[provider.id];
        const value = (typeof storedValue === 'string' ? storedValue : '') || (typeof raw.apiKey === 'string' ? raw.apiKey : '');
        return value ? [{ ref: llmCredentialRef(provider.id), value }] : [];
    });
    if (!configExists) {
        try {
            await model.saveLlmConfig({ providers }, 0);
            logger.info('Migrated legacy LLM provider configuration into MongoDB');
        } catch (error) {
            logger.warn('Legacy LLM provider configuration migration did not complete: %s', error instanceof Error ? error.message : String(error));
            return;
        }
    }
    if (pendingCredentials.length && !(await model.hasCredentialEncryptionKey())) {
        logger.warn('Legacy LLM credential migration is waiting for a usable credential encryption key');
        return;
    }

    try {
        for (const credential of pendingCredentials) {
            if (!(await model.describeCredential(credential.ref))) await model.setCredential(credential.ref, credential.value);
        }
        if (pendingCredentials.length) logger.info('Migrated legacy LLM credentials into MongoDB');
    } catch (error) {
        logger.warn('Legacy LLM configuration migration did not complete: %s', error instanceof Error ? error.message : String(error));
    }
}

export class MongoService extends Service<Context> {
    client?: MongoClient;
    db?: any;
    agent: AgentMongoModel;

    constructor(ctx: Context) {
        super(ctx, 'db');
    }

    async [Service.init]() {
        if (!isEdgeMode) return;
        const mongo = (config as any).agent?.mongo || {};
        const uri = String(mongo.uri || process.env.NODE_AGENT_MONGO_URI || '').trim();
        const database = String(mongo.database || process.env.NODE_AGENT_MONGO_DATABASE || '').trim();
        if (!uri || !database) throw new Error('Configure agent.mongo.uri and agent.mongo.database');

        const client = new MongoClient(uri, { appName: 'ejunz-node-agent' });
        try {
            await client.connect();
            const db = client.db(database);
            await db.command({ ping: 1 });
            const credentialEncryptionKey = await loadCredentialEncryptionKey(db);
            if (!credentialEncryptionKey) {
                logger.warn('Encrypted Mongo credentials exist but data/llm-credentials.key is missing; restore the original key before using API keys');
            }
            const agent = new AgentMongoModel(client, db, credentialEncryptionKey);
            await agent.ensureIndexes();
            await migrateLegacyLlmConfig(agent);
            this.client = client;
            this.db = db;
            this.agent = agent;
            (global as any).__agent_mongo_model = agent;
            logger.success('MongoDB connected (%s)', database);
        } catch (error) {
            await client.close().catch(() => {});
            throw error;
        }
    }

    collection(name: string) {
        if (!this.db) throw new Error('MongoDB is not connected');
        return this.db.collection(name);
    }

    async [Service.dispose]() {
        const client = this.client;
        const agent = this.agent;
        this.client = undefined;
        this.db = undefined;
        this.agent = undefined;
        if ((global as any).__agent_mongo_model === agent) (global as any).__agent_mongo_model = undefined;
        await agent?.close();
        await client?.close();
    }
}

declare module 'cordis' {
    interface Context {
        db: MongoService;
    }
}

export default MongoService;
