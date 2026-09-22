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
import {
  IPC,
  type AttachRequest,
  type AttachResult,
  type BridgeEvent,
  type LaunchConfig,
  type PreviewKind,
  type PreviewPayload,
  type ShellState,
} from './ipc.ts'
import { isHostEvent, sessionKey, type HostReadyInfo, type HostRequest } from './host/protocol.ts'
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
 * 同时活着的 host 上限。
 *
 * 每个 host 都是一整个内核（10MB 级 bundle + 插件树 + 可能的 MCP 子进程），
 * 所以「后台继续跑」不能等于「永远不回收」。超过这个数就牺牲最老的那个后台会话，
 * 并且**明确告诉用户**（而不是静默杀掉）。
 */
const MAX_LIVE_SLOTS = 6

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

/**
 * host 退出 / 启动失败时统一把状态推给界面。
 * @param error - 失败原因。
 * @param hostId - 出问题的会话视图键（渲染进程据此把错误挂到那个会话上）。
 */
function reportHostFailure(error: Error, hostId?: string): void {
  state = { phase: 'error', error: error.message, ...(hostId === undefined ? {} : { activeKey: hostId }) }
  sendToRenderer({ type: 'host-error', message: error.message, ...(hostId === undefined ? {} : { hostId }) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 会话槽位：一个会话一个 host
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个会话的 host 槽位。
 *
 * 为什么不再是一个全局 host：切换会话如果直接把 host 杀掉，**正在跑的回合就没了**
 * （用户报的就是这件事）。现在按会话（`cwd + sessionId`）持有 host：
 *
 *   - 切到别的会话时，**还有回合在跑的 host 原样留着**，它继续跑完并落盘；
 *   - 空闲的 host 在切换时收掉（省内存），切回来用 `--resume` 回放历史；
 *   - 每个 host 的每一帧都打上 `hostId = slot.key`，渲染进程按它把事件路由到
 *     各自会话的视图 —— 后台会话的正文不会串进前台会话。
 */
interface HostSlot {
  /** 会话视图键（`sessionKey(cwd, sessionId)`）；新建会话就绪后会改名。 */
  key: string
  /** 项目根目录（绝对路径）。 */
  readonly cwd: string
  /** 启动配置（挂回 / 重启时以它为基线）。 */
  readonly config: LaunchConfig
  /** 子进程封装。 */
  readonly host: AgentHost
  /** `ready` 帧带回的真实会话 id；未就绪为 null。 */
  sessionId: string | null
  /** 就绪信息。 */
  info: HostReadyInfo | null
  /** 主进程侧记录的「有回合在跑」：`prompt` 之后到 `turn-end` 之前。 */
  busy: boolean
  /** 已经收掉：它的帧一律不再转发。 */
  dead: boolean
}

/** 活着的 host 槽位（按启动顺序，最早的在前）。 */
const slots: HostSlot[] = []
/** 当前会话的键；还没有任何会话时为 null。 */
let activeKey: string | null = null

/** 当前会话的槽位。 */
function activeSlot(): HostSlot | null {
  return slots.find((slot) => slot.key === activeKey) ?? null
}

/**
 * 当前会话的 host，拿不到就抛。
 *
 * 界面上除了「切会话」以外的每一个动作都发给**当前会话** —— 后台会话继续跑，
 * 但用户能操作（发消息 / 纠偏 / 中断 / 换模型）的只有前台这一个。
 * @returns 当前会话的子进程封装。
 */
function requireActiveHost(): AgentHost {
  const slot = activeSlot()
  if (slot === null) throw new Error('还没有可用的会话')
  return slot.host
}

/** 把当前槽位的状态同步到全局 `state`（`YuanMy:state` / `appInfo` 读它）。 */
function syncState(): void {
  const slot = activeSlot()
  const key = activeKey === null ? undefined : activeKey
  if (slot === null || slot.info === null) {
    state = { phase: 'booting', ...(key === undefined ? {} : { activeKey: key }) }
    return
  }
  state = { phase: 'ready', info: slot.info, ...(key === undefined ? {} : { activeKey: key }) }
}

/**
 * 收掉一个槽位。
 *
 * 立刻从表里摘掉（后续帧一律丢弃，见 `slot.dead`），再让子进程自己优雅退出 ——
 * **不 await**：切换会话不该被一个正在收敛的内核拖住。
 * @param slot - 要收掉的槽位。
 */
function retire(slot: HostSlot): void {
  if (slot.dead) return
  slot.dead = true
  const index = slots.indexOf(slot)
  if (index >= 0) slots.splice(index, 1)
  void slot.host.stop()
}

/**
 * 造一个槽位并接上它的两条回调。
 *
 * `slot` 用「先声明后赋值」是因为 host 的帧回调要引用槽位本身（`ready` 帧要把
 * 占位键改成真实会话 id 的键）—— 而 `new AgentHost()` 只是构造，不会同步产生帧。
 * @param config - 启动配置。
 * @param resume - 要恢复的会话 id；新会话为 undefined。
 * @returns 新槽位（已入表）。
 */
function spawnSlot(config: LaunchConfig, resume: string | undefined): HostSlot {
  const cwd = config.cwd
  let slot!: HostSlot
  const host = new AgentHost(
    (event) => {
      // 子进程输出按不可信处理：不认识的帧直接丢，别让它进渲染进程的归约器。
      if (slot.dead || !isHostEvent(event)) return
      const frame = event
      if (frame.type === 'workspace') {
        workspaceSnapshot = { projects: frame.projects, sessions: frame.sessions }
      }
      // ⚠️ 顺序要紧：**先转发、再改名**。`ready` 必须带着旧键出去，
      // 渲染进程才知道「这个新会话 id 对应的是刚才那个占位视图」，两边各自改名。
      sendToRenderer({ ...frame, hostId: slot.key })
      if (frame.type === 'ready') adoptReady(slot, frame.info)
      if (frame.type === 'turn-end' && slot.busy) {
        slot.busy = false
        // 后台会话跑完了：它已经没有继续留着的理由，收掉。
        // （下次切回去走 `--resume` 历史回放，结果一点不少。）
        if (slot.key !== activeKey) retire(slot)
      }
    },
    ({ code }) => {
      // 不是我们主动收的：host 自己退了。
      if (slot.dead) return
      const message = `agent host 异常退出 (code ${String(code)})，可在菜单里新建会话重试`
      if (slot.key === activeKey) reportHostFailure(new Error(message), slot.key)
      else sendToRenderer({ type: 'notice', level: 'warn', message, hostId: slot.key })
      // ⚠️ 无论哪种都要把槽位摘掉：留着它会让下一次 `attach(reuse: true)` 挂到一个
      // 已经死掉的子进程上（表现是「切回来一片空白、发消息没反应」）。
      retire(slot)
    },
  )
  slot = {
    key: sessionKey(cwd, resume),
    cwd,
    config,
    host,
    sessionId: null,
    info: null,
    busy: false,
    dead: false,
  }
  slots.push(slot)
  return slot
}

/**
 * `ready` 帧到了：记下真实会话 id，并把「新会话」的占位键换成带 id 的键。
 *
 * 两边（主进程与渲染进程）都要做这次改名，否则「切走再切回同一个新会话」时
 * 键对不上，就会为一个会话起两个 host —— 两个内核写同一份会话日志。
 * @param slot - 就绪的槽位。
 * @param info - 就绪信息。
 */
function adoptReady(slot: HostSlot, info: HostReadyInfo): void {
  slot.info = info
  slot.sessionId = info.sessionId
  const next = sessionKey(slot.cwd, info.sessionId)
  if (next !== slot.key) {
    // 理论上不会有两个槽位抢同一个键；真出现就收掉旧的那个，保持「一键一 host」。
    const clash = slots.find((other) => other !== slot && other.key === next)
    if (clash !== undefined) retire(clash)
    if (slot.key === activeKey) activeKey = next
    slot.key = next
  }
  syncState()
}

/**
 * 切到某个会话。
 *
 * 三种走法：
 *   1. **挂回**：渲染进程已有视图 + 这边还留着它的 host（多半是后台还在跑）→
 *      只换前台，不动进程，后台进度一点不丢；
 *   2. **挂不上就重启**：目标会话已空闲被收掉 / 从没打开过 → 起一个新 host，
 *      需要时带 `--resume` 回放历史；
 *   3. **正在跑的别的会话原样留着**，跑完自己收掉（见 {@link spawnSlot}）。
 * @param request - 目标项目 / 会话与复用策略。
 * @returns 是否直接挂回了活着的 host，以及目标会话视图键。
 */
async function attach(request: AttachRequest): Promise<AttachResult> {
  const cwd = typeof request.cwd === 'string' && request.cwd !== '' ? request.cwd : launchConfig.cwd
  const resume = typeof request.resume === 'string' && request.resume !== '' ? request.resume : undefined
  const key = sessionKey(cwd, resume)

  /**
   * 「我刚离开的那个会话有回合在跑」：主进程可能还没收到 `prompt`（同一个 tick 里
   * 先发指令再切走），先按忙处理，别把刚发出去的那一轮当成空闲收掉。
   *
   * ⚠️ 必须排在下面「挂回」之前：挂回那条路也会回收空闲槽位。
   */
  if (request.activeBusy === true) {
    const leaving = activeSlot()
    if (leaving !== null && leaving.key !== key) leaving.busy = true
  }

  // ① 直接挂回还活着的 host（切走再切回一个仍在跑的会话）。
  const live = slots.find((slot) => !slot.dead && slot.key === key)
  if (request.reuse && live !== undefined) {
    // 顺手把**空闲**的槽位收掉（多半是刚才那个前台会话）—— 每个槽位都是一整个内核，
    // 没有理由让一个空闲的继续占着。正在跑的照样留着。
    for (const slot of [...slots]) {
      if (slot === live || slot.busy) continue
      retire(slot)
    }
    activeKey = key
    launchConfig = { ...live.config }
    syncState()
    return { attached: true, key }
  }

  // ② 回收：目标键上的旧槽位无论如何都收掉（要么重启，要么被新 host 取代）；
  //    其他会话**在跑的留着**，空闲的收掉。
  for (const slot of [...slots]) {
    if (slot.key === key) { retire(slot); continue }
    if (slot.busy) continue
    retire(slot)
  }
  // 兜底上限：全都在跑时不静默杀，但要给用户一句话。
  while (slots.length >= MAX_LIVE_SLOTS) {
    const victim = slots.find((slot) => slot.key !== activeKey) ?? slots[0]
    if (victim === undefined) break
    sendToRenderer({
      type: 'notice',
      level: 'warn',
      message: '同时进行的会话太多，这个后台任务已被中断（上限 '
        + `${String(MAX_LIVE_SLOTS)} 个内核）。`,
      hostId: victim.key,
    })
    retire(victim)
  }

  const config: LaunchConfig = { cwd, ...(resume === undefined ? {} : { resume }) }
  launchConfig = { ...config }
  activeKey = key
  // 新内核的清单要重新扫，先作废旧快照。
  workspaceSnapshot = null
  state = { phase: 'booting', activeKey: key }
  sendToRenderer({ type: 'restarting', cwd, hostId: key })

  const slot = spawnSlot(config, resume)
  try {
    const info = await slot.host.start(config)
    // 起来之前又被切走了：这一代的结果不再影响界面（它的 host 已被 `retire`）。
    if (slot.dead) return { attached: false, key }
    slot.info = info
    slot.sessionId = info.sessionId
    syncState()
    // 起来了才算「打开过」：这样登记表里不会攒下一堆启动失败的路径。
    rememberProject(cwd)
  } catch (error) {
    // 被后一次切换取代的那一次不算失败（它的失败是「我们自己 kill 的」）。
    if (slot.dead) return { attached: false, key }
    retire(slot)
    reportHostFailure(error instanceof Error ? error : new Error(String(error)), key)
  }
  return { attached: false, key }
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
          // 菜单是「当前项目里开一个新会话」：不 resume，也不动别的会话。
          click: () => { void attach({ cwd: launchConfig.cwd, reuse: false, activeBusy: activeSlot()?.busy === true }) },
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

/** 打开原生目录选择框，选定后把前台切到那个项目（新会话）。 */
async function openWorkspace() {
  if (win === null) return
  const result = await dialog.showOpenDialog(win, {
    title: '选择 agent 的工作目录',
    defaultPath: launchConfig.cwd,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选它',
  })
  if (result.canceled || result.filePaths.length === 0) return
  await attach({ cwd: result.filePaths[0], reuse: false, activeBusy: activeSlot()?.busy === true })
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

/** 注册全部 IPC handler。channel 名与 `preload.js` 必须一致。 */
function registerIpc() {
  ipcMain.handle(IPC.state, (event) => {
    assertSender(event)
    // 把缓存的清单一起给出去：界面可能在首帧推送之后才订阅。
    // `state.activeKey` 让界面知道这份状态属于哪个会话（见 `syncState`）。
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
      hostNode: activeSlot()?.info?.nodeVersion,
      /** 窗口是否启用了原生磨砂玻璃（渲染进程据此决定侧栏背景策略）。 */
      nativeMaterial: NATIVE_MATERIAL,
    }
  })

  ipcMain.handle(IPC.prompt, (event, text) => {
    assertSender(event)
    if (typeof text !== 'string' || text.trim() === '') throw new Error('提示内容为空')
    const slot = activeSlot()
    if (slot === null || slot.info === null) throw new Error('agent 尚未就绪')
    // 回合 id 由主进程生成，界面据此把流式帧归到同一条消息。
    const turnId = randomUUID()
    if (!slot.host.send({ type: 'prompt', turnId, text })) throw new Error('agent host 不可用')
    // 主进程侧也记一份「在忙」：切走时靠它决定要不要留着这个 host（见 `attach`）。
    slot.busy = true
    return { turnId }
  })

  ipcMain.handle(IPC.cancel, (event) => {
    assertSender(event)
    activeSlot()?.host.send({ type: 'cancel' })
  })

  ipcMain.handle(IPC.setModel, (event, model) => {
    assertSender(event)
    if (typeof model !== 'string' || model.trim() === '') throw new Error('模型 id 为空')
    const host = activeSlot()?.host
    if (host === undefined || !host.send({ type: 'set-model', model: model.trim() })) {
      throw new Error('agent host 不可用')
    }
  })

  ipcMain.handle(IPC.setEffort, (event, effort) => {
    assertSender(event)
    if (typeof effort !== 'string' || effort.trim() === '') throw new Error('推理强度为空')
    const host = activeSlot()?.host
    if (host === undefined || !host.send({ type: 'set-effort', effort: effort.trim() })) {
      throw new Error('agent host 不可用')
    }
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

  /**
   * 切到某个会话。
   *
   * 旧的 `restart` / `new-session` 两个频道合并成了这一个：它们的区别只是
   * 「要不要 resume」，而**要不要真的重启**现在由主进程看着会话忙不忙决定
   * （见 `attach`）—— 界面不需要、也不应该知道这件事。
   */
  ipcMain.handle(IPC.attach, async (event, request) => {
    assertSender(event)
    const raw = (request ?? {}) as Partial<AttachRequest>
    return await attach({
      ...(typeof raw.cwd === 'string' && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
      ...(typeof raw.resume === 'string' && raw.resume !== '' ? { resume: raw.resume } : {}),
      reuse: raw.reuse === true,
      activeBusy: raw.activeBusy === true,
    })
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
    if (!requireActiveHost().send({ type: 'settings:list' })) throw new Error('agent host 不可用')
  })

  ipcMain.handle(IPC.steer, (event, text) => {
    assertSender(event)
    if (typeof text !== 'string' || text.trim() === '') throw new Error('目标调整内容为空')
    // 走 host 的 steer：内核会在下一个 step 边界消费它（不排队、不打断已发出的请求）。
    if (!requireActiveHost().send({ type: 'steer', text })) throw new Error('agent host 不可用')
  })

  ipcMain.handle(IPC.listFiles, (event, query) => {
    assertSender(event)
    if (!requireActiveHost().send({ type: 'files:list', query: typeof query === 'string' ? query : '' })) {
      throw new Error('agent host 不可用')
    }
  })

  ipcMain.handle(IPC.listSessions, (event) => {
    assertSender(event)
    // 清单由 host 扫描磁盘后以 `workspace` 事件推回来，这里只负责触发。
    if (!requireActiveHost().send({ type: 'list-sessions' })) throw new Error('agent host 不可用')
  })

  ipcMain.handle(IPC.replayHistory, (event) => {
    assertSender(event)
    // 当前会话把落盘历史重发一遍（界面重载后补内容，不重启内核）。
    if (!requireActiveHost().send({ type: 'history:replay' })) throw new Error('agent host 不可用')
  })

  ipcMain.handle(IPC.listProjectSessions, (event, path) => {
    assertSender(event)
    if (typeof path !== 'string' || path.trim() === '') throw new Error('项目路径为空')
    // 明细同样由 host 扫描磁盘后以 `project-sessions` 事件推回来。
    if (!requireActiveHost().send({ type: 'list-project-sessions', path })) throw new Error('agent host 不可用')
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
  void attach({ cwd: launchConfig.cwd, reuse: false })
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
  // **所有**槽位都要收：后台会话的 host 也是独立子进程，漏一个就是孤儿。
  app.on('before-quit', () => {
    for (const slot of [...slots]) void slot.host.stop()
  })

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
