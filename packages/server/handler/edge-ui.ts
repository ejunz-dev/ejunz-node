// @ts-nocheck
import path from 'node:path';
import { Context } from 'cordis';
import { isEdgeMode } from '../config';
import { fs, Logger } from '../utils';
import { resolveUiAssetPath } from '../../ui';
import { AuthHandler } from './edge-auth';

const logger = new Logger('handler/edge-ui');
const uiNextInjectionMarker = '<!-- __EJUNZ_INJECTION__DO_NOT_REMOVE_THIS__ -->';

function injectUiNextPageData(html: string, data: Record<string, unknown>) {
    if (!html.includes(uiNextInjectionMarker)) throw new Error('ui-next HTML injection marker is missing');
    const json = JSON.stringify(data).replace(/</g, String.fromCharCode(92) + 'u003c');
    return html.replace(uiNextInjectionMarker, `<script id="__EJUNZ_INJECTION__" type="application/json">${json}</script>`);
}

function edgeUiNextDirectory() {
    return resolveUiAssetPath(__dirname, 'data/static.edge-ui-next', '../../data/static.edge-ui-next');
}

function registerEdgeUiRenderer(ctx: Context) {
    ctx.server.registerRenderer('edge-ui-next', {
        name: 'edge-ui-next',
        accept: ['edge-ui-next'],
        output: 'html',
        asFallback: false,
        priority: 100,
        render: (_name: string, args: any, context: any) => {
            const htmlPath = path.join(edgeUiNextDirectory(), 'index.html');
            const html = fs.readFileSync(htmlPath, 'utf8');
            const { pageName = 'edge_dashboard', ...pageArgs } = args || {};
            return injectUiNextPageData(html, {
                EJUNZ_INJECTED: true,
                name: String(pageName),
                template: '',
                args: { UserContext: {}, UiContext: {}, ...pageArgs },
                url: String(context?.handler?.context?.req?.url || '/'),
                route_map: ctx.server.routeMap,
            });
        },
    });
}

class EdgeUINextPageHandler extends AuthHandler {
    pageName = 'edge_dashboard';
    authFailureBody = 'Authentication required';

    async get() {
        this.response.type = 'text/html';
        if (!fs.existsSync(path.join(edgeUiNextDirectory(), 'index.html'))) {
            this.response.status = 503;
            this.response.body = 'Edge ui-next build is missing. Run `yarn build:ui`.';
            return;
        }
        try {
            this.response.body = await this.renderHTML('edge-ui-next', { pageName: this.pageName });
        } catch (error) {
            logger.error('Failed to render ui-next Edge page: %s', (error as Error).message);
            this.response.status = 500;
            this.response.body = 'Failed to render Edge ui-next page.';
        }
    }
}

class EdgeUIHomeHandler extends EdgeUINextPageHandler {
    pageName = 'edge_dashboard';
}
class EdgeUIDevicesHandler extends EdgeUINextPageHandler {
    pageName = 'edge_devices';
}
class EdgeUINodesHandler extends EdgeUINextPageHandler {
    pageName = 'edge_nodes';
}
class EdgeUIUpstreamHandler extends EdgeUINextPageHandler {
    pageName = 'edge_upstream';
}
class EdgeUIChatHandler extends EdgeUINextPageHandler {
    pageName = 'edge_chat';
}
class EdgeUIConfigHandler extends EdgeUINextPageHandler {
    pageName = 'edge_config';
}
class EdgeUIAuthHandler extends EdgeUINextPageHandler {
    pageName = 'edge_auth';
}

class EdgeUINextAssetHandler extends AuthHandler {
    authFailureBody = 'Authentication required';

    async get() {
        const assetName = String((this.request as any).params?.assetName || '');
        if (!/^[a-zA-Z0-9._-]+$/.test(assetName)) {
            this.response.status = 404;
            this.response.body = '';
            return;
        }
        const assetPath = path.join(edgeUiNextDirectory(), 'assets', assetName);
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

export function apply(ctx: Context) {
    if (!isEdgeMode) return;
    registerEdgeUiRenderer(ctx);
    ctx.Route('edge-ui-home', '/', EdgeUIHomeHandler);
    ctx.Route('edge-ui-home-page', '/edge-ui', EdgeUIHomeHandler);
    ctx.Route('edge-ui-devices', '/edge-ui/devices', EdgeUIDevicesHandler);
    ctx.Route('edge-ui-nodes', '/edge-ui/nodes', EdgeUINodesHandler);
    ctx.Route('edge-ui-upstream', '/edge-ui/upstream', EdgeUIUpstreamHandler);
    ctx.Route('edge-ui-chat', '/edge-ui/chat', EdgeUIChatHandler);
    ctx.Route('edge-ui-config', '/edge-ui/config', EdgeUIConfigHandler);
    ctx.Route('edge-ui-auth', '/edge-ui/auth', EdgeUIAuthHandler);
    ctx.Route('edge-ui-next-assets', '/edge-ui/assets/:assetName', EdgeUINextAssetHandler);
}
