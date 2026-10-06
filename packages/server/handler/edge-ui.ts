// @ts-nocheck
import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { isEdgeMode } from '../config';
import { fs, Logger, randomstring } from '../utils';
import { createUiPage, createUiScriptPath, readUiBundle, resolveUiAssetPath } from '../../ui';
import { isEdgeAdminAuthorized } from './edge-auth';

const logger = new Logger('handler/edge-ui');
const randomHash = randomstring(8).toLowerCase();

class EdgeUIHomeHandler extends Handler<Context> {
    async get() {
        if (!isEdgeAdminAuthorized(this.request)) {
            this.response.status = 401;
            this.response.addHeader('WWW-Authenticate', 'Basic realm="Ejunz Edge"');
            this.response.body = 'Authentication required';
            return;
        }
        const bundlePath = resolveUiAssetPath(__dirname, 'data/static.edge-ui', '../../data/static.edge-ui');
        const scriptPath = createUiScriptPath('/edge-ui/main.js', fs.existsSync(bundlePath), randomHash);
        this.response.type = 'text/html';
        this.response.body = createUiPage({ title: 'Ejunz Edge', scriptPath });
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
        const bundlePath = resolveUiAssetPath(__dirname, 'data/static.edge-ui', '../../data/static.edge-ui');
        this.response.type = 'text/javascript';
        if (!fs.existsSync(bundlePath)) {
            logger.warn('Edge UI bundle not found. Run yarn build:ui.');
            this.response.body = '';
            return;
        }
        try {
            this.response.body = readUiBundle(bundlePath, '');
        } catch (error) {
            logger.error('Failed to load Edge UI bundle: %s', (error as Error).message);
            this.response.body = '';
        }
    }
}

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    ctx.Route('edge-ui-home', '/edge-ui', EdgeUIHomeHandler);
    ctx.Route('edge-ui-static', '/edge-ui/main.js', EdgeUIStaticHandler);
    ctx.Route('edge-ui-root', '/', EdgeUIHomeHandler);
}
