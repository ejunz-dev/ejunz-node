import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCredentialEncryptionKey } from './agent';

async function readKeyFile(file: string) {
    let fileStat;
    try {
        fileStat = await stat(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
        throw new Error('Credential encryption key file must be owner-only (mode 0600)');
    }
    return parseCredentialEncryptionKey(await readFile(file, 'utf8'));
}

export async function loadCredentialEncryptionKey(db: any, dataDir = path.resolve(process.cwd(), 'data')) {
    const envKey = process.env.NODE_AGENT_CREDENTIALS_ENCRYPTION_KEY?.trim();
    const keyFile = path.resolve(dataDir, 'llm-credentials.key');
    const storedKey = await readKeyFile(keyFile);
    if (storedKey) {
        if (envKey) {
            const configuredKey = parseCredentialEncryptionKey(envKey);
            if (!timingSafeEqual(storedKey, configuredKey)) {
                throw new Error('NODE_AGENT_CREDENTIALS_ENCRYPTION_KEY does not match data/llm-credentials.key');
            }
        }
        return storedKey;
    }
    if (envKey) return parseCredentialEncryptionKey(envKey);

    const existingCredential = await db.collection('agent_credentials').findOne({}, { projection: { _id: 1 } });
    if (existingCredential) return undefined;

    const key = randomBytes(32);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
        await writeFile(keyFile, `${key.toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
        await chmod(keyFile, 0o600);
        return key;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadCredentialEncryptionKey(db, dataDir);
        throw error;
    }
}
