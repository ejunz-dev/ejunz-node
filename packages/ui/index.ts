import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveUiAssetPath(moduleDir: string, bundledPath: string, sourcePath: string) {
    const assetPath = path.resolve(moduleDir, bundledPath);
    return existsSync(assetPath) ? assetPath : path.resolve(moduleDir, sourcePath);
}
