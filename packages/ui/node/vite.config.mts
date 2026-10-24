import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, 'ui');
const uiNextRoot = path.dirname(require.resolve('@ejunz/ui-next', { paths: [__dirname] }));
const resolveUiNext = (id: string) => require.resolve(id, { paths: [uiNextRoot] });

export default defineConfig(({ command }) => ({
    root: uiRoot,
    base: command === 'serve' ? '/' : '/node-ui/',
    plugins: [react()],
    resolve: {
        alias: [
            { find: /^@ejunz\/ui-next\/context\/(.+)$/, replacement: `${uiNextRoot}/src/context/$1` },
            { find: /^@ejunz\/ui-next\/registry\/(.+)$/, replacement: `${uiNextRoot}/src/registry/$1` },
            { find: '@ejunz/ui-next/app', replacement: `${uiNextRoot}/src/app.tsx` },
            { find: '@ejunz/ui-next/globals', replacement: `${uiNextRoot}/src/globals.ts` },
            { find: /^@\//, replacement: `${path.join(uiNextRoot, 'src')}/` },
            { find: /^react$/, replacement: resolveUiNext('react') },
            { find: /^react\/jsx-runtime$/, replacement: resolveUiNext('react/jsx-runtime') },
            { find: /^react\/jsx-dev-runtime$/, replacement: resolveUiNext('react/jsx-dev-runtime') },
            { find: /^react-dom$/, replacement: resolveUiNext('react-dom') },
            { find: /^react-dom\/client$/, replacement: resolveUiNext('react-dom/client') },
        ],
        dedupe: ['react', 'react-dom'],
    },
    server: {
        host: '0.0.0.0',
        port: 8081,
        proxy: [
            { context: ['/api', '/zigbee2mqtt', '/zigbee-console', '/zigbee-ws'], target: process.env.NODE_API || 'http://localhost:5284', changeOrigin: true, ws: true },
        ],
    },
    publicDir: false,
    build: {
        outDir: path.resolve(__dirname, '../../data/static.node-ui-next'),
        emptyOutDir: true,
        assetsDir: 'assets',
        rollupOptions: { input: path.join(uiRoot, 'index.html') },
    },
}));
