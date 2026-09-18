#!/usr/bin/env node
/**
 * 渲染进程构建脚本：JSX/React/Streamdown → 单个 IIFE bundle + 单个 CSS。
 *
 * 为什么渲染进程需要构建（而主进程与 host 不需要）：
 *   Streamdown 是一个 React 组件，依赖 React 运行时与 Tailwind 生成的样式。
 *   浏览器不能直接跑 JSX，`file://` 下也不能做 ES module 解析与裸包名解析，
 *   所以这里用 esbuild 把它们**全部打进一个文件**，界面用经典 `<script>` 加载。
 *
 * 产物（不要手改，改源码后重新构建）：
 *   renderer/dist/renderer.js     —— IIFE，包含 React + Streamdown + 我们的组件
 *   renderer/dist/renderer.css    —— Tailwind 产出 + 我们的主题变量
 *
 * 用法:
 *   node app/desktop/scripts/build-renderer.js            # 构建
 *   node app/desktop/scripts/build-renderer.js --watch    # 监听重建
 *
 * @module YuanMy/desktop/scripts/build-renderer
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const rendererDir = fileURLToPath(new URL('../renderer/', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const entryJs = `${rendererDir}src/main.tsx`
const entryCss = `${rendererDir}styles/app.css`
const outDir = `${rendererDir}dist`
const outJs = `${outDir}/renderer.js`
const outCss = `${outDir}/renderer.css`

const watch = process.argv.includes('--watch')

// dist 是构建产物，不入库；首次构建时目录还不存在。
mkdirSync(outDir, { recursive: true })

/**
 * 需要被 Tailwind 扫描的额外源码目录。
 *
 * 为什么要在构建脚本里算，而不是在 CSS 里写死相对路径：
 *   Streamdown 的类名在它自己的 `dist/*.js` 里，必须显式 `@source` 告诉 Tailwind。
 *   而 pnpm 的 `node_modules/<pkg>` 是**指向 `.pnpm/<pkg>@<ver>/…` 的符号链接**，
 *   Tailwind 的扫描器默认不跟随符号链接，写相对路径会静默扫不到（样式看着像丢了）。
 *   这里用 `realpathSync` 把真实路径解出来，npx / pnpm / npm 三种布局都成立。
 * @returns {string[]} 绝对路径列表（不存在的直接跳过）。
 */
function scanSources() {
  const packages = ['streamdown', '@streamdown/code', '@streamdown/cjk']
  const dirs = [`${rendererDir}src`]
  for (const name of packages) {
    try {
      dirs.push(realpathSync(`${projectRoot}node_modules/${name}/dist`))
    } catch {
      // 没装这个包就算了（插件是可选的）。
    }
  }
  return dirs
}

/**
 * 把 Tailwind v4 + 我们的主题一起编译成一份 CSS。
 *
 * Tailwind v4 是 CSS-first 配置：`@import "tailwindcss"` 引入引擎，
 * `@source` 指定额外扫描目录，主题用 `@theme` 声明 —— 见 `renderer/styles/app.css`。
 */
async function buildCss() {
  const source = readFileSync(entryCss, 'utf8')
  const sources = scanSources().map(dir => `@source ${JSON.stringify(dir)};`).join('\n')
  const result = await postcss([tailwind()]).process(`${sources}\n${source}`, { from: entryCss })
  writeFileSync(outCss, result.css)
  return result.css.length
}

/** esbuild 的插件：把 `.css` 的 import 汇总，交给构建后的 CSS 产物处理。 */
const ignoreCssPlugin = {
  name: 'ignore-css-imports',
  setup(build) {
    // Streamdown 的动画样式、shiki 的主题样式都是由 JS 里 `import 'x.css'` 引入的；
    // 浏览器端已经在加载我们编译好的 renderer.css，这里把它们标记为空避免重复打包。
    build.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'ignored-css' }))
    build.onLoad({ filter: /.*/, namespace: 'ignored-css' }, () => ({ contents: '', loader: 'js' }))
  },
}

const jsOptions = {
  entryPoints: [entryJs],
  outfile: outJs,
  bundle: true,
  // IIFE：`file://` 下没有模块解析，经典 <script> 只能加载非模块脚本。
  format: 'iife',
  platform: 'browser',
  target: ['chrome130'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  plugins: [ignoreCssPlugin],
  logLevel: 'info',
  metafile: true,
}

if (watch) {
  const context = await esbuild.context(jsOptions)
  await context.watch()
  await buildCss()
  process.stdout.write('渲染进程构建完成，正在监听变化（Ctrl-C 退出）…\n')
} else {
  const [js, cssBytes] = await Promise.all([esbuild.build(jsOptions), buildCss()])
  const jsBytes = Object.values(js.metafile.outputs).reduce((total, output) => total + output.bytes, 0)
  process.stdout.write(
    `渲染进程构建完成：dist/renderer.js ${(jsBytes / 1024).toFixed(0)} KB · dist/renderer.css ${(cssBytes / 1024).toFixed(0)} KB\n`,
  )
}
