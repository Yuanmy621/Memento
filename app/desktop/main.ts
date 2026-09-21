/**
 * YuanMy Agent 桌面客户端 —— **Electron 主进程**。
 *
 * 职责边界（保持这条线，界面渲染的事一律不进主进程）：
 *   1. **窗口与生命周期**：创建 BrowserWindow、应用菜单、单实例锁、退出清理；
 *   2. **agent host 子进程**：拉起来（系统 node）、转发消息、崩了要能看出来；
 *   3. **IPC 收口**：渲染进程只能通过 `preload.js` 暴露的 `window.YuanMy` 说话，
 *      每个 handler 都校验发送方是不是本窗口，主进程不信任渲染进程；
 *   4. **原生能力**：目录选择框、关于面板、外部链接。
 *
 * 主进程**不**做 agent 的事：内核跑在 `host/index.ts` 子进程里。原因见
 * `host/protocol.ts`：DSH 的执行能力 provider 是原生模块，ABI 与 Electron 自带
 * Node 不同，且这样窗口重载 / 崩溃不会带走内核状态。
 *
 * 参考文档：https://www.electronjs.org/zh/docs/latest/api/app
 *
 * @module YuanMy/desktop/main
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type BridgeEvent, type LaunchConfig, type PreviewKind, type PreviewPayload, type ShellState } from './ipc.ts'
import { isHostEvent, type HostReadyInfo, type HostRequest } from './host/protocol.ts'
import type { WorkspaceListing } from './host/sessions.ts'

/** host 子进程入口（TS 文件，由系统 node 的类型擦除能力直接运行）。 */
const HOST_ENTRY = fileURLToPath(new URL('./host/index.ts', import.meta.url))
/**
 * 安全桥的**构建产物**（`preload.ts` → esbuild → `preload.cjs`）。
 *
 * 沙箱化 preload 走 Electron 自己的 CJS 加载器，不认识 TypeScript，
 * 所以不能直接指 `.ts`（会静默失败，见 `preload.ts` 的模块注释）。
 */
const PRELOAD_ENTRY = fileURLToPath(new URL('./preload.cjs', import.meta.url))
/** 界面入口。 */
const INDEX_HTML = fileURLToPath(new URL('./renderer/index.html', import.meta.url))
/**
 * 应用图标。
 *
 * - Windows / Linux：`BrowserWindow` 的 `icon` 用它（macOS 忽略这个字段，Dock 图标来自 .app 包）；
 * - macOS 开发态：`app.dock.setIcon()` 用它 —— 否则 Dock 上挂的是 Electron 的默认图标；
 * - 打包态：`forge.config.ts` 的 `packagerConfig.icon` 指向同一份 `assets/icon.icns`。
 */
const APP_ICON = fileURLToPath(new URL('./assets/icon.png', import.meta.url))
/** 内核装配超时：超过这个时间还没 ready 就认为 host 起不来。 */
const HOST_READY_TIMEOUT_MS = 90_000
/** 关闭窗口时，等待 host 优雅退出的时间；超时则 SIGKILL。 */
const HOST_STOP_TIMEOUT_MS = 5_000
/** 进程启动时刻：用于在冒烟/开发模式下报告「从启动到窗口可见」的耗时。 */
const STARTED_AT = Date.now()
/** 唯一的主窗口；macOS 上关闭后可以再创建，所以是可变的。 */
let win: BrowserWindow | null = null
/** 渲染进程最后一次看到的 shell 状态，新窗口打开时用它立即出画面。 */
let state: ShellState = { phase: 'booting' }
/**
 * 最近一帧「项目 / 会话清单」。
 *
 * 渲染进程要解析 10MB 的 bundle，订阅事件往往晚于 host 推送的首帧 —— 只靠推会丢。
 * 所以这里缓存一份，随 `YuanMy:state` 一起返回（「推 + 拉」两条腿，与 ready 同理）。
 */
let workspaceSnapshot: WorkspaceListing | null = null
/**
 * 默认打开哪个项目。
 *
 * 开发时就是「你启动 electron 时所在的目录」（现状不变，跑 `npm run desktop`
 * 打开的就是仓库自己）；**打包后 `process.cwd()` 是 `/`**，拿它当工作目录会让
 * agent 在一个没有意义的根目录上工作，所以那里换成：上次打开过的项目 → 家目录。
 *
 * `YuanMy_CWD` 可以显式指定（冒烟测试与「从终端打开某个项目」都用它）。
 * @returns {string} 项目根目录的绝对路径。
 */
function defaultProjectDir() {
  const fromEnv = process.env.YuanMy_CWD
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  if (app.isPackaged) {
    const recent = readRecentProjects()[0]
    if (recent !== undefined) return recent
    return app.getPath('home')
  }
  return process.cwd()
}

/** 当前 host 启动配置：重启 / 换工作目录时以它为基线。 */
let launchConfig: LaunchConfig = {
  cwd: defaultProjectDir(),
}

// ─────────────────────────────────────────────────────────────────────────────
// 「最近打开过的项目」登记
//
// 为什么需要它：内核的 `stateDir` 默认是 `<cwd>/.YuanMy`，所以**每个项目一份
// 会话库**；host 侧的 lister 只扫它自己那一个根，于是侧栏的「项目 → 会话」树里
// 永远只有当前项目 —— 换到别的项目，上一个就直接消失了。
//
// 这里维护一份「打开过哪些项目」的清单（放在 app 级的 userData 里，因为项目
// 自己的 `.YuanMy` 是每个项目一份、互相看不到），随环境变量交给 host，
// 由它去扫这些项目各自的库。**数据位置一个字节都不动**。
//
// 它只是**线索**：路径可能早被删了、库可能还不存在，host 那边读不到就跳过。
// 所以这里读写失败一律不抛 —— 一个线索文件不该拦住启动。
// ─────────────────────────────────────────────────────────────────────────────

/** 登记表里的一条：项目路径 + 最后打开时间。 */
interface RecentEntry {
  readonly path: string
  readonly lastOpenedAt: number
}

/** 登记文件。`YuanMy_PROJECTS_FILE` 可覆盖（冒烟用它把状态关进临时工作区）。 */
const PROJECTS_FILE = process.env.YuanMy_PROJECTS_FILE ?? join(app.getPath('userData'), 'projects.json')
/** 最多记多少个项目（超出丢最久没打开的）。 */
const MAX_RECENT_PROJECTS = 20

/**
 * 读登记表的原始条目（最近的在前）。
 *
 * 兼容「只有路径字符串」的简写 —— 手写这个文件调试时会那么写。
 * @returns 条目（最近的在前）；文件不存在或损坏时是空数组。
 */
function readRecentEntries(): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
    const raw = (parsed as { projects?: unknown }).projects
    const entries: unknown[] = Array.isArray(raw) ? raw : []
    const out: RecentEntry[] = []
    for (const entry of entries) {
      if (typeof entry === 'string') {
        if (entry !== '') out.push({ path: entry, lastOpenedAt: 0 })
        continue
      }
      if (typeof entry !== 'object' || entry === null) continue
      const { path, lastOpenedAt } = entry as { path?: unknown; lastOpenedAt?: unknown }
      if (typeof path !== 'string' || path === '') continue
      out.push({ path, lastOpenedAt: typeof lastOpenedAt === 'number' ? lastOpenedAt : 0 })
    }
    return out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  } catch {
    return []
  }
}

/**
 * 最近打开过的项目路径（最近的在前）。
 * @returns 路径数组；读不到时是空数组（侧栏因此只列当前项目，功能降级但能用）。
 */
function readRecentProjects(): string[] {
  return readRecentEntries().map((entry) => entry.path)
}

/**
 * 记下一个项目（去重后移到最前），并裁到上限。
 *
 * 写失败只提示：登记丢了顶多是侧栏少列一个项目，不该影响正在跑的内核。
 * @param path - 项目根目录。
 */
function rememberProject(path: string): void {
  try {
    const next = [{ path, lastOpenedAt: Date.now() }, ...readRecentEntries().filter((entry) => entry.path !== path)]
      .slice(0, MAX_RECENT_PROJECTS)
    mkdirSync(dirname(PROJECTS_FILE), { recursive: true })
    writeFileSync(PROJECTS_FILE, `${JSON.stringify({ version: 1, projects: next }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`YuanMy: 记录最近项目失败: ${String(error)}\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// agent host 子进程
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「重启/切换」的序号：只有最后一次切换的结果会被采纳（见 `restartWith`）。
 * 连着点两个会话时，前一次的子进程会被后一次 kill，它的 resolve/reject 都不算数。
 */
let restartGeneration = 0

/**
 * 找到用来跑 host 的运行时（可执行文件 + 它需要的环境变量）。
 *
 * 三种情形，优先级从高到低：
 *
 * | 情形 | 用什么 | 为什么 |
 * | --- | --- | --- |
 * | `YuanMy_NODE_BIN` 显式指定 | 照用 | 逃生口：想指定别的 node 时不改代码 |
 * | **打包后**（`app.isPackaged`） | **App 自带的那颗 Electron 二进制** + `ELECTRON_RUN_AS_NODE=1` | 用户机器上不该假设有 Node；Electron 自带的 Node 24 与开发机一致，实测能跑内核（含 node-pty/koffi 的原生模块） |
 * | 开发时 | npm/pnpm 注入的 node，退回 PATH | 与 CLI 完全同一条路，行为不会两套 |
 *
 * ⚠️ 打包形态依赖 `ELECTRON_RUN_AS_NODE`，所以 `forge.config.js` 里
 * **`FuseV1Options.RunAsNode` 必须保持 true**（Forge 模板默认是关掉的）。
 * 关掉的表现是：窗口能开，但 agent 永远是「不可用」。
 *
 * @returns {{ command: string, env: Record<string, string> }} 可执行文件与附加环境变量。
 */
function resolveHostRuntime() {
  if (process.env.YuanMy_NODE_BIN) return { command: process.env.YuanMy_NODE_BIN, env: {} }
  if (app.isPackaged) {
    return {
      command: process.execPath,
      // 让 Electron 以「纯 Node」身份启动这个子进程（不起 GUI、按 node 语义解析参数）。
      // 这个变量会随 scrubbed parent env 传给 MCP 子进程 —— 它们同样用 process.execPath 拉起
      // （见 app/cli/kernel.ts 的 availableMcpSpecs），所以「Electron 当 Node 用」这一条
      // 必须一路传下去。kernel.ts 里还显式把它列进了 forwardEnv 兜底。
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  return { command: process.env.npm_node_execpath || 'node', env: {} }
}

/**
 * 把启动配置翻译成 host 的命令行参数。
 *
 * host 直接复用 CLI 的 `parseOptions`，所以这里用的就是 CLI 那套开关，
 * 桌面端与终端的行为不会两套。
 * @param {import('./ipc.ts').LaunchConfig} config - 启动配置。
 * @returns {string[]} 传给 node 的完整参数数组。
 */
function buildHostArgs(config: LaunchConfig): string[] {
  const args = [
    // Node 原生类型擦除：直接运行 .ts，无需构建步骤（与 CLI 一致的取舍）。
    // Electron 44 自带的 Node 24 同样支持，所以打包形态下这一条不用改。
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    HOST_ENTRY,
    '--cwd', config.cwd,
  ]
  if (config.model) args.push('--model', config.model)
  if (config.provider) args.push('--provider', config.provider)
  if (config.effort) args.push('--effort', config.effort)
  if (config.sessionId) args.push('--session', config.sessionId)
  if (config.resume) args.push('--resume', config.resume)
  if (config.persist === false) args.push('--no-persist')
  return args
}

/** host 子进程发来的帧：只认我们真正会读的三样东西，其余原样转给渲染进程。 */
type HostFrame =
  | { readonly kind: 'ready'; readonly info: HostReadyInfo; readonly raw: unknown }
  | { readonly kind: 'fatal'; readonly message: string; readonly raw: unknown }
  | { readonly kind: 'other'; readonly raw: unknown }

/**
 * 最小形状校验（子进程的输出按不可信处理）。
 *
 * 单独一个函数、而不是散在回调里：`ready` / `fatal` 要读里面的字段，读之前必须先
 * 证明它是什么形状。判据只有一条 —— `type` 得是字符串。
 * @param raw - 子进程发来的任意值。
 * @returns 归一化后的帧；形状不认识时返回 `null`（调用方直接丢弃）。
 */
function asHostFrame(raw: unknown): HostFrame | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { type, info, message } = raw as { type?: unknown; info?: unknown; message?: unknown }
  if (typeof type !== 'string') return null
  if (type === 'ready' && typeof info === 'object' && info !== null) {
    return { kind: 'ready', info: info as HostReadyInfo, raw }
  }
  if (type === 'fatal') return { kind: 'fatal', message: typeof message === 'string' ? message : '未知错误', raw }
  return { kind: 'other', raw }
}

/**
 * agent host 的生命周期封装：拉起、转发、优雅关闭。
 *
 * 消息通道用 child_process 的 Node IPC（不是 stdout 解析）：
 * 结构化、天然帧边界，且父进程消失时子进程会收到 `disconnect` 自行收敛。
 */
class AgentHost {
  /** host 推来的每个事件。 */
  private readonly onEvent: (event: unknown) => void
  /** 子进程退出（不是我们主动关的时候才回调）。 */
  private readonly onExit: (detail: { readonly code: number | null; readonly error?: Error }) => void
  /** 当前子进程。 */
  private child: ChildProcess | null = null
  /** 就绪信息（`ready` 帧里的那份）。 */
  private info: HostReadyInfo | null = null
  /** 是我们主动关的，还是它自己崩的。 */
  private stopping = false
  /** 等待 `ready` 的结算函数（同时只有一个）。 */
  private resolveReady: ((info: HostReadyInfo) => void) | null = null
  /** 等待 `ready` 的失败结算函数。 */
  private rejectReady: ((error: Error) => void) | null = null
  /** 是否已经为这一代子进程报过一次错（避免 fatal 之后再报一次退出）。 */
  private failureReported = false
  /** ready 超时定时器。 */
  private readyTimer: NodeJS.Timeout | null = null
  /**
   * 子进程的「代际」。
   *
   * 每次 start / stop 都 +1；回调里捕获自己那一代，**不是当前代就什么都不做**。
   * 为什么需要：连着点两个会话时，第一次的内核可能还在启动（或刚被 kill），
   * 它晚到的 `history` / `workspace` 帧会盖到第二次切换的界面上 ——
   * 表现是「点 A 又点 B，结果先看到 A 的会话闪一下，或者停在 A」。
   * 上一版只靠 `this.child !== child` 判断，那只覆盖了 close，覆盖不了 message。
   */
  private generation = 0

  /**
   * @param onEvent - host 推来的每个事件。
   * @param onExit - 子进程退出。
   */
  constructor(
    onEvent: (event: unknown) => void,
    onExit: (detail: { readonly code: number | null; readonly error?: Error }) => void,
  ) {
    this.onEvent = onEvent
    this.onExit = onExit
  }

  /**
   * 启动 host 并等待 `ready`。
   * @param config - 启动配置。
   * @returns 就绪信息。
   */
  async start(config: LaunchConfig): Promise<HostReadyInfo> {
    await this.stop()
    const generation = ++this.generation
    this.stopping = false
    this.failureReported = false
    this.info = null

    // 把「最近打开过的其他项目」交给 host：它只扫当前项目的会话库，
    // 不带上这份清单，侧栏的项目树里就永远只有当前项目（见文件上半部分的说明）。
    const recentProjects = readRecentProjects().filter((path) => path !== config.cwd)
    const runtime = resolveHostRuntime()
    const child = spawn(runtime.command, buildHostArgs(config), {
      cwd: config.cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...runtime.env, YuanMy_PROJECT_ROOTS: recentProjects.join(':') },
    })
    this.child = child

    // host 的 stdout/stderr 进 Electron 的控制台：内核自己的日志、原生模块报错都在这。
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { process.stdout.write(`[host] ${chunk}`) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { process.stderr.write(`[host] ${chunk}`) })

    const ready = new Promise<HostReadyInfo>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
      this.readyTimer = setTimeout(() => {
        reject(new Error(`agent host 在 ${String(HOST_READY_TIMEOUT_MS / 1000)}s 内没有就绪`))
      }, HOST_READY_TIMEOUT_MS)
    })

    child.on('message', (raw: unknown) => {
      // 已经不是当前这一代子进程了（用户又切了一次）：它的帧一律丢弃。
      if (generation !== this.generation) return
      // 子进程输出不可信：只做最小形状校验，非法消息直接丢弃。
      const frame = asHostFrame(raw)
      if (frame === null) return
      if (frame.kind === 'ready') {
        this.info = frame.info
        this.settleReady(null)
      } else if (frame.kind === 'fatal') {
        this.settleReady(new Error(frame.message))
      }
      this.onEvent(frame.raw)
    })

    child.once('error', (error: Error) => {
      if (generation !== this.generation) return
      // spawn 失败（例如 PATH 里没有 node）：把错误交给等待者，并松开引用，
      // 否则下一次 start() 的 stop() 会去等一个永远不存在的 close。
      this.settleReady(error)
      if (this.child === child) this.child = null
    })

    child.once('close', (code: number | null) => {
      // 用「代际」判断这次退出是不是我们主动引起的：重启时旧的 close 回调
      // 可能晚于新子进程的创建，靠代际把它认出来（比 `this.child !== child` 更准：
      // 新子进程还没创建时，child 也已经是 null 了）。
      const expected = this.stopping || generation !== this.generation
      if (this.child === child) {
        this.child = null
        this.info = null
      }
      // 还没就绪就退出 → 把一个可读的错误结算给等待者（firstFailure）。
      const firstFailure = this.settleReady(new Error(`agent host 已退出 (code ${String(code)})`))
      if (expected) return
      // 之前已经报过错（例如刚收到 fatal）就不再重复弹一条。
      if (!firstFailure && this.failureReported) return
      this.onExit({ code })
    })

    return ready
  }

  /**
   * 结束 ready 的等待（成功 / 失败都走这里，保证只结算一次）。
   * @param error - `null` 表示成功。
   * @returns 是否真的结算了（`false` 说明此前已经有结果）。
   */
  settleReady(error: Error | null): boolean {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (error !== null) this.failureReported = true
    const resolve = this.resolveReady
    const reject = this.rejectReady
    this.resolveReady = null
    this.rejectReady = null
    if (resolve === null && reject === null) return false
    if (error !== null) {
      reject?.(error)
      return true
    }
    // 成功路径上 info 一定已经写好了（`ready` 分支先赋值再结算）。
    // 万一没有，也必须给等待者一个结果 —— 否则 ready 的定时器已经被清掉，
    // 调用方会一直挂着。
    if (this.info === null) reject?.(new Error('agent host 报了就绪但没有带 info'))
    else resolve?.(this.info)
    return true
  }

  /** 给 host 发一条请求；没有子进程时静默丢弃（界面会从状态里看到不可用）。 */
  send(request: HostRequest): boolean {
    if (this.child === null || !this.child.connected) return false
    this.child.send(request)
    return true
  }

  /** 请求 host 优雅退出；超时逐级升级为信号，最终放弃等待（不能让窗口关不掉）。 */
  /** 就绪信息（`info` 频道要读它的 nodeVersion）。 */
  get readyInfo(): HostReadyInfo | null {
    return this.info
  }

  async stop(): Promise<void> {
    // 无论有没有子进程，都推进代际：这样「已经停掉的那一代」晚到的帧会被丢掉。
    this.generation += 1
    const child = this.child
    if (child === null) return
    this.stopping = true
    if (child.connected) child.send({ type: 'shutdown' })
    const closed = new Promise((resolve) => { child.once('close', resolve) })
    // 三级收敛：先礼后兵，最后放开等待，避免一个不听话的子进程卡住退出流程。
    const termTimer = setTimeout(() => { child.kill('SIGTERM') }, HOST_STOP_TIMEOUT_MS)
    const killTimer = setTimeout(() => { child.kill('SIGKILL') }, HOST_STOP_TIMEOUT_MS * 2)
    const deadline = new Promise((resolve) => {
      setTimeout(resolve, HOST_STOP_TIMEOUT_MS * 3).unref?.()
    })
    await Promise.race([closed, deadline])
    clearTimeout(termTimer)
    clearTimeout(killTimer)
    this.child = null
    this.info = null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染进程通信
// ─────────────────────────────────────────────────────────────────────────────

/** 向界面推一个事件；窗口不在就丢弃。 */
function sendToRenderer(event: BridgeEvent): void {
  if (win === null || win.isDestroyed()) return
  win.webContents.send(IPC.hostEvent, event)
}

/**
 * 校验 IPC 发送方：只接受我们自己的主窗口主框架。
 * @param {import('electron').IpcMainInvokeEvent} event - IPC 事件。
 */
function assertSender(event: Electron.IpcMainInvokeEvent): void {
  if (win === null || event.sender !== win.webContents) {
    throw new Error('YuanMy: 拒绝来自非本窗口的 IPC 调用')
  }
}

/** host 退出 / 启动失败时统一把状态推给界面。 */
function reportHostFailure(error: Error): void {
  state = { phase: 'error', error: error.message }
  sendToRenderer({ type: 'host-error', message: error.message })
}

/**
 * 用给定配置重启 agent host。
 * @param {import('./ipc.ts').LaunchConfig} config - 启动配置。
 * @returns {Promise<import('./ipc.ts').ShellState>} 新的 shell 状态。
 */
async function restartWith(config: LaunchConfig): Promise<ShellState> {
  // 新内核的清单要重新扫，先作废旧快照。
  workspaceSnapshot = null
  // 会话只属于它的项目：换工作目录时，**上一个**会话的 resume / sessionId 必须丢掉，
  // 否则会拿着旧项目的会话 id 去新项目里找，得到「会话不存在」。
  //
  // ⚠️ 但「恢复另一个项目里的会话」是**合法**的组合：调用方（侧栏）会同时给出
  // 目标 cwd 和该项目的会话 id（`onOpenSession(id, project.path)`）。
  // 早先这里只要 cwd 变了就无条件清掉 resume，于是点别的项目下的会话时
  // 内核会用新 cwd 开一个**全新会话** —— 界面一片空白，
  // 正是「切换工作区中的会话后读不到历史」的根因。
  // 判据因此是「调用方有没有**明确**要求恢复」，而不是「cwd 变没变」：
  //   - pickDirectory / openProject：没给 resume（或显式 undefined）→ 清掉继承来的旧值；
  //   - 侧栏点会话：显式给了 resume → 保留，它就是目标项目里的会话。
  const cwdChanged = config.cwd !== launchConfig.cwd
  const wantsResume = typeof config.resume === 'string' && config.resume !== ''
  const next = cwdChanged && !wantsResume
    ? { ...config, resume: undefined, sessionId: undefined }
    : config
  launchConfig = { ...next }
  config = next
  state = { phase: 'booting' }
  sendToRenderer({ type: 'restarting', cwd: config.cwd })
  /**
   * 这次切换的序号。
   *
   * 连着点两个会话时，第一次的 `host.start()` 会被第二次打断（它的子进程被 kill），
   * 于是它要么 reject、要么更晚 resolve。**两种都不该影响界面**：
   *   - 被取代的那次不算「启动失败」，不能弹错误；
   *   - 也不能把它的 ready 写进 state（那会让界面认错会话）。
   * 所以每次进来先领一个号，await 回来发现号变了就直接收工。
   */
  const generation = ++restartGeneration
  try {
    const info = await host.start(config)
    if (generation !== restartGeneration) return state
    state = { phase: 'ready', info }
    // 起来了才算「打开过」：这样登记表里不会攒下一堆启动失败的路径。
    rememberProject(config.cwd)
  } catch (error) {
    // 被后一次切换取代的那一次：它的失败是「我们自己 kill 的」，不报。
    if (generation !== restartGeneration) return state
    reportHostFailure(error instanceof Error ? error : new Error(String(error)))
  }
  return state
}

// ─────────────────────────────────────────────────────────────────────────────
// 窗口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 窗口材质：侧栏的「磨砂玻璃」由**系统**提供，不用 CSS 的 `backdrop-filter`。
 *
 * - macOS：`vibrancy: 'sidebar'` 是 Apple 给侧栏预留的材质，配合
 *   `visualEffectState: 'active'` 让窗口失焦时材质也保持稳定；
 * - Windows 11：`backgroundMaterial: 'acrylic'`；
 * - Linux：没有等价物，退回不透明底色（渲染进程会按 `nativeMaterial` 走 fallback）。
 *
 * 启用材质时窗口底色必须是**全透明**，否则材质会被盖住；主内容区由
 * `.main-column` 自己刷不透明背景，所以只有侧栏露出材质。
 */
function windowMaterial(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000' }
  }
  if (process.platform === 'win32') {
    return { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
  }
  // 没有材质的平台：刷和主界面一致的基础底色（淡紫黑，见 app.css 的 violet 色阶）。
  return { backgroundColor: '#0e0c14' }
}

/** 材质是否真的启用了（渲染进程据此决定侧栏要不要让出背景）。 */
const NATIVE_MATERIAL = process.platform === 'darwin' || process.platform === 'win32'

/**
 * 隐藏系统标题栏。
 *
 * macOS：`hidden` 保留红绿灯（用 `trafficLightPosition` 摆到自绘顶栏上），
 * 窗口拖动交给渲染进程里的 `.drag-region`。
 * Windows：`hidden` + `titleBarOverlay` 保留最小化/最大化/关闭三个原生按钮。
 * Linux：保留原生标题栏 —— 否则窗口没有关闭按钮，用起来反而更糟。
 */
function titleBarOptions(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 15 } }
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0e0c14', symbolColor: '#ececec', height: 46 },
    }
  }
  return { titleBarStyle: 'default' }
}

/** 创建主窗口。 */
/**
 * macOS 开发态把 Dock 图标换成本项目的 logo。
 *
 * 为什么只在开发态做：打包后的 .app 自带 `icon.icns`，Dock 直接读包里的图标；
 * 而 `electron app/desktop/main.ts` 这种跑法用的是 Electron.app，Dock 上会是 Electron 的图标。
 */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || app.isPackaged) return
  const dock = app.dock
  if (dock === undefined) return
  try {
    dock.setIcon(APP_ICON)
  } catch (error) {
    console.warn(`[main] 设置 Dock 图标失败：${String(error)}`)
  }
}

function createWindow(): void {
  const base: BrowserWindowConstructorOptions = {
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: 'YuanMy Agent',
    // macOS 不认这个字段（Dock 图标由 .app 包决定，见 APP_ICON 的注释）
    ...(process.platform === 'darwin' ? {} : { icon: APP_ICON }),
    show: false,
    webPreferences: {
      preload: PRELOAD_ENTRY,
      // 三条一起构成默认的安全基线：渲染进程拿不到 Node，也拿不到主进程对象。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  }
  // 材质与标题栏逐平台不同，两个都返回 BrowserWindowConstructorOptions，
  // 展开在这里而不是塞进上面的字面量里 —— 联合类型的展开没法被 TS 收窄（会报不可赋值）。
  const options: BrowserWindowConstructorOptions = { ...base, ...windowMaterial(), ...titleBarOptions() }
  win = new BrowserWindow(options)

  // 把渲染进程的 console 转发到主进程输出：界面出问题时（React 抛错、CSP 拦截、
  // Promise 未处理）这里是唯一的线索。开发模式下才开，避免正常使用刷屏。
  if (process.env.YuanMy_DEV === '1') {
    win.webContents.on('console-message', (...args) => {
      // Electron 新旧版本签名不同：新版是 ({level, message, ...})，旧版是 (event, level, message)。
      const first = args[0]
      const detail = (first !== null && typeof first === 'object' && 'message' in first)
        ? `[${String(first.level)}] ${String(first.message)}`
        : `[${String(args[1])}] ${String(args[2])}`
      process.stdout.write(`[renderer] ${detail}\n`)
    })
  }

  win.once('ready-to-show', () => {
    win?.show()
    // 渲染进程的 bundle 有 10MB 左右（主要是 shiki 的语法定义），这里量一下真实代价。
    if (process.env.YuanMy_DEV === '1') {
      process.stdout.write(`[desktop] 窗口可见 · 启动耗时 ${String(Date.now() - STARTED_AT)}ms\n`)
    }
  })
  win.on('closed', () => { win = null })

  // 不允许界面把自己导航走，也不允许开新窗口；外链交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win?.webContents.getURL()) event.preventDefault()
  })

  void win.loadFile(INDEX_HTML)
  if (process.env.YuanMy_DEV === '1') win.webContents.openDevTools({ mode: 'detach' })
}

/** 应用菜单：把「换工作目录 / 新建会话」这类动作放到原生菜单里。 */
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      // 注意 label 不叫「YuanMy」：macOS 的 appMenu 已经占了应用名，
      // 再叫一次会出现两个同名顶级菜单。
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => { void restartWith({ ...launchConfig, sessionId: undefined, resume: undefined }) },
        },
        {
          label: '打开工作目录…',
          accelerator: 'CmdOrCtrl+O',
          click: () => { void openWorkspace() },
        },
        { type: 'separator' },
        {
          label: '关于 YuanMy Agent',
          click: () => { app.showAboutPanel() },
        },
        { type: 'separator' },
        isMac ? { role: 'hide', label: '隐藏 YuanMy' } : { role: 'quit', label: '退出' },
        ...(isMac ? [{ role: 'quit', label: '退出 YuanMy' }] : []),
      ],
    },
    { role: 'editMenu', label: '编辑' },
    { role: 'viewMenu', label: '视图' },
    { role: 'windowMenu', label: '窗口' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template as MenuItemConstructorOptions[]))
}

/** 打开原生目录选择框，选定后用它重启 host。 */
async function openWorkspace() {
  if (win === null) return
  const result = await dialog.showOpenDialog(win, {
    title: '选择 agent 的工作目录',
    defaultPath: launchConfig.cwd,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选它',
  })
  if (result.canceled || result.filePaths.length === 0) return
  await restartWith({ ...launchConfig, cwd: result.filePaths[0], sessionId: undefined, resume: undefined })
  return result.filePaths[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// 右侧预览面板：读文件
//
// 与 `openPath` 同一套路径语义（相对路径按工作目录解析），差别是**把内容读回来**。
// 三条边界：
//   1. 只读，不写（写文件仍然只能走设置界面那条带白名单的路）；
//   2. **有体积上限**：文本 1MB、图片 8MB —— 预览面板是给人看一眼的，不是编辑器，
//      把 40MB 的日志塞进渲染进程只会卡住界面（超限时如实告知并提示用系统程序打开）；
//   3. 类型由**扩展名**判断，认不出来的一律当 binary（只说体积，不给内容）。
// ─────────────────────────────────────────────────────────────────────────────

/** 文本类预览的体积上限（字节）。 */
const PREVIEW_TEXT_MAX = 1_000_000
/** 图片类预览的体积上限（字节，base64 之前）。 */
const PREVIEW_IMAGE_MAX = 8_000_000

/** 扩展名 → 渲染类型。 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico', 'svg'])
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx'])
const TEXT_EXT = new Set(['txt', 'log', 'jsonl', 'ndjson', 'csv', 'tsv', 'diff', 'patch'])
/** 代码类：值是给高亮用的语言名（Streamdown 内部是 Shiki，认这些名字）。 */
const CODE_EXT: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', ps1: 'powershell',
  sql: 'sql', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  xml: 'xml', vue: 'vue', svelte: 'svelte', lua: 'lua', pl: 'perl', dart: 'dart',
  Makefile: 'makefile', makefile: 'makefile', dockerfile: 'dockerfile',
}

/** 图片扩展名 → MIME。 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/**
 * 按扩展名判断该怎么渲染。
 * @param target - 文件绝对路径。
 * @returns 渲染类型与（代码类的）语言名。
 */
function previewTypeOf(target: string): { kind: PreviewKind; language: string } {
  const name = target.slice(target.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot <= 0 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase()
  if (IMAGE_EXT.has(ext)) return { kind: 'image', language: '' }
  if (MARKDOWN_EXT.has(ext)) return { kind: 'markdown', language: '' }
  if (TEXT_EXT.has(ext)) return { kind: 'text', language: '' }
  const language = CODE_EXT[ext] ?? CODE_EXT[name]
  if (language !== undefined) return { kind: 'code', language }
  return { kind: 'binary', language: '' }
}

/**
 * 读一个文件给预览面板。
 * @param raw - 渲染进程传来的路径（可能是相对的）。
 * @returns 预览载荷（读不到时 `ok: false` + `error`）。
 */
async function readForPreview(raw: unknown): Promise<PreviewPayload> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, path: '', kind: 'binary', error: '路径为空' }
  }
  // 与 openPath 同一条规则：相对路径按 agent 的工作目录解析。
  const target = isAbsolute(raw) ? raw : join(launchConfig.cwd, raw)
  const { kind, language } = previewTypeOf(target)
  let size: number
  try {
    size = (await stat(target)).size
  } catch {
    return { ok: false, path: target, kind, error: '文件不存在或读不到' }
  }
  const limit = kind === 'image' ? PREVIEW_IMAGE_MAX : PREVIEW_TEXT_MAX
  if (size > limit) {
    return {
      ok: false,
      path: target,
      kind,
      bytes: size,
      error: `${(size / 1024 / 1024).toFixed(1)} MB，超过预览上限（${String(Math.round(limit / 1024 / 1024))} MB），请用系统程序打开`,
    }
  }
  try {
    const buffer = await readFile(target)
    if (kind === 'image') {
      const mime = IMAGE_MIME[target.slice(target.lastIndexOf('.') + 1).toLowerCase()] ?? 'image/png'
      return { ok: true, path: target, kind, bytes: size, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
    }
    if (kind === 'binary') return { ok: true, path: target, kind, bytes: size }
    return { ok: true, path: target, kind, bytes: size, text: buffer.toString('utf8'), language }
  } catch (error) {
    return { ok: false, path: target, kind, error: error instanceof Error ? error.message : String(error) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC 处理器
// ─────────────────────────────────────────────────────────────────────────────

/** host 实例（下面所有 IPC handler 共用一个）。 */
const host = new AgentHost(
  (event) => {
    // 子进程输出按不可信处理：不认识的帧直接丢，别让它进渲染进程的归约器。
    if (!isHostEvent(event)) return
    const frame = event
    if (frame.type === 'workspace') {
      workspaceSnapshot = { projects: frame.projects, sessions: frame.sessions }
    }
    sendToRenderer(frame)
  },
  ({ code }) => { reportHostFailure(new Error(`agent host 异常退出 (code ${String(code)})，可在菜单里新建会话重试`)) },
)

/** 注册全部 IPC handler。channel 名与 `preload.js` 必须一致。 */
/**
 * 设置界面允许读写的根目录。
 *
 * 只包含「配置与技能/命令」这几处，不含工作目录本身 —— 免得「编辑技能」变成
 * 「任意文件写入」。路径一律先 `resolve()` 再判断前缀，`../` 逃逸因此无效。
 * @returns 绝对路径数组。
 */
function settingsRoots() {
  const cwd = launchConfig.cwd
  const roots = [
    join(cwd, '.agents'),
    join(cwd, '.dsh'),
    join(cwd, '.YuanMy'),
    join(app.getPath('home'), '.YuanMy'),
  ]
  for (const name of ['YuanMy_SKILL_DIRS', 'YuanMy_COMMAND_DIRS']) {
    const extra = process.env[name]
    if (typeof extra !== 'string' || extra.trim() === '') continue
    for (const part of extra.split(':')) {
      const dir = part.trim()
      if (dir !== '') roots.push(dir)
    }
  }
  return roots
}

/**
 * 判断一个路径是否允许被设置界面读写。
 * @param {unknown} path - 渲染进程传来的路径。
 * @returns {{ path: string } | { error: string }} 通过时给出绝对路径。
 */
function allowedSettingsPath(path: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || path.trim() === '') return { ok: false, error: '路径为空' }
  const target = resolve(path)
  for (const root of settingsRoots()) {
    const base = resolve(root)
    if (target === base || target.startsWith(`${base}${sep}`)) return { ok: true, path: target }
  }
  return { ok: false, error: `不允许读写这个路径（只允许配置与技能/命令目录）：${target}` }
}

function registerIpc() {
  ipcMain.handle(IPC.state, (event) => {
    assertSender(event)
    // 把缓存的清单一起给出去：界面可能在首帧推送之后才订阅。
    return workspaceSnapshot === null ? state : { ...state, workspace: workspaceSnapshot }
  })

  ipcMain.handle(IPC.appInfo, (event) => {
    assertSender(event)
    return {
      name: 'YuanMy Agent',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hostNode: host.readyInfo?.nodeVersion,
      /** 窗口是否启用了原生磨砂玻璃（渲染进程据此决定侧栏背景策略）。 */
      nativeMaterial: NATIVE_MATERIAL,
    }
  })

  ipcMain.handle(IPC.prompt, (event, text) => {
    assertSender(event)
    if (typeof text !== 'string' || text.trim() === '') throw new Error('提示内容为空')
    if (state.phase !== 'ready') throw new Error('agent 尚未就绪')
    // 回合 id 由主进程生成，界面据此把流式帧归到同一条消息。
    const turnId = randomUUID()
    if (!host.send({ type: 'prompt', turnId, text })) throw new Error('agent host 不可用')
    return { turnId }
  })

  ipcMain.handle(IPC.cancel, (event) => {
    assertSender(event)
    host.send({ type: 'cancel' })
  })

  ipcMain.handle(IPC.setModel, (event, model) => {
    assertSender(event)
    if (typeof model !== 'string' || model.trim() === '') throw new Error('模型 id 为空')
    if (!host.send({ type: 'set-model', model: model.trim() })) throw new Error('agent host 不可用')
  })

  ipcMain.handle(IPC.pickDirectory, async (event) => {
    assertSender(event)
    if (win === null) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 agent 的工作目录',
      defaultPath: launchConfig.cwd,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选它',
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.restart, async (event, config) => {
    assertSender(event)
    const cwd = typeof config?.cwd === 'string' && config.cwd !== '' ? config.cwd : launchConfig.cwd
    return restartWith({ ...launchConfig, ...config, cwd })
  })

  ipcMain.handle(IPC.newSession, async (event) => {
    assertSender(event)
    return restartWith({ ...launchConfig, sessionId: undefined, resume: undefined })
  })

  ipcMain.handle(IPC.previewRead, async (event, path) => {
    assertSender(event)
    return await readForPreview(path)
  })

  ipcMain.handle(IPC.openPath, async (event, path) => {
    assertSender(event)
    if (typeof path !== 'string' || path === '') throw new Error('路径为空')
    // 相对路径按 agent 的工作目录解析：工具调用里的 file_path 常常是相对的。
    const target = isAbsolute(path) ? path : join(launchConfig.cwd, path)
    // shell.openPath 成功返回空串，失败返回错误描述 —— 原样交回渲染进程显示。
    return shell.openPath(target)
  })

  // ── 设置界面：读 / 写配置文件 ─────────────────────────────────────────────
  //
  // ⚠️ 这是**安全边界**：渲染进程可以要求写文件，所以这里必须自己判断「允许写哪」，
  // 不能相信传进来的路径。允许的范围只包含配置与技能/命令目录 ——
  // 也就是「设置界面合法能改的东西」，别的路径一律拒绝。
  ipcMain.handle(IPC.settingsRead, async (event, path) => {
    assertSender(event)
    const allowed = allowedSettingsPath(path)
    if (!allowed.ok) return { ok: false, error: allowed.error }
    try {
      const content = await readFile(allowed.path, 'utf8')
      return { ok: true, content }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.settingsWrite, async (event, path, content) => {
    assertSender(event)
    const allowed = allowedSettingsPath(path)
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (typeof content !== 'string') return { ok: false, error: '内容必须是字符串' }
    try {
      await writeFile(allowed.path, content, 'utf8')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.settingsList, (event) => {
    assertSender(event)
    // 数据由 host 收集（它才知道内核里真正加载了哪些 skill），以 `settings` 事件回来。
    if (!host.send({ type: 'settings:list' })) throw new Error('agent host 不可用')
  })

  ipcMain.handle(IPC.steer, (event, text) => {
    assertSender(event)
    if (typeof text !== 'string' || text.trim() === '') throw new Error('目标调整内容为空')
    // 走 host 的 steer：内核会在下一个 step 边界消费它（不排队、不打断已发出的请求）。
    if (!host.send({ type: 'steer', text })) throw new Error('agent host 不可用')
  })

  ipcMain.handle(IPC.listFiles, (event, query) => {
    assertSender(event)
    if (!host.send({ type: 'files:list', query: typeof query === 'string' ? query : '' })) {
      throw new Error('agent host 不可用')
    }
  })

  ipcMain.handle(IPC.listSessions, (event) => {
    assertSender(event)
    // 清单由 host 扫描磁盘后以 `workspace` 事件推回来，这里只负责触发。
    if (!host.send({ type: 'list-sessions' })) throw new Error('agent host 不可用')
  })

  ipcMain.handle(IPC.listProjectSessions, (event, path) => {
    assertSender(event)
    if (typeof path !== 'string' || path.trim() === '') throw new Error('项目路径为空')
    // 明细同样由 host 扫描磁盘后以 `project-sessions` 事件推回来。
    if (!host.send({ type: 'list-project-sessions', path })) throw new Error('agent host 不可用')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────────────────────
/** `ready` 之后才允许做的事：窗口、菜单、IPC、内核。 */
async function onReady() {
  registerIpc()
  buildMenu()
  applyDockIcon()
  createWindow()

  // 窗口先出来，内核随后就绪：冷启动时不会有空白等待。
  void restartWith(launchConfig)
}

app.setName('YuanMy Agent')
app.setAboutPanelOptions({
  applicationName: 'YuanMy Agent',
  applicationVersion: app.getVersion(),
  version: `Electron ${process.versions.electron} · Node ${process.versions.node}`,
  copyright: '基于 DeepSeek Harness 内核的 coding agent',
})

// 单实例：第二次启动时把已有窗口顶到前面，避免两个进程抢同一份会话目录。
if (!app.requestSingleInstanceLock()) {
  // 已有实例在跑：这个进程直接退出，由已有实例把窗口顶到前面（见下面的 second-instance）。
  app.quit()
} else {
  // 事件监听都在 `ready` 之前同步注册：它们本身不需要等 ready。
  app.on('second-instance', () => {
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  // macOS：点 Dock 图标且没有窗口时重建一个。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 除 macOS 外，关掉所有窗口就退出应用（macOS 的惯例是留在 Dock 里）。
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出前让内核收敛（子进程会自己 dispose 插件树）；不等它，但也不留孤儿进程。
  app.on('before-quit', () => { void host.stop() })

  // ⚠️ 这里**故意不用顶层 `await app.whenReady()`**：
  //   Electron 的 ESM 主进程入口是异步加载的，在模块顶层 await `ready`
  //   会与 Electron 自己的启动流程互相等待 —— 现象是进程活着、日志停在
  //   「模块已加载」，但永远不出现窗口（实测 Electron 44 必现）。
  //   用 `.then()` 注册回调是可靠写法。
  app.whenReady().then(onReady).catch((error) => {
    process.stderr.write(`YuanMy: 启动失败: ${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(1)
  })
}
