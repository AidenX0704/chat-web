import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /**
   * 后端服务地址，注入为 __BACKEND_ORIGIN__。
   * 默认 `'/'` 表示同源接入后端（开发时由 devServer 代理 `/api`，生产由 nginx 转发 `/api`）；
   * 传完整地址（如 `https://api.example.com`）表示跨站部署；
   * 传 `''` 或 `'none'` 表示纯静态部署：浏览器直连 apiOrigin，使用本机保存的 API Key。
   */
  backendOrigin?: string
  /** 开发模式下 `/api` 代理转发目标，默认 `http://127.0.0.1:8787` */
  apiProxyTarget?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  // 默认同源接入后端 API；纯静态部署用 BACKEND_ORIGIN=none pnpm build
  backendOrigin = process.env.BACKEND_ORIGIN ?? '/',
  apiProxyTarget = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787').replace(/\/+$/, ''),
  devServer,
}: ConfigOptions = {}): Configuration => {
  const isSameOriginBackend = backendOrigin === '/' || backendOrigin === 'same-origin'
  const webPort = Number(process.env.WEB_PORT) || 8090
  return {
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
      { test: /\.(png|jpe?g|webp|svg|ico)$/i, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      favicon: './src/assets/favicon.png',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __BACKEND_ORIGIN__: JSON.stringify(backendOrigin),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' }],
    }),
  ],
  performance: { hints: false },
  devServer: {
    port: webPort,
    // 关闭响应压缩，避免 SSE（聊天流式回复与多端实时同步）被 devServer 缓冲
    compress: false,
    // 前端路由交给 index.html：分享链接 /s/<token> 也要能直接打开
    historyApiFallback: true,
    ...(isSameOriginBackend
      ? {
          proxy: [
            {
              context: ['/api'],
              target: apiProxyTarget,
              // 保持原始 Host，与浏览器 Origin 一致，通过服务端同源 CSRF 校验
              changeOrigin: false,
            },
          ],
        }
      : {}),
    ...devServer,
  },
  }
}

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
