// @ts-nocheck
import path from 'node:path';
import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import { resolveUiAssetPath } from '../../ui';
import { fs, Logger } from '../utils';

const logger = new Logger('handler/node-ui');
const uiNextInjectionMarker = '<!-- __EJUNZ_INJECTION__DO_NOT_REMOVE_THIS__ -->';

function injectUiNextPageData(html: string, data: Record<string, unknown>) {
    if (!html.includes(uiNextInjectionMarker)) throw new Error('ui-next HTML injection marker is missing');
    const json = JSON.stringify(data).replace(/</g, String.fromCharCode(92) + 'u003c');
    return html.replace(uiNextInjectionMarker, `<script id="__EJUNZ_INJECTION__" type="application/json">${json}</script>`);
}

function nodeUiNextDirectory() {
    return resolveUiAssetPath(__dirname, 'data/static.node-ui-next', '../../data/static.node-ui-next');
}

function registerNodeUiRenderer(ctx: Context) {
    ctx.server.registerRenderer('node-ui-next', {
        name: 'node-ui-next',
        accept: ['node-ui-next'],
        output: 'html',
        asFallback: false,
        priority: 100,
        render: (_name: string, args: any, context: any) => {
            const htmlPath = path.join(nodeUiNextDirectory(), 'index.html');
            const html = fs.readFileSync(htmlPath, 'utf8');
            const { pageName = 'node_dashboard', ...pageArgs } = args || {};
            return injectUiNextPageData(html, {
                EJUNZ_INJECTED: true,
                name: String(pageName),
                template: '',
                args: { UserContext: {}, UiContext: {}, ...pageArgs },
                url: String(context?.handler?.context?.req?.url || '/node-ui'),
                route_map: ctx.server.routeMap,
            });
        },
    });
}

class NodeUIHomeHandler extends Handler<Context> {
    noCheckPermView = true;
    pageName = 'node_dashboard';

    async get() {
        const context = {
            secretRoute: '',
            contest: { id: 'node-mode', name: 'Node Dashboard' },
        };
        if (this.request.headers.accept === 'application/json') {
            this.response.body = context;
            return;
        }
        this.response.type = 'text/html';
        const nextHtml = path.join(nodeUiNextDirectory(), 'index.html');
        if (!fs.existsSync(nextHtml)) {
            this.response.status = 503;
            this.response.body = 'Node ui-next build is missing. Run `yarn build:ui`.';
            return;
        }
        try {
            this.response.body = await this.renderHTML('node-ui-next', { pageName: this.pageName });
        } catch (error) {
            logger.error('Failed to render ui-next Node page: %s', (error as Error).message);
            this.response.status = 500;
            this.response.body = 'Failed to render Node ui-next page.';
        }
    }
}

class NodeUIConsoleHandler extends NodeUIHomeHandler {
    pageName = 'node_console';
}

class NodeUISettingsHandler extends NodeUIHomeHandler {
    pageName = 'node_settings';
}

class NodeUINextAssetHandler extends Handler<Context> {
    noCheckPermView = true;

    async get() {
        const assetName = String((this.request as any).params?.assetName || '');
        if (!/^[a-zA-Z0-9._-]+$/.test(assetName)) {
            this.response.status = 404;
            this.response.body = '';
            return;
        }
        const assetRoot = path.join(nodeUiNextDirectory(), 'assets');
        const assetPath = path.join(assetRoot, assetName);
        if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
            this.response.status = 404;
            this.response.body = '';
            return;
        }
        const contentTypes: Record<string, string> = {
            '.css': 'text/css',
            '.js': 'text/javascript',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
        };
        this.response.type = contentTypes[path.extname(assetName).toLowerCase()] || 'application/octet-stream';
        this.response.addHeader('Cache-Control', 'public, max-age=86400, immutable');
        this.response.body = fs.readFileSync(assetPath);
    }
}

export async function apply(ctx: Context) {
    if (!process.argv.includes('--node')) return;
    registerNodeUiRenderer(ctx);
    ctx.Route('node-ui-home', '/node-ui', NodeUIHomeHandler);
    ctx.Route('node-ui-console', '/node-ui/console', NodeUIConsoleHandler);
    ctx.Route('node-ui-settings', '/node-ui/settings', NodeUISettingsHandler);
    ctx.Route('node-ui-next-assets', '/node-ui/assets/:assetName', NodeUINextAssetHandler);
    ctx.Route('node-ui-root', '/', NodeUIHomeHandler);
}

