import { gunzipSync } from 'node:zlib';
import { decode } from 'base16384';
import path from 'node:path';
import * as fsExtra from 'fs-extra';

export { Logger, sleep, randomstring } from '@ejunz/utils';

/**
 * Get the data directory path, handling both development and packaged environments
 * In packaged environments (pkg), data directory should be next to the executable
 */
export function getDataPath(): string {
    // Try multiple possible locations
    const possiblePaths = [
        // Development: relative to handler location
        path.resolve(__dirname, '../data'),
        // Packaged: next to executable (pkg unpacks to process.execPath directory)
        path.resolve(path.dirname(process.execPath), 'data'),
        // Packaged: in dist directory relative to executable
        path.resolve(path.dirname(process.execPath), 'dist/data'),
        // Fallback: current working directory
        path.resolve(process.cwd(), 'data'),
        path.resolve(process.cwd(), 'packages/server/data'),
    ];
    
    for (const dataPath of possiblePaths) {
        if (fsExtra.existsSync(dataPath)) {
            return dataPath;
        }
    }
    
    // Return the most likely path (development)
    return path.resolve(__dirname, '../data');
}

// https://github.com/andrasq/node-mongoid-js/blob/master/mongoid.js
export function mongoId(idstring: string) {
    if (typeof idstring !== 'string') idstring = String(idstring);
    return {
        timestamp: parseInt(idstring.slice(0, 0 + 8), 16),
        machineid: parseInt(idstring.slice(8, 8 + 6), 16),
        pid: parseInt(idstring.slice(14, 14 + 4), 16),
        sequence: parseInt(idstring.slice(18, 18 + 6), 16),
    };
}

export * as fs from 'fs-extra';
export * as yaml from 'js-yaml';

export function StaticHTML(context, randomHash) {
    // eslint-disable-next-line max-len
    return `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>@Ejunz/agent-edge</title></head><body><div id="root"></div><script>window.Context=JSON.parse('${JSON.stringify(context).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')</script><script src="/main.js?${randomHash}"></script></body></html>`;
}

export function decodeBinary(file: string, name: string) {
    if (process.env.NODE_ENV === 'development') return Buffer.from(file, 'base64');
    if ('Deno' in globalThis) return globalThis.Deno.readFileSync(name);
    const buf = decode(file);
    return gunzipSync(buf);
}

export * from './commandRunner';
export * from './printers';
export * from './color';
export * from './receipt';
export * from './metrics';
