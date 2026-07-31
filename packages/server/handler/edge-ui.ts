// @ts-nocheck
import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import path from 'node:path';
import { isEdgeMode } from '../config';
import { fs, randomstring } from '../utils';
import { isEdgeAdminAuthorized } from './edge-auth';

const randomHash = randomstring(8).toLowerCase();

class EdgeUIHomeHandler extends Handler<Context> {
    async get() {
        if (!isEdgeAdminAuthorized(this.request)) {
            this.response.status = 401;
            this.response.addHeader('WWW-Authenticate', 'Basic realm="Ejunz Edge"');
            this.response.body = 'Authentication required';
            return;
        }
        const bundlePath = path.resolve(__dirname, '../data/static.edge-ui');
        const scriptPath = `/edge-ui/main.js${fs.existsSync(bundlePath) ? `?${randomHash}` : ''}`;
        this.response.type = 'text/html';
        this.response.body = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ejunz Edge</title></head><body><div id="root"></div><script src="${scriptPath}"></script></body></html>`;
    }
}

class EdgeUIStaticHandler extends Handler<Context> {
    async get() {
        if (!isEdgeAdminAuthorized(this.request)) {
            this.response.status = 401;
            this.response.addHeader('WWW-Authenticate', 'Basic realm="Ejunz Edge"');
            this.response.body = 'Authentication required';
            return;
        }
        const bundlePath = path.resolve(__dirname, '../data/static.edge-ui');
        this.response.type = 'text/javascript';
        if (fs.existsSync(bundlePath)) this.response.body = fs.readFileSync(bundlePath, 'utf8');
        else this.response.body = 'console.error("Edge UI bundle not found. Run yarn build:ui.")';
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    ctx.Route('edge-ui-home', '/edge-ui', EdgeUIHomeHandler);
    ctx.Route('edge-ui-static', '/edge-ui/main.js', EdgeUIStaticHandler);
    ctx.Route('edge-ui-root', '/', EdgeUIHomeHandler);
}
