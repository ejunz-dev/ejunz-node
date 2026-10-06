import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function resolveUiAssetPath(moduleDir: string, bundledPath: string, sourcePath: string) {
    const assetPath = path.resolve(moduleDir, bundledPath);
    return existsSync(assetPath) ? assetPath : path.resolve(moduleDir, sourcePath);
}

export function createUiScriptPath(path: string, hasBundle: boolean, cacheKey: string) {
    return `${path}${hasBundle ? `?${encodeURIComponent(cacheKey)}` : ''}`;
}

export function readUiBundle(bundlePath: string, fallback: string) {
    if (!existsSync(bundlePath)) return fallback;
    return readFileSync(bundlePath, 'utf8');
}

export function createUiPage(options: { title: string; scriptPath: string; context?: unknown }) {
    const title = escapeHtml(options.title);
    const scriptPath = escapeHtml(options.scriptPath);
    const contextScript = options.context === undefined
        ? ''
        : `<script>window.Context=JSON.parse(${JSON.stringify(JSON.stringify(options.context).replace(/</g, '\\u003c'))})</script>`;

    return `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><div id="root"></div>${contextScript}<script src="${scriptPath}"></script></body></html>`;
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[character]!);
}
