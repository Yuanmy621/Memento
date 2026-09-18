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
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from './ipc.js'

/** 冒烟模式的总时限：超过就判定失败并退出，避免挂死。 */
const SMOKE_TIMEOUT_MS = 180_000
/** host 子进程入口（TS 文件，由系统 node 的类型擦除能力直接运行）。 */
const HOST_ENTRY = fileURLToPath(new URL('./host/index.ts', import.meta.url))
/** 安全桥（沙箱化 preload 必须是自包含的 CommonJS）。 */
const PRELOAD_ENTRY = fileURLToPath(new URL('./preload.js', import.meta.url))
/** 界面入口。 */
const INDEX_HTML = fileURLToPath(new URL('./renderer/index.html', import.meta.url))
/** 内核装配超时：超过这个时间还没 ready 就认为 host 起不来。 */
const HOST_READY_TIMEOUT_MS = 90_000
/** 关闭窗口时，等待 host 优雅退出的时间；超时则 SIGKILL。 */
const HOST_STOP_TIMEOUT_MS = 5_000
/** 进程启动时刻：用于在冒烟/开发模式下报告「从启动到窗口可见」的耗时。 */
const STARTED_AT = Date.now()
/** 是否处于无人值守的冒烟模式。 */
const SMOKE_MODE = process.env.YuanMy_SMOKE === '1'

// 冒烟模式用**独立的 userData 目录**。
// 否则它会和你正在用的桌面端抢单实例锁 —— 现象是冒烟进程安静地退出、什么都没测，
// 而 CI 会把这种「什么都没发生」当成通过（这个坑真踩过）。
if (SMOKE_MODE) app.setPath('userData', join(tmpdir(), 'YuanMy-Agent-smoke'))

/** 唯一的主窗口；macOS 上关闭后可以再创建，所以是可变的。 */
let win = null
/** 渲染进程最后一次看到的 shell 状态，新窗口打开时用它立即出画面。 */
let state = { phase: 'booting' }
/**
 * 最近一帧「项目 / 会话清单」。
 *
 * 渲染进程要解析 10MB 的 bundle，订阅事件往往晚于 host 推送的首帧 —— 只靠推会丢。
 * 所以这里缓存一份，随 `YuanMy:state` 一起返回（「推 + 拉」两条腿，与 ready 同理）。
 */
let workspaceSnapshot = null
/** 当前 host 启动配置：重启 / 换工作目录时以它为基线。 */
let launchConfig = {
  // 冒烟模式可以用 `YuanMy_SMOKE_CWD` 指定一个**临时工作区**：
  // 既不会把测试会话写进你真实的 `.YuanMy`（早先的冒烟就是这样污染了侧栏列表），
  // 也让 E2E 能自带「多个项目」的 fixture 去验证项目树。
  cwd: (SMOKE_MODE ? process.env.YuanMy_SMOKE_CWD : undefined) ?? process.cwd(),
}

// ─────────────────────────────────────────────────────────────────────────────
// agent host 子进程
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 找到用来跑 host 的 node 可执行文件。
 *
 * 优先用环境变量显式指定，其次用 npm / pnpm 注入的 node 路径（开发时最准），
 * 最后退回 PATH 里的 `node`。
 * @returns {string} node 可执行文件路径或命令名。
 */
function resolveNodeBinary() {
  return process.env.YuanMy_NODE_BIN || process.env.npm_node_execpath || 'node'
}

/**
 * 把启动配置翻译成 host 的命令行参数。
 *
 * host 直接复用 CLI 的 `parseOptions`，所以这里用的就是 CLI 那套开关，
 * 桌面端与终端的行为不会两套。
 * @param {import('./ipc.js').LaunchConfig} config - 启动配置。
 * @returns {string[]} 传给 node 的完整参数数组。
 */
function buildHostArgs(config) {
  const args = [
    // Node 原生类型擦除：直接运行 .ts，无需构建步骤（与 CLI 一致的取舍）。
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

/**
 * agent host 的生命周期封装：拉起、转发、优雅关闭。
 *
 * 消息通道用 child_process 的 Node IPC（不是 stdout 解析）：
 * 结构化、天然帧边界，且父进程消失时子进程会收到 `disconnect` 自行收敛。
 */
class AgentHost {
  /**
   * @param {(event: unknown) => void} onEvent - host 推来的每个事件。
   * @param {(detail: { code: number | null; error?: Error }) => void} onExit - 子进程退出。
   */
  constructor(onEvent, onExit) {
    this.onEvent = onEvent
    this.onExit = onExit
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {import('./host/protocol.ts').HostReadyInfo | null} */
    this.info = null
    /** 是我们主动关的，还是它自己崩的。 */
    this.stopping = false
    /** @type {((info: unknown) => void) | null} */
    this.resolveReady = null
    /** @type {((error: Error) => void) | null} */
    this.rejectReady = null
    /** 是否已经为这一代子进程报过一次错（避免 fatal 之后再报一次退出）。 */
    this.failureReported = false
    /** @type {NodeJS.Timeout | null} */
    this.readyTimer = null
  }

  /**
   * 启动 host 并等待 `ready`。
   * @param {import('./ipc.js').LaunchConfig} config - 启动配置。
   * @returns {Promise<import('./host/protocol.ts').HostReadyInfo>} 就绪信息。
   */
  async start(config) {
    await this.stop()
    this.stopping = false
    this.failureReported = false
    this.info = null

    const child = spawn(resolveNodeBinary(), buildHostArgs(config), {
      cwd: config.cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: process.env,
    })
    this.child = child

    // host 的 stdout/stderr 进 Electron 的控制台：内核自己的日志、原生模块报错都在这。
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { process.stdout.write(`[host] ${chunk}`) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { process.stderr.write(`[host] ${chunk}`) })

    const ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
      this.readyTimer = setTimeout(() => {
        reject(new Error(`agent host 在 ${String(HOST_READY_TIMEOUT_MS / 1000)}s 内没有就绪`))
      }, HOST_READY_TIMEOUT_MS)
    })

    child.on('message', (message) => {
      // 子进程输出不可信：只做最小形状校验，非法消息直接丢弃。
      if (typeof message !== 'object' || message === null || typeof message.type !== 'string') return
      if (message.type === 'ready') {
        this.info = message.info
        this.settleReady(null)
      } else if (message.type === 'fatal') {
        this.settleReady(new Error(message.message))
      }
      this.onEvent(message)
    })

    child.once('error', (error) => {
      // spawn 失败（例如 PATH 里没有 node）：把错误交给等待者，并松开引用，
      // 否则下一次 start() 的 stop() 会去等一个永远不存在的 close。
      this.settleReady(error)
      if (this.child === child) this.child = null
    })

    child.once('close', (code) => {
      // 用「代际」判断这次退出是不是我们主动引起的：重启时旧的 close 回调
      // 可能晚于新子进程的创建，靠 this.child !== child 把它认出来。
      const expected = this.stopping || this.child !== child
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
   * @param {Error | null} error - `null` 表示成功。
   * @returns {boolean} 是否真的结算了（`false` 说明此前已经有结果）。
   */
  settleReady(error) {
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
    if (error === null) resolve?.(this.info)
    else reject?.(error)
    return true
  }

  /** 给 host 发一条请求；没有子进程时静默丢弃（界面会从状态里看到不可用）。 */
  send(request) {
    if (this.child === null || !this.child.connected) return false
    this.child.send(request)
    return true
  }

  /** 请求 host 优雅退出；超时逐级升级为信号，最终放弃等待（不能让窗口关不掉）。 */
  async stop() {
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
function sendToRenderer(event) {
  if (win === null || win.isDestroyed()) return
  win.webContents.send(IPC.hostEvent, event)
}

/**
 * 校验 IPC 发送方：只接受我们自己的主窗口主框架。
 * @param {import('electron').IpcMainInvokeEvent} event - IPC 事件。
 */
function assertSender(event) {
  if (win === null || event.sender !== win.webContents) {
    throw new Error('YuanMy: 拒绝来自非本窗口的 IPC 调用')
  }
}

/** host 退出 / 启动失败时统一把状态推给界面。 */
function reportHostFailure(error) {
  state = { phase: 'error', error: error.message }
  sendToRenderer({ type: 'host-error', message: error.message })
}

/**
 * 用给定配置重启 agent host。
 * @param {import('./ipc.js').LaunchConfig} config - 启动配置。
 * @returns {Promise<import('./ipc.js').ShellState>} 新的 shell 状态。
 */
async function restartWith(config) {
  // 新内核的清单要重新扫，先作废旧快照。
  workspaceSnapshot = null
  // 会话只属于它的项目：换工作目录时必须丢掉 resume / sessionId，
  // 否则会拿着上一个项目的会话 id 去新项目里找，得到「会话不存在」。
  const next = config.cwd !== launchConfig.cwd
    ? { ...config, resume: undefined, sessionId: undefined }
    : config
  launchConfig = { ...next }
  config = next
  state = { phase: 'booting' }
  sendToRenderer({ type: 'restarting', cwd: config.cwd })
  try {
    const info = await host.start(config)
    state = { phase: 'ready', info }
  } catch (error) {
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
function windowMaterial() {
  if (process.platform === 'darwin') {
    return { vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000' }
  }
  if (process.platform === 'win32') {
    return { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
  }
  return { backgroundColor: '#0d0d0d' }
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
function titleBarOptions() {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 15 } }
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0d0d0d', symbolColor: '#ececec', height: 46 },
    }
  }
  return { titleBarStyle: 'default' }
}

/** 创建主窗口。 */
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: 'YuanMy Agent',
    show: false,
    // 与界面同色，避免启动瞬间的白闪（启用材质时会被上面的透明色覆盖）。
    backgroundColor: '#0d0d0d',
    ...windowMaterial(),
    ...titleBarOptions(),
    webPreferences: {
      preload: PRELOAD_ENTRY,
      // 三条一起构成默认的安全基线：渲染进程拿不到 Node，也拿不到主进程对象。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  // 把渲染进程的 console 转发到主进程输出：界面出问题时（React 抛错、CSP 拦截、
  // Promise 未处理）这里是唯一的线索。冒烟/开发模式下才开，避免正常使用刷屏。
  if (SMOKE_MODE || process.env.YuanMy_DEV === '1') {
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
    if (process.env.YuanMy_SMOKE === '1' || process.env.YuanMy_DEV === '1') {
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
// IPC 处理器
// ─────────────────────────────────────────────────────────────────────────────

/** host 实例（下面所有 IPC handler 共用一个）。 */
const host = new AgentHost(
  (event) => {
    if (event.type === 'workspace') {
      workspaceSnapshot = { projects: event.projects, sessions: event.sessions }
    }
    sendToRenderer(event)
  },
  ({ code }) => { reportHostFailure(new Error(`agent host 异常退出 (code ${String(code)})，可在菜单里新建会话重试`)) },
)

/** 注册全部 IPC handler。channel 名与 `preload.js` 必须一致。 */
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
      hostNode: host.info?.nodeVersion,
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

/**
 * 冒烟模式：布局不能失控。
 *
 * 回归的是一个真 bug：`.app-shell` 只写了 `height: 100%`，行是隐式 auto 会被内容撑高，
 * 于是展开一段长推理后整个 shell 长得比窗口还高 —— 侧栏被拉到同样高度（底部内容顶出
 * 可视区，看起来像「侧栏样式变了」），`.messages` 也失去内部滚动，长内容直接把渲染
 * 进程卡死。断言：展开前后 shell / body / 侧栏高度都必须 ≤ 视口，且内容是**内部滚动**。
 *
 * 这里注入一段带超长不可断 token 的推理，所以不依赖模型这轮是否输出推理、输出多长。
 */
const LAYOUT_PROBE_REASONING = `${
  'The user wants me to inspect the directory structure and summarize it. I should check what files exist first, then read the important ones. '.repeat(28)
}\n${'x'.repeat(4000)}`

/** 冒烟模式：展开推理块，报告布局是否被撑开。 */
const SMOKE_LAYOUT_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const details = document.querySelector('details.reasoning')
  if (details === null) return JSON.stringify({ error: '没有可展开的推理块' })
  if (details.open) details.querySelector('summary').click()
  await sleep(20)
  const sidebar = document.querySelector('.sidebar')
  const messages = document.querySelector('.messages')
  const shell = document.querySelector('.app-shell')
  const height = (node) => Math.round(node.getBoundingClientRect().height)
  const before = { sidebar: height(sidebar), shell: height(shell), body: document.body.scrollHeight }
  const t0 = performance.now()
  details.querySelector('summary').click()
  void document.body.offsetHeight
  const expandMs = Math.round(performance.now() - t0)
  await sleep(30)
  return JSON.stringify({
    viewport: window.innerHeight,
    before,
    after: { sidebar: height(sidebar), shell: height(shell), body: document.body.scrollHeight },
    messages: { client: Math.round(messages.clientHeight), scroll: Math.round(messages.scrollHeight) },
    reasoningChars: details.querySelector('.reasoning__body').textContent.length,
    expandMs,
  })
})()`

/**
 * 冒烟模式：验证项目树。
 *
 * 重点验证**懒加载**：折叠的项目在被点开之前不该有任何会话节点；点开之后
 * 界面要向 host 要数据（renderer → main → host → 磁盘 → 回来），再渲染出来。
 * 这是「会话归纳在项目里」这个结构的核心交互，必须真点一次。
 */
const SMOKE_TREE_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // ⚠️ 每次都要**重新查询**：React 一次重渲染就可能换掉 DOM 节点，
  // 之前抓着的引用会变成游离节点（count 恒为 0，甚至读不出属性）。
  const currentHead = () => document.querySelector('[data-testid="current-project"]')
  const otherHead = () => document.querySelector('[data-testid="project-item"]')
  const leaves = (head) => {
    const branch = head === null ? null : head.closest('li')
    return branch === null ? -1 : branch.querySelectorAll('[data-testid="session-item"]').length
  }

  const report = {
    projectRows: document.querySelectorAll('[data-testid="current-project"], [data-testid="project-item"]').length,
    currentLeaves: leaves(currentHead()),
    currentExpanded: currentHead()?.getAttribute('aria-expanded') ?? '',
    otherFound: otherHead() !== null,
  }
  if (!report.otherFound) return JSON.stringify(report)

  report.otherLeavesBefore = leaves(otherHead())
  report.otherExpandedBefore = otherHead()?.getAttribute('aria-expanded') ?? ''

  // 折叠当前项目：它的会话应当从 DOM 里消失；再展开应当回来。
  currentHead().click()
  await sleep(150)
  report.currentLeavesAfterCollapse = leaves(currentHead())
  currentHead().click()
  await sleep(150)
  report.currentLeavesAfterExpand = leaves(currentHead())

  // 点开另一个项目 → 懒加载（renderer → main → host → 磁盘 → 回来）
  otherHead().click()
  for (let i = 0; i < 40 && leaves(otherHead()) === 0; i += 1) await sleep(100)
  report.otherLeavesAfter = leaves(otherHead())
  report.otherExpandedAfter = otherHead()?.getAttribute('aria-expanded') ?? ''
  return JSON.stringify(report)
})()`

/** 冒烟模式：验证输入法组字期间按回车不会被当成「发送」。 */
const SMOKE_IME_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const input = document.querySelector('[data-testid="input"]')
  const userBubbles = () => document.querySelectorAll('[data-testid="user-message"]').length
  if (input === null) return JSON.stringify({ error: '找不到输入框' })

  const before = userBubbles()
  // React 用自己的 value 追踪，直接赋 .value 它收不到；要用原生 setter 再派发 input。
  const setValue = (value) => {
    const proto = Object.getPrototypeOf(input)
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const keyDown = (init) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))

  // keyCode 能不能通过 init 传进合成事件，直接决定下面哪条路径被覆盖。
  const keyCodeSettable = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229 }).keyCode === 229

  setValue('ni hao')
  await sleep(20)

  // ① 组字中按回车（中文输入法确认候选词）——不该发送。
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  keyDown({ isComposing: true, keyCode: 229 })
  await sleep(20)
  const afterComposing = userBubbles()

  // ② compositionend 之后紧跟的那次回车（macOS Chromium 边界情况）——也不该发送。
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
  keyDown({ isComposing: false, keyCode: keyCodeSettable ? 229 : 13 })
  await sleep(20)
  const afterJustEnded = userBubbles()

  // ③ 临时标记过期之后，回车必须恢复可用（否则守卫卡死，回车永远发不出去）。
  await sleep(30)
  keyDown({ isComposing: false, keyCode: 13 })
  await sleep(30)
  const afterPlain = userBubbles()

  // 立刻中断这一次真实发送，避免污染后面的回合断言。
  document.querySelector('[data-testid="cancel"]')?.click()

  return JSON.stringify({
    keyCodeSettable,
    sentWhileComposing: afterComposing - before,
    sentRightAfterCompositionEnd: afterJustEnded - afterComposing,
    sentOnPlainEnter: afterPlain - afterJustEnded,
  })
})()`

/** 冒烟模式用来问渲染进程的那段脚本：等界面自己把状态刷成「就绪」再回话。 */
const SMOKE_PROBE = `new Promise((resolve) => {
  const text = (sel) => { const n = document.querySelector(sel); return n === null ? 'MISSING' : n.textContent.trim() }
  const deadline = Date.now() + 12000
  const diag = async () => {
    try {
      const s = await window.YuanMy.getState()
      // 模型 id 与工具数原先印在侧栏的「运行状态」块里（该块已删除），改从内核信息快照取。
      return { apiRefresh: typeof window.YuanMy.refreshSessions, phase: s.phase, hasWorkspace: s.workspace !== undefined,
        projects: s.workspace === undefined ? -1 : s.workspace.projects.length,
        sessions: s.workspace === undefined ? -1 : s.workspace.sessions.length,
        model: s.info === undefined ? '' : s.info.model,
        tools: s.info === undefined ? '' : String(s.info.tools.length) }
    } catch (e) { return { error: String(e) } }
  }
  const tick = async () => {
    const status = text('[data-testid="status-text"]')
    // 会话清单是 host 扫盘后**异步**推来的，所以要等「就绪 + 列表已填充」，
    // 不能一看到就绪就采样（早先就是这里误报过）。
    const listReady = document.querySelectorAll('[data-testid="session-item"]').length > 0
    if ((status === '就绪' && listReady) || Date.now() > deadline) {
      const diagnostics = await diag()
      resolve(JSON.stringify({
        status,
        bridge: typeof window.YuanMy,
        react: document.getElementById('root').children.length,
        model: diagnostics.model === undefined || diagnostics.model === '' ? 'MISSING' : diagnostics.model,
        tools: diagnostics.tools === undefined || diagnostics.tools === '' ? 'MISSING' : diagnostics.tools,
        cwd: document.querySelector('[data-testid="current-project"]')?.dataset.projectPath || '',
        project: text('[data-testid="project-name"]'),
        projectItems: document.querySelectorAll('[data-testid="project-item"]').length,
        sessionItems: document.querySelectorAll('[data-testid="session-item"]').length,
        currentSessionMarked: document.querySelectorAll('[data-testid="session-item"][data-current="true"]').length,
        tokenBar: text('[data-testid="token-bar"]'),
        platform: document.documentElement.dataset.platform || '',
        vibrancy: document.documentElement.dataset.vibrancy || '',
        dragRegions: document.querySelectorAll('.drag-region').length,
        diag: diagnostics,
        messages: document.querySelectorAll('[data-testid="user-message"],[data-testid="assistant-message"]').length,
      }))
      return
    }
    setTimeout(tick, 60)
  }
  tick()
})`

/**
 * 冒烟模式用来等一个真实回合跑完的脚本。
 *
 * 只看**最后一条**助手消息（前面的回合或输入法探针可能留下更早的消息），
 * 统计也只在它内部数，避免把历史消息算进来。
 */
const SMOKE_WAIT_TURN = `new Promise((resolve) => {
  // 注意：这段脚本与 SMOKE_PROBE 是两个独立的作用域，助手函数必须自带一份
  // （曾经借用过 SMOKE_PROBE 的 text()，结果 ReferenceError 让 Promise 永不 settle，
  //  整个冒烟就死等 —— 这种坑必须靠「探针自己出错」而不是「界面出错」来区分）。
  const text = (sel) => { const n = document.querySelector(sel); return n === null ? 'MISSING' : n.textContent.trim() }
  const deadline = Date.now() + 90000
  const tick = () => {
    const assistants = document.querySelectorAll('[data-testid="assistant-message"]')
    const assistant = assistants.length === 0 ? null : assistants[assistants.length - 1]
    const meta = assistant === null ? null : assistant.querySelector('[data-testid="message-meta"]')
    const metaText = meta === null ? '' : meta.textContent.trim()
    const done = metaText !== '' && metaText !== '正在生成…'
    if (done || Date.now() > deadline) {
      const scope = assistant ?? document
      resolve(JSON.stringify({
        meta: metaText,
        tools: scope.querySelectorAll('[data-testid="tool-card"]').length,
        markdownBlocks: scope.querySelectorAll('[data-testid="markdown"]').length,
        bold: scope.querySelectorAll('[data-streamdown="strong"]').length,
        codeBlocks: scope.querySelectorAll('[data-testid="markdown"] pre code').length,
        headings: scope.querySelectorAll('[data-testid="markdown"] h1, [data-testid="markdown"] h2, [data-testid="markdown"] h3').length,
        lists: scope.querySelectorAll('[data-testid="markdown"] ul, [data-testid="markdown"] ol').length,
        tokenInput: Number((document.querySelector('[data-testid="token-input"] b')?.textContent ?? '0').replace(/[^0-9.]/g, '')) || 0,
        tokenOutput: Number((document.querySelector('[data-testid="token-output"] b')?.textContent ?? '0').replace(/[^0-9.]/g, '')) || 0,
        tokenCache: text('[data-testid="token-cache"]'),
        tokenRate: text('[data-testid="token-rate"]'),
        text: (assistant === null ? '' : assistant.textContent).slice(0, 300),
        // 超时诊断：看清帧到底有没有到 DOM。
        diagAssistants: document.querySelectorAll('[data-testid="assistant-message"]').length,
        diagUsers: document.querySelectorAll('[data-testid="user-message"]').length,
        diagMetas: document.querySelectorAll('[data-testid="message-meta"]').length,
        diagNotes: document.querySelectorAll('[data-testid="note"]').length,
        diagLastMeta: metaText,
      }))
      return
    }
    setTimeout(tick, 200)
  }
  tick()
})`

/**
 * 冒烟模式（`npm run desktop:smoke`）：无人值守启动，跑完断言就退出。
 *
 * 它不只是「内核起来了」——还会**直接问渲染进程**，因此能一次性验证
 * 「窗口 + preload 的桥 + renderer.js 初始化 + IPC 往返 + 内核就绪」整条链路。
 *
 * 设了 `YuanMy_SMOKE_PROMPT` 就再往前一步：从渲染进程里调用 `window.YuanMy.sendPrompt()`，
 * 也就是用户点「发送」走的那条路，然后读 DOM 确认助手消息与工具卡片真的渲染出来了。
 * 退出码 0 表示全绿。
 */
async function runSmoke() {
  // 总看门狗：任何一步卡住都要**失败退出**，而不是把 CI 挂到超时
  // （曾经因为一个探针 ReferenceError 死等 5 分钟）。
  const watchdog = setTimeout(() => {
    process.stderr.write(`[smoke] 超时：${String(SMOKE_TIMEOUT_MS / 1000)}s 内没有跑完，强制失败\n`)
    app.exit(1)
  }, SMOKE_TIMEOUT_MS)
  watchdog.unref?.()

  const outcome = await restartWith(launchConfig)
  /**
   * 逐行立即输出，而不是攒到最后一次性打印。
   * 冒烟一旦卡住，攒着输出就等于什么都看不到（调这个脚本时吃过亏）。
   */
  const say = (line) => { process.stdout.write(`${line}\n`) }
  say(outcome.phase === 'ready'
    ? `[smoke] host ready · ${outcome.info.sessionId} · ${String(outcome.info.tools.length)} 个工具`
    : `[smoke] host failed: ${outcome.error}`)

  let passed = outcome.phase === 'ready'
  try {
    if (win !== null && !win.isDestroyed()) {
      const probe = JSON.parse(await win.webContents.executeJavaScript(SMOKE_PROBE, true))
      say(`[smoke] renderer · status=${probe.status} · bridge=${probe.bridge} · React 已挂载=${String(probe.react > 0)}`)
      say(`[smoke] 侧栏 · 模型=${probe.model} · 工具=${probe.tools}`)
      say(`[smoke] 外观 · platform=${probe.platform} · 磨砂玻璃=${probe.vibrancy} · 拖拽区 ${String(probe.dragRegions)} 处`)
      say(`[smoke] cwd=${probe.cwd} · 已渲染消息 ${String(probe.messages)} 条`)
      say(`[smoke] 侧栏 · 项目=${probe.project} · 会话条目 ${String(probe.sessionItems)} 个（当前高亮 ${String(probe.currentSessionMarked)} 个）`)
      say(`[smoke] token 栏 · ${probe.tokenBar}`)
      say(`[smoke] 诊断 · ${JSON.stringify(probe.diag)}`)
      passed = passed && probe.status === '就绪' && probe.bridge === 'object' && probe.react > 0
      // 顶部栏隐藏后必须仍有拖拽区，否则窗口拖不动。
      passed = passed && probe.dragRegions > 0
      // 项目名要显示出来；本项目已有落盘会话，所以列表里至少要有一条、且有且只有一条标记为当前。
      passed = passed && probe.project !== 'MISSING' && probe.project !== '（未就绪）'
      passed = passed && probe.sessionItems > 0 && probe.currentSessionMarked === 1
      // token 栏必须存在（此刻还没有调用，命中率显示 —）。
      passed = passed && probe.tokenBar.includes('命中率')
    } else {
      say('[smoke] renderer · 窗口不存在')
      passed = false
    }
  } catch (error) {
    say(`[smoke] renderer probe failed: ${error instanceof Error ? error.message : String(error)}`)
    passed = false
  }

  // 端到端跑一个真实回合：入口就是渲染进程里的 window.YuanMy.sendPrompt。
  const prompt = process.env.YuanMy_SMOKE_PROMPT
  if (passed && typeof prompt === 'string' && prompt !== '') {
    try {
      await win.webContents.executeJavaScript(`window.YuanMy.sendPrompt(${JSON.stringify(prompt)})`, true)
      const turn = JSON.parse(await win.webContents.executeJavaScript(SMOKE_WAIT_TURN, true))
      say(`[smoke] turn · ${turn.meta} · 工具卡片 ${String(turn.tools)} 张`)
      if (!turn.meta.includes('完成')) {
        say(`[smoke] 超时诊断 · 助手消息 ${String(turn.diagAssistants)} · 用户消息 ${String(turn.diagUsers)} · meta 节点 ${String(turn.diagMetas)} · 提示 ${String(turn.diagNotes)} · 最后 meta="${turn.diagLastMeta}"`)
      }
      say(`[smoke] markdown · 块 ${String(turn.markdownBlocks)} · 代码块 ${String(turn.codeBlocks)} · 粗体 ${String(turn.bold)} · 标题 ${String(turn.headings)} · 列表 ${String(turn.lists)}`)
      say(`[smoke] 界面正文片段：${turn.text.replace(/\s+/g, ' ').slice(0, 140)}`)
      // Markdown 必须真的被解析（而不是把源码当纯文本贴出来）。
      passed = passed && turn.meta.includes('完成') && turn.markdownBlocks > 0
      // 跑过一轮之后，token 栏必须有真实数字（输入/输出/缓存/命中率），不能再是 0 / —。
      passed = passed && turn.tokenInput > 0 && turn.tokenOutput > 0 && turn.tokenRate.includes('%')
      say(`[smoke] token · 输入 ${String(turn.tokenInput)} · 输出 ${String(turn.tokenOutput)} · ${turn.tokenCache} · ${turn.tokenRate}`)
    } catch (error) {
      say(`[smoke] turn failed: ${error instanceof Error ? error.message : String(error)}`)
      passed = false
    }
  }

  // 输入法守卫：在真实窗口里验证组字期间的回车不会被当成发送。
  // 放在最后跑 —— 它的第 ③ 步会真的发一次（用来证明守卫没把回车卡死），
  // 紧接着就被 cancel 掉，所以不能影响前面的回合断言。
  if (passed) {
    try {
      const ime = JSON.parse(await win.webContents.executeJavaScript(SMOKE_IME_PROBE, true))
      say(`[smoke] 输入法 · composition 可注入=${String(ime.keyCodeSettable)} · 组字中发送=${String(ime.sentWhileComposing)} 次 · compositionend 后发送=${String(ime.sentRightAfterCompositionEnd)} 次 · 普通回车发送=${String(ime.sentOnPlainEnter)} 次`)
      // 组字中 / 刚结束组字都不许发送；普通回车必须能发送（否则守卫把回车卡死了）。
      passed = ime.sentWhileComposing === 0 && ime.sentRightAfterCompositionEnd === 0 && ime.sentOnPlainEnter === 1
    } catch (error) {
      say(`[smoke] 输入法探针失败: ${error instanceof Error ? error.message : String(error)}`)
      passed = false
    }
  }

  // 项目树：折叠/展开当前项目 + 懒加载另一个项目。
  if (passed) {
    try {
      const tree = JSON.parse(await win.webContents.executeJavaScript(SMOKE_TREE_PROBE, true))
      say(`[smoke] 项目树 · ${String(tree.projectRows)} 个项目 · 当前折叠前 ${String(tree.currentLeaves)} 条 → 折叠后 ${String(tree.currentLeavesAfterCollapse)} 条 → 再展开 ${String(tree.currentLeavesAfterExpand)} 条`)
      if (tree.otherFound) {
        say(`[smoke] 项目树 · 另一个项目：展开前 ${String(tree.otherLeavesBefore)} 条 → 点开并懒加载后 ${String(tree.otherLeavesAfter)} 条`)
      } else {
        say('[smoke] 项目树 · 只有一个项目（未验证懒加载）')
      }
      passed = passed && tree.projectRows >= 2
      // 折叠后当前项目的会话必须从 DOM 消失，展开后回来
      passed = passed && tree.currentLeaves > 0
        && tree.currentLeavesAfterCollapse === 0 && tree.currentLeavesAfterExpand > 0
      // 懒加载：点开前没有节点，点开后必须加载出来
      passed = passed && tree.otherFound
        && tree.otherLeavesBefore === 0 && tree.otherLeavesAfter > 0
        && tree.otherExpandedAfter === 'true'
    } catch (error) {
      say(`[smoke] 项目树探针失败: ${error instanceof Error ? error.message : String(error)}`)
      passed = false
    }
  }

  // 布局探针放最后：它会往界面里塞一条合成消息，不能影响前面的断言。
  if (passed) {
    try {
      win.webContents.send(IPC.hostEvent, { type: 'reasoning-delta', turnId: 'layout-probe', text: LAYOUT_PROBE_REASONING })
      await new Promise((resolve) => { setTimeout(resolve, 400) })
      const layout = JSON.parse(await win.webContents.executeJavaScript(SMOKE_LAYOUT_PROBE, true))
      if (layout.error !== undefined) {
        say(`[smoke] 布局 · 跳过（${layout.error}）`)
      } else {
        say(`[smoke] 布局 · 视口 ${String(layout.viewport)} · 侧栏 ${String(layout.before.sidebar)}→${String(layout.after.sidebar)} · shell ${String(layout.after.shell)} · body ${String(layout.after.body)}`)
        say(`[smoke] 布局 · 消息区 client ${String(layout.messages.client)} / scroll ${String(layout.messages.scroll)} · 推理 ${String(layout.reasoningChars)} 字符 · 展开 ${String(layout.expandMs)}ms`)
        const contained = layout.after.sidebar <= layout.viewport
          && layout.after.shell <= layout.viewport
          && layout.after.body <= layout.viewport
        // 内容必须撑高了**内部**滚动区，而不是把整个外壳撑开。
        const scrolls = layout.messages.scroll > layout.messages.client
        passed = passed && contained && scrolls && layout.expandMs < 250
        if (!contained) say('[smoke] ✗ 布局被撑开：外壳高度超过了视口（侧栏会跟着变形）')
        if (!scrolls) say('[smoke] ✗ 消息区没有内部滚动，内容把外壳撑大了')
      }
    } catch (error) {
      say(`[smoke] 布局探针失败: ${error instanceof Error ? error.message : String(error)}`)
      passed = false
    }
  }

  if (!passed) process.stderr.write('[smoke] 未通过：窗口 / 渲染进程 / 内核至少有一环没就绪\n')
  await host.stop()
  app.exit(passed ? 0 : 1)
}
/** `ready` 之后才允许做的事：窗口、菜单、IPC、内核。 */
async function onReady() {
  registerIpc()
  buildMenu()
  createWindow()

  if (SMOKE_MODE) {
    await runSmoke()
    return
  }
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
  if (SMOKE_MODE) {
    // 冒烟模式绝不能静默成功退出：明确报错并给非零退出码。
    process.stderr.write('[smoke] 无法取得单实例锁（已有实例在运行），本次冒烟未执行\n')
    app.exit(1)
  } else {
    app.quit()
  }
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
