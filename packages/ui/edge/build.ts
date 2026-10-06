import path from 'node:path';
import fs from 'fs-extra';
import webpack from 'webpack';
import WebpackDevServer from 'webpack-dev-server';
import cac from 'cac';
import { Logger } from '@ejunz/utils';

const argv = cac().parse();
const { dev = false, watch = false, production = false } = argv.options;
const compiler = webpack({
  mode: production ? 'production' : 'development',
  entry: './app/index.tsx',
  output: { path: path.resolve(__dirname, 'dist'), filename: 'main.js' },
  resolve: { extensions: ['.js', '.jsx', '.ts', '.tsx'] },
  module: { rules: [{ test: /\.[jt]sx?$/, use: [{ loader: 'esbuild-loader', options: { loader: 'tsx', target: 'es2018' } }] }, { test: /\.css$/, use: ['style-loader', 'css-loader'] }] },
  plugins: [
    new webpack.ProgressPlugin(),
    new webpack.ProvidePlugin({ React: 'react' }),
    ...(dev ? [new (require('html-webpack-plugin'))({ template: path.resolve(__dirname, 'index.html'), inject: 'body' })] : []),
  ],
});

const logger = new Logger('edge-ui-build');
(async () => {
  if (dev) {
    const server = new WebpackDevServer({
      port: 8082,
      server: 'http',
      allowedHosts: 'all',
      historyApiFallback: true,
      proxy: [{ context: (pathname) => !pathname.startsWith('/main.js') && !pathname.startsWith('/index.html') && !pathname.startsWith('/webpack'), target: process.env.EDGE_API || 'http://localhost:5283', ws: true, changeOrigin: true }],
    }, compiler);
    await server.start();
    return;
  }
  const callback = (error: Error, stats: webpack.Stats) => {
    if (error || stats.hasErrors()) {
      logger.error(error?.stack || stats.toString());
      if (!watch) process.exit(1);
    }
    if (!watch) {
      fs.ensureDirSync(path.resolve(__dirname, '../../data'));
      fs.copyFileSync(path.resolve(__dirname, 'dist/main.js'), path.resolve(__dirname, '../../data/static.edge-ui'));
    }
  };
  if (watch) compiler.watch({}, callback);
  else compiler.run(callback);
})();
