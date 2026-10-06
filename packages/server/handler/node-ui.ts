// @ts-nocheck
import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import { createUiPage, createUiScriptPath, readUiBundle, resolveUiAssetPath } from '../../ui';
import { fs, Logger, randomstring } from '../utils';

const logger = new Logger('handler/node-ui');
const randomHash = randomstring(8).toLowerCase();

// 提供Node UI的HTML页面
class NodeUIHomeHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        const context = {
            secretRoute: '',
            contest: { id: 'node-mode', name: 'Node Dashboard' },
        };
        if (this.request.headers.accept === 'application/json') {
            this.response.body = context;
        } else {
            this.response.type = 'text/html';
            // 在生产模式下，从 /node-ui/main.js 加载
            // 检查构建文件是否存在，如果不存在则提示需要构建
            const bundlePath = resolveUiAssetPath(__dirname, 'data/static.node-ui', '../../data/static.node-ui');
            const hasBundle = fs.existsSync(bundlePath);
            const scriptPath = createUiScriptPath('/node-ui/main.js', hasBundle, randomHash);
            this.response.body = createUiPage({ title: 'Node Dashboard - Ejunz Node', scriptPath, context });
        }
    }
}

// 提供Node UI的静态JS bundle
class NodeUIStaticHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        this.response.addHeader('Cache-Control', 'public');
        this.response.addHeader('Expires', new Date(new Date().getTime() + 86400000).toUTCString());
        this.response.type = 'text/javascript';
        const bundlePath = resolveUiAssetPath(__dirname, 'data/static.node-ui', '../../data/static.node-ui');
        if (!fs.existsSync(bundlePath)) {
            logger.warn('Node UI bundle not found. Please run `yarn build:ui` in packages/ui/node.');
            this.response.body = '';
            return;
        }
        try {
            this.response.body = readUiBundle(bundlePath, '');
        } catch (error) {
            logger.error('Failed to load Node UI bundle: %s', (error as Error).message);
            this.response.body = '';
        }
    }
}

export async function apply(ctx: Context) {
    // 只在node模式下注册
    if (process.argv.includes('--node')) {
        ctx.Route('node-ui-home', '/node-ui', NodeUIHomeHandler);
        ctx.Route('node-ui-static', '/node-ui/main.js', NodeUIStaticHandler);
        // 也支持根路径重定向到node-ui
        ctx.Route('node-ui-root', '/', NodeUIHomeHandler);
    }
}

