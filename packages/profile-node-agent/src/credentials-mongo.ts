import type { Context } from '@ejunz/cordis';
import { CredentialProvider } from '@ejunz/ea-core/credentials';
import type { CredentialRef } from '@ejunz/ea-core/credentials';

interface MongoCredentialStore {
    hasCredentialEncryptionKey(): Promise<boolean>;
    resolveCredential(reference: string): Promise<string | undefined>;
    describeCredential(reference: string): Promise<boolean>;
    setCredential(reference: string, value: string): Promise<void>;
    unsetCredential(reference: string): Promise<void>;
}

function mongoStore(): MongoCredentialStore {
    const value = (globalThis as any).__agent_mongo_model;
    if (!value) throw new Error('Mongo service must be loaded before the Agent profile');
    return value;
}

class MongoCredentialProvider extends CredentialProvider {
    private readonly model: MongoCredentialStore;

    constructor(ctx: Context) {
        super(ctx);
        this.model = mongoStore();
    }

    async resolve(ref: CredentialRef) {
        const reference = String(ref);
        const stored = await this.model.resolveCredential(reference);
        if (stored !== undefined && stored.length > 0) return { value: stored, source: 'mongo' };
        const environmentValue = process.env[reference];
        return environmentValue ? { value: environmentValue, source: 'env' } : undefined;
    }

    async describe(ref: CredentialRef) {
        const reference = String(ref);
        const stored = await this.model.describeCredential(reference);
        const fromEnvironment = Boolean(process.env[reference]);
        return {
            configured: stored || fromEnvironment,
            ...(stored ? { source: 'mongo' } : fromEnvironment ? { source: 'env' } : {}),
            writable: await this.model.hasCredentialEncryptionKey(),
        };
    }

    async set(ref: CredentialRef, value: string) {
        await this.model.setCredential(String(ref), value);
        this.notifyUpdated(ref);
    }

    async unset(ref: CredentialRef) {
        await this.model.unsetCredential(String(ref));
        this.notifyUpdated(ref);
    }
}

export const name = 'credentials-mongo';

export async function apply(ctx: Context) {
    await Promise.resolve(ctx.plugin(MongoCredentialProvider));
}
