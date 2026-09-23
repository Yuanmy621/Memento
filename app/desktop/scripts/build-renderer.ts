#!/usr/bin/env node
/**
 * 客户端构建脚本：渲染进程（JSX/React/`streamdown` → 单个 IIFE bundle + 单个 CSS）与 preload（`preload.ts` → CommonJS）。
 *
 * 渲染进程需要构建是因为浏览器不能直接跑 JSX，`file://` 下也没有 ES module 与裸包名解析，esbuild 把它们全部打进
 * 一个文件、界面用经典 `<script>` 加载；产物 `renderer/dist/renderer.js`、`renderer/dist/renderer.css` 与
 * `preload.cjs` 都是构建产物，不要手改。preload 也用构建产物：主进程能直接跑 `.ts`（Electron 的 Node 默认开
 * 类型擦除），沙箱化 preload 不行（见 `preload.ts` 的模块注释）。用法：直接跑构建，加 `--watch` 监听重建。
 *
 * @module Memento/desktop/scripts/build-renderer
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import type { BuildOptions, Plugin } from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const rendererDir = fileURLToPath(new URL('../renderer/', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const entryJs = `${rendererDir}src/main.tsx`
const entryCss = `${rendererDir}styles/app.css`
const outDir = `${rendererDir}dist`
const outJs = `${outDir}/renderer.js`
const outCss = `${outDir}/renderer.css`
/** preload 的源码与产物（产物与源码同目录：主进程按相对路径找它）。 */
const preloadEntry = `${rendererDir}../preload.ts`
const preloadOut = `${rendererDir}../preload.cjs`

const watch = process.argv.includes('--watch')

// dist 是构建产物，不入库；首次构建时目录还不存在。
mkdirSync(outDir, { recursive: true })

/**
 * 需要被 Tailwind 扫描的额外源码目录：`streamdown` 的类名在它自己的 `dist/*.js` 里，要显式 `@source` 告诉 Tailwind；
 * pnpm 的 `node_modules/<pkg>` 是指向 `.pnpm/<pkg>@<ver>/…` 的符号链接，扫描器不跟随，所以用 `realpathSync` 解真实路径。
 */
function scanSources(): string[] {
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
 * 把 Tailwind v4 与主题变量一起编译成一份 CSS。Tailwind v4 是 CSS-first 配置：
 * `@import "tailwindcss"` 引入引擎，`@source` 指定额外扫描目录，主题用 `@theme` 声明（见 `renderer/styles/app.css`）。
 */
async function buildCss() {
  const source = readFileSync(entryCss, 'utf8')
  const sources = scanSources().map(dir => `@source ${JSON.stringify(dir)};`).join('\n')
  const result = await postcss([tailwind()]).process(`${sources}\n${source}`, { from: entryCss })
  writeFileSync(outCss, result.css)
  return result.css.length
}

/**
 * 把 `preload.ts` 打成自包含的 CommonJS：`format: 'cjs'`（沙箱 preload 不支持 ESM）、`bundle: true`
 * （它不能 `require` 相对路径）、`external: ['electron']`（`electron` 由 Electron 在运行时提供）。返回产物体积（字节）。
 */
async function buildPreload(): Promise<number> {
  const result = await esbuild.build({
    entryPoints: [preloadEntry],
    outfile: preloadOut,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: ['node22'],
    external: ['electron'],
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  })
  return Object.values(result.metafile?.outputs ?? {}).reduce((total, output) => total + output.bytes, 0)
}

/** esbuild 的插件：把 `.css` 的 import 汇总，交给构建后的 CSS 产物处理。 */
const ignoreCssPlugin: Plugin = {
  name: 'ignore-css-imports',
  setup(build): void {
    // `streamdown` 的动画样式、shiki 的主题样式都是由 JS 里 `import 'x.css'` 引入的；
    // 浏览器端已经在加载编译好的 `renderer.css`，这里把它们标记为空避免重复打包。
    build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'ignored-css' }))
    build.onLoad({ filter: /.*/, namespace: 'ignored-css' }, () => ({ contents: '', loader: 'js' }))
  },
}

const jsOptions: BuildOptions = {
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
  /*
   * 图片一律内联成 data URL（应用图标只有 `assets/logo.png`）：`index.html` 的 CSP 是 `img-src 'self' data:`，
   * 内联进去既不用额外的复制步骤，也不用担心打包后相对路径算错。
   */
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  logLevel: 'info',
  metafile: true,
}

if (watch) {
  const context = await esbuild.context(jsOptions)
  await context.watch()
  const preloadContext = await esbuild.context({
    entryPoints: [preloadEntry],
    outfile: preloadOut,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: ['node22'],
    external: ['electron'],
    legalComments: 'none',
    logLevel: 'warning',
  })
  await preloadContext.watch()
  await Promise.all([buildCss(), buildPreload()])
  process.stdout.write('客户端构建完成（渲染进程 + preload），正在监听变化（Ctrl-C 退出）…\n')
} else {
  const [js, cssBytes, preloadBytes] = await Promise.all([esbuild.build(jsOptions), buildCss(), buildPreload()])
  const outputs = js.metafile?.outputs ?? {}
  const jsBytes = Object.values(outputs).reduce((total, output) => total + output.bytes, 0)
  process.stdout.write(
    `客户端构建完成：renderer.js ${(jsBytes / 1024).toFixed(0)} KB · renderer.css ${(cssBytes / 1024).toFixed(0)} KB`
    + ` · preload.cjs ${(preloadBytes / 1024).toFixed(1)} KB\n`,
  )
}
