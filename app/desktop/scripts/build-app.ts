#!/usr/bin/env node
/**
 * 把「要打包进应用的东西」收拢成一个自包含目录 `build/app/`，交给 Electron Forge。
 *
 * ## 为什么需要这一步（而不是让 Forge 直接打包仓库根）
 *
 * 1. **pnpm 的符号链接布局 + Forge 的 prune 会互相伤害**：Forge 复制完项目后会按
 *    `package.json` 的生产依赖做一次 prune，而它遍历依赖的算法假定 npm/yarn 的扁平
 *    `node_modules`。pnpm 的 `node_modules/<包>` 是指向 `.pnpm/<包>@<版本>/…` 的符号链接，
 *    包的依赖靠 `.pnpm` 里的**同级目录**解析 —— 遍历算法看不到这些边，于是会把
 *    「其实还在用」的包删掉，产物启动即崩。所以这里用 **`nodeLinker: hoisted`** 在
 *    staging 目录里重新物化一份**扁平的生产依赖**，prune 就变成了无害的空操作。
 *
 * 2. **只带运行时需要的东西**：渲染进程 bundle、host/CLI/MCP 的源码、主进程三个文件。
 *    仓库里的 opencli 适配器、文档、测试脚本、开发依赖一律不进包。
 *
 * 3. **目录结构照抄 `app/desktop/`**：`main.js` 里所有资源路径都是
 *    `new URL('./xxx', import.meta.url)`，只要相对布局不变，主进程代码一行都不用改。
 *
 * ```
 * build/app/
 *   package.json          ← 由本脚本生成（main: desktop/main.js，保留 dependencies）
 *   forge.config.js       ← 从 app/desktop/ 复制
 *   pnpm-workspace.yaml   ← 复制 + nodeLinker: hoisted
 *   node_modules/         ← pnpm install --prod（扁平、真实文件）
 *   desktop/{main.js,preload.js,ipc.js,host/*.ts,renderer/{index.html,dist/*}}
 *   cli/*.ts              ← host 会 import 它们（kernel/options/commands/…）
 *   mcp/butian/*.ts       ← 内置 MCP 服务器（host 按相对路径拉起）
 * ```
 *
 * 用法：
 * ```bash
 * node app/desktop/scripts/build-app.ts            # 增量（依赖没变就跳过重装）
 * node app/desktop/scripts/build-app.ts --refresh  # 强制重装依赖
 * ```
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
 * 复制一个路径（文件或目录），自动建父目录。
 * @param {string} from - 源（相对仓库根或绝对路径）。
 * @param {string} to - 目标（相对 build/app 或绝对路径）。
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

// ── 0. 渲染进程必须先构建 ────────────────────────────────────────────────────
const bundle = join(desktopDir, 'renderer/dist/renderer.js')
const bridge = join(desktopDir, 'preload.cjs')
if (!existsSync(bundle) || !existsSync(bridge)) {
  throw new Error('客户端还没构建：先跑 `npm run build:renderer`（`npm run app:build` 里已经带了）')
}

// ── 1. 清空上次的产物（保留 node_modules 以支持增量）────────────────────────
//
// 逐个删太容易漏：只要漏掉一个，上一轮的文件就会**一起进 asar**
// （真发生过：改名 forge.config.js → .ts 之后，产物里两个都在）。
// 所以这里按「白名单」清：留下 node_modules 与依赖安装产物，其余全清。
mkdirSync(appDir, { recursive: true })
for (const entry of readdirSync(appDir)) {
  if (entry === 'node_modules' || entry === 'package.json' || entry === 'pnpm-lock.yaml' || entry === 'pnpm-workspace.yaml') continue
  rmSync(join(appDir, entry), { recursive: true, force: true })
}

// ── 2. 生产依赖：在 staging 里用扁平布局重新物化一份 ─────────────────────────
//
// 为什么必须重新装一次而不是复制现有的 node_modules：
// 现有布局是符号链接（见文件头），Forge 的 prune 在那种布局下会删错东西。
// 这里的安装**不碰仓库自己的 node_modules**，两边互不影响。
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
  // 复制 pnpm 的仓库配置，并**加上** nodeLinker: hoisted。
  // 这个文件同时声明了 allowBuilds（node-pty/koffi 的原生安装脚本要跑）与 peer 对齐规则，
  // 缺了它 pnpm 会拒绝执行构建脚本。
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
//
// ⚠️ 三点必须保留，每一条都有具体的失败现象：
//   - `"type": "module"`：主进程与 host 都是 ESM，丢了它 Electron/Node 会按 CJS 解析，
//     启动就报 `Cannot use import statement outside a module`；
//     （`preload.cjs` 不受影响：`.cjs` 天生是 CommonJS）
//   - `dependencies`：Forge 的 prune 按它算「哪些包算生产依赖」，写成空对象 =
//     把刚装好的 node_modules 全删掉；
//   - `config.forge` 与 `devDependencies.electron`（**精确版本**）：
//     Forge 的 `resolveDir()` 从目标目录**逐级向上**找「项目目录」，认三种标记
//     —— ① 内存里注册过的虚拟配置 ② `package.json` 的 `config.forge`
//     ③ `devDependencies` 里有 `@electron-forge/cli`/`core`。
//     staging 目录一开始一个都不占，于是它一路向上找到**仓库根**（那里有
//     `@electron-forge/cli`），把仓库当成了要打包的项目 —— 现象是 prune 去遍历仓库
//     那份 pnpm 符号链接布局的 node_modules，报
//     `Failed to locate module "@standard-schema/spec" from .../Memento/node_modules/...`
//     （真踩过，而且报错信息完全不提「项目目录认错了」）。
//     所以这里显式写上 `config.forge` 指到复制过来的配置文件。
//     `devDependencies.electron` 是另一条要求：`getElectronVersion()` 读它决定打包哪版
//     Electron（写精确版本号就不需要真的装 electron）。
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
// 主进程：main.ts + ipc.ts 由 Electron 自己擦类型直接跑；
// preload 则要**构建产物**（preload.cjs）—— 沙箱 preload 不认 .ts，见 preload.ts 注释。
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
//
// Forge 的 `flora-colossus` 会遍历依赖树：**只在根模块上**走 devDependencies，
// 而且要求每个声明出来的包都**物理存在**（找不到就抛
// `Failed to locate module "electron" from "…/build/app"`）。
//
// 它的向上查找循环是 `testPath = dirname(dirname(testPath))`，从 `build/app` 出发会
// 直接跳到仓库的**上一级**，把仓库根跳过去了 —— 所以就算仓库里装了 electron，
// 它也找不到。既然 Forge 真正要的只是「devDependencies 里那行版本号」
// （`getElectronVersion` 用它决定打包哪版 Electron，二进制由 `@electron/get` 自己准备，
// 跟 node_modules/electron/dist 无关），这里放一个只有 package.json 的占位包最省事：
// 遍历通过，且它在 prune 阶段会被当 devDependency 删掉，不会进产物。
//
// （不用 `pnpm add -D electron` 的原因：那会真的把 250MB 的 dist 拖进 staging，
// 而 --ignore-scripts 又会连原生模块的构建脚本一起跳过。）
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
//
// Forge 加载配置失败时只说 `Failed to load: …` + 一个 `Unexpected token '.'`，
// 不给行号，很难查。而最常见的一种恰恰是**注释写坏了**：块注释里出现
// 「两颗星 + 斜杠 + 星号」这种 glob 字面量会提前结束注释。
// `node --check` 会带行号报出来，成本几乎为零。
{
  const configPath = join(appDir, 'forge.config.ts')
  // ⚠️ `node --check` 对 `.ts` 也有效（Node 24 默认开类型擦除），别改成 tsc ——
  // 这里要的是「能不能被解析」，不是类型对不对（类型由 `npm run typecheck` 管）。
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

// node_modules 必须是**真实目录**（不是符号链接）—— 这正是换布局的全部意义。
if (statSync(join(appDir, 'node_modules')).isSymbolicLink()) {
  throw new Error('node_modules 是符号链接：nodeLinker 没生效，Forge 的 prune 会删错东西')
}

log(`staging 就绪：build/app（node_modules ${sizeOf(join(appDir, 'node_modules'))}，总计 ${sizeOf(appDir)}）`)
log('下一步：npm run package（出 .app）或 npm run make（出 zip/dmg）')
