import type { Context } from '@ejunz/cordis';
import { SettingsProvider } from '@ejunz/ea-core/settings';

interface MongoSettingsStore {
    loadSettingsDocument(): Promise<Record<string, unknown>>;
    persistSettingsSection(namespace: string, section: Record<string, unknown>): Promise<void>;
}

function mongoStore(): MongoSettingsStore {
    const value = (globalThis as any).__agent_mongo_model;
    if (!value) throw new Error('Mongo service must be loaded before the Agent profile');
    return value;
}

class MongoSettingsProvider extends SettingsProvider {
    readonly writable = true;
    private readonly model: MongoSettingsStore;

    constructor(ctx: Context) {
        super(ctx);
        this.model = mongoStore();
    }

    protected load() {
        return this.model.loadSettingsDocument();
    }

    protected persist(namespace: string, section: Record<string, unknown>) {
        return this.model.persistSettingsSection(String(namespace), section);
    }
}

export const name = 'settings-mongo';

export async function apply(ctx: Context) {
    await Promise.resolve(ctx.plugin(MongoSettingsProvider));
}
