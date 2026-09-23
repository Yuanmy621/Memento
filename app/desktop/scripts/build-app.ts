#!/usr/bin/env node
/**
 * 把要打包进应用的东西收拢成一个自包含目录 `build/app/`，交给 Electron Forge。
 *
 * 不直接打包仓库根：Forge 复制完项目会按生产依赖 prune，而它假定扁平的 `node_modules`，在 pnpm 的符号链接
 * 布局下会删掉仍在使用的包；这里用 `nodeLinker: hoisted` 在 staging 里重新物化一份扁平生产依赖，prune 便成了
 * 无害的空操作。只带运行时需要的东西（渲染进程 bundle、host/CLI/MCP 源码、主进程文件），目录结构照抄 `app/desktop/`，
 * `main.js` 里按 `import.meta.url` 算的资源路径因此不用改；用法 `node app/desktop/scripts/build-app.ts`，加 `--refresh` 强制重装。
 *
 * @module Memento/desktop/scripts/build-app
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const desktopDir = join(repoRoot, 'app/desktop')
const appDir = join(repoRoot, 'build/app')
const refresh = process.argv.includes('--refresh')

/** 打日志（带阶段名，便于在 Forge 的输出里分辨）。 */
function log(message: string): void {
  process.stdout.write(`[app:build] ${message}\n`)
}

/**
 * 复制一个路径（文件或目录），自动建父目录；`from` 相对仓库根、`to` 相对 `build/app`，绝对路径也接受。
 */
function copy(from: string, to: string): void {
  const source = resolve(repoRoot, from)
  const target = resolve(appDir, to)
  if (!existsSync(source)) throw new Error(`要复制的东西不存在：${from}`)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
}

/** 目录体积（MB，一位小数）。 */
function sizeOf(path: string): string {
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8' })
  if (result.status !== 0) return '?'
  return `${(Number(result.stdout.split(/\s+/)[0]) / 1024).toFixed(1)} MB`
}

// ── 0. 渲染进程要先构建 ──────────────────────────────────────────────────────
const bundle = join(desktopDir, 'renderer/dist/renderer.js')
const bridge = join(desktopDir, 'preload.cjs')
if (!existsSync(bundle) || !existsSync(bridge)) {
  throw new Error('客户端还没构建：先跑 `npm run build:renderer`（`npm run app:build` 里已经带了）')
}

// ── 1. 清空上次的产物（保留 node_modules 以支持增量）────────────────────────
// 逐个删容易漏，漏掉的那个会跟着一起进 asar；所以按白名单清：
// 留下 node_modules 与依赖安装产物，其余全清。
mkdirSync(appDir, { recursive: true })
for (const entry of readdirSync(appDir)) {
  if (entry === 'node_modules' || entry === 'package.json' || entry === 'pnpm-lock.yaml' || entry === 'pnpm-workspace.yaml') continue
  rmSync(join(appDir, entry), { recursive: true, force: true })
}

// ── 2. 生产依赖：在 staging 里用扁平布局重新物化一份 ─────────────────────────
// 不复制现有的 node_modules：那是符号链接布局（见文件头），Forge 的 prune 在那种布局下会删错东西；
// 这里的安装不碰仓库自己的 node_modules，两边互不影响。
const stagedManifest = join(appDir, 'package.json')
const repoManifest = join(repoRoot, 'package.json')
const stagedLock = join(appDir, 'pnpm-lock.yaml')
const repoLock = join(repoRoot, 'pnpm-lock.yaml')
const workspaceManifest = join(appDir, 'pnpm-workspace.yaml')

// 依赖没变 + node_modules 已存在 → 跳过安装（打包会快很多）。
const lockUnchanged = existsSync(stagedLock)
  && readFileSync(stagedLock, 'utf8') === readFileSync(repoLock, 'utf8')
const haveModules = existsSync(join(appDir, 'node_modules'))
if (refresh || !lockUnchanged || !haveModules) {
  log('物化生产依赖（hoisted，约 20s）…')
  cpSync(repoManifest, stagedManifest)
  cpSync(repoLock, stagedLock)
  // 复制 pnpm 的仓库配置并加上 nodeLinker: hoisted：那个文件还声明了 allowBuilds
  // （node-pty / koffi 的原生安装脚本要跑）与 peer 对齐规则，缺了它 pnpm 会拒绝执行构建脚本。
  const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  writeFileSync(workspaceManifest, `# 由 app/desktop/scripts/build-app.ts 生成：\n# ① 只装生产依赖；② 用扁平布局，好让 Forge 的 prune 正确工作。\nnodeLinker: hoisted\n\n${workspace}`)
  const install = spawnSync('pnpm', ['install', '--prod', '--frozen-lockfile'], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_node_linker: 'hoisted' },
  })
  if (install.status !== 0) throw new Error(`pnpm install 失败（退出码 ${String(install.status)}）`)
} else {
  log('依赖没变，跳过安装（要强制重装加 --refresh）')
}

// ── 3. 生成给 Forge 看的 package.json ────────────────────────────────────────
// 三个字段不能省：`"type": "module"`（主进程与 host 都是 ESM，丢了会按 CJS 解析，启动报
// `Cannot use import statement outside a module`）、`dependencies`（prune 按它算生产依赖，空对象会删光
// node_modules）、`config.forge` 与 `devDependencies.electron`（`resolveDir()` 逐级向上找项目目录，缺了会认到
// 仓库根的 `@electron-forge/cli` 上；`getElectronVersion()` 读它决定打包哪版 Electron，写精确版本就不必真装）。
interface RepoManifest {
  readonly version: string
  readonly description?: string
  readonly license?: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}
const repoPkg: RepoManifest = JSON.parse(readFileSync(repoManifest, 'utf8')) as RepoManifest
const electronSpec = repoPkg.devDependencies?.['electron']
if (typeof electronSpec !== 'string') throw new Error('仓库 package.json 里没有 devDependencies.electron')
/** 精确版本：仓库里写的是 `44.4.1` 这种就直接用，写了范围就读实际安装的版本。 */
function exactElectronVersion(spec: string): string {
  if (/^\d+\.\d+\.\d+/.test(spec)) return spec
  const installed = join(repoRoot, 'node_modules/electron/package.json')
  if (!existsSync(installed)) throw new Error(`electron 写的是范围 "${spec}"，但没装，无法确定精确版本`)
  const pkg: { version?: unknown } = JSON.parse(readFileSync(installed, 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string') throw new Error('node_modules/electron/package.json 里没有 version')
  return pkg.version
}
const electronVersion = exactElectronVersion(electronSpec)
writeFileSync(stagedManifest, `${JSON.stringify({
  name: 'Memento-agent',
  productName: 'Memento Agent',
  version: repoPkg.version,
  description: repoPkg.description,
  license: repoPkg.license,
  author: 'Memento',
  type: 'module',
  main: 'desktop/main.ts',
  config: { forge: './forge.config.ts' },
  dependencies: repoPkg.dependencies,
  devDependencies: { electron: electronVersion },
}, null, 2)}\n`)

// ── 4. 运行时文件 ────────────────────────────────────────────────────────────
log('复制运行时文件…')
// 主进程的 main.ts + ipc.ts 由 Electron 自己擦类型直接跑；preload 则要构建产物 preload.cjs ——
// 沙箱 preload 不认 .ts，见 preload.ts 的注释。
copy('app/desktop/main.ts', 'desktop/main.ts')
copy('app/desktop/ipc.ts', 'desktop/ipc.ts')
copy('app/desktop/preload.ts', 'desktop/preload.ts')
copy('app/desktop/preload.cjs', 'desktop/preload.cjs')
// 内核宿主子进程（.ts 由 Electron 自带的 Node 做类型擦除直接跑，与开发时一致）
copy('app/desktop/host', 'desktop/host')
// 界面：index.html + 构建产物（styles/ 与 src/ 是构建输入，运行时不需要）
copy('app/desktop/renderer/index.html', 'desktop/renderer/index.html')
copy('app/desktop/renderer/dist', 'desktop/renderer/dist')
// host 会 import ../../cli/*.ts
copy('app/cli', 'cli')
// 内置 MCP 服务器：app/cli/kernel.ts 按 `../mcp/butian/server.ts` 相对解析并拉起
copy('app/mcp', 'mcp')
// 应用图标：Forge 按 `packagerConfig.icon: 'assets/icon'` 找 `assets/icon.icns`（macOS）
// 或 `assets/icon.ico`（Windows）—— 路径相对 staging 根目录。
copy('app/desktop/assets', 'assets')
// Forge 配置（Forge 用 jiti 加载 .ts，见 forge.config.ts 的注释）
copy('app/desktop/forge.config.ts', 'forge.config.ts')

// ── 4b. electron 的「占位包」 ────────────────────────────────────────────────
// Forge 的 `flora-colossus` 要求每个 devDependency 物理存在（否则 `Failed to locate module "electron"`），
// 而它的向上查找 `dirname(dirname(testPath))` 从 `build/app` 出发会跳过仓库根，所以占位包得有；
// Forge 只用那行版本号（二进制由 `@electron/get` 准备），`pnpm add -D electron` 会白拖进 250MB 的 dist。
const electronPackage = join(appDir, 'node_modules/electron')
if (!existsSync(electronPackage)) {
  log('放 electron 占位包（只给 Forge 的依赖遍历看版本号）')
  mkdirSync(electronPackage, { recursive: true })
  writeFileSync(join(electronPackage, 'package.json'), `${JSON.stringify({
    name: 'electron',
    version: electronVersion,
    private: true,
    description: '打包 staging 占位包：真正的 Electron 由 Electron Forge 的 @electron/get 按这个版本号准备',
    main: 'index.js',
  }, null, 2)}\n`)
  writeFileSync(join(electronPackage, 'index.js'), "throw new Error('这是打包 staging 的占位包，不该被运行时 require；真正的 Electron 在 App 里。')\n")
}

// ── 4c. 语法自检：配置文件的解析错误要在这里就报出来 ─────────────────────────
// Forge 加载配置失败时只报 `Failed to load: …` 与 `Unexpected token '.'`，不给行号；`node --check`
// 会带行号指出解析错误（块注释里写裸 glob 字面量会提前结束注释，是常见原因）。
{
  const configPath = join(appDir, 'forge.config.ts')
  // `node --check` 对 `.ts` 也有效（Node 24 默认开类型擦除），这里要的是能否被解析，
  // 类型正确性由 `npm run typecheck` 管。
  const check = spawnSync(process.execPath, ['--check', configPath], { encoding: 'utf8' })
  if (check.status !== 0) {
    throw new Error(`forge.config.ts 语法错误：\n${check.stderr.trim()}`)
  }
}

// ── 5. 自检：几个「缺了就会静默降级」的点 ────────────────────────────────────
const mustHave = [
  'package.json',
  'forge.config.ts',
  'desktop/main.ts',
  'desktop/ipc.ts',
  'desktop/preload.cjs',
  'desktop/host/index.ts',
  'desktop/renderer/index.html',
  'assets/icon.icns',
  'desktop/renderer/dist/renderer.js',
  'desktop/renderer/dist/renderer.css',
  'cli/kernel.ts',
  'mcp/butian/server.ts',
  'node_modules/@deepseek-ai/dsh-agent',
  'node_modules/node-pty',
  'node_modules/electron/package.json',
]
const missing = mustHave.filter((relative: string) => !existsSync(join(appDir, relative)))
if (missing.length > 0) throw new Error(`staging 缺文件：${missing.join('、')}`)

// node_modules 应为真实目录：符号链接布局正是 Forge 的 prune 删错东西的根源。
if (statSync(join(appDir, 'node_modules')).isSymbolicLink()) {
  throw new Error('node_modules 是符号链接：nodeLinker 没生效，Forge 的 prune 会删错东西')
}

log(`staging 就绪：build/app（node_modules ${sizeOf(join(appDir, 'node_modules'))}，总计 ${sizeOf(appDir)}）`)
log('下一步：npm run package（出 .app）或 npm run make（出 zip/dmg）')
