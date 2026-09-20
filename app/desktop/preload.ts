/**
 * 安全桥（preload）—— 渲染进程能看到的**全部**原生能力都在这里。
 *
 * ## 它是**构建产物**的源文件，而源文件必须是 TS 之外的样子
 *
 * 本文件（`.ts`）由 `scripts/build-renderer.ts` 用 esbuild 打成
 * **`app/desktop/preload.cjs`**（CommonJS、自包含、只把 `electron` 留作外部依赖），
 * Electron 加载的是那个 `.cjs`。为什么不直接让 Electron 加载 `.ts`：
 *
 *   - 主进程能直接跑 `.ts`（Electron 44 自带的 Node 24 默认开类型擦除，实测可用），
 *     但 **preload 不行**：沙箱化 preload 走的是 Electron 自己的 CJS 加载器，
 *     它不认识 TypeScript —— 直接把 preload 指到 `.ts` 会**静默失败**
 *     （`window.YuanMy` 不存在，界面只会说「preload 脚本没有加载」，看不出真因）。
 *     实测：同一个 preload，指 `.ts` 时 `window.probe === null`，指构建出来的
 *     `.cjs` 时正常。
 *   - 所以这里保持「**源码 .ts、产物 .cjs**」：类型检查照做，Electron 拿到的仍是
 *     CommonJS。官方 DSH 桌面端也是这么分工的（`main.js`(ESM) + `preload-app.cjs`）。
 *
 * ⚠️ 两条不能改：
 *   1. **产物必须是 CommonJS**：Electron 加载 preload 时会忽略 `"type": "module"`，
 *      一律按 CommonJS 执行；沙箱化 preload 也不支持 ESM `import`。
 *      所以本文件里只能 `import`，构建成 `require` —— 别把 `format` 改成 esm。
 *   2. **不能 import 任何本地文件**（包括 `./ipc.ts`）：沙箱下 preload 的 `require`
 *      只认 `electron` 和少数内置模块，**不支持相对路径**。频道名字面量因此只能
 *      重复一份（与 `ipc.ts` 的 `IPC` 表逐字对应，改名字要两处都改）。
 *
 * 为什么只暴露这几个方法：渲染进程是「网页」，不该拿到 ipcRenderer / require / fs。
 * `contextBridge` 把下面这个对象**深拷贝**到 `window.YuanMy`，网页只能看到函数。
 *
 * @module YuanMy/desktop/preload
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PreviewPayload } from './ipc.ts'

/** 与 `ipc.ts` 的 `IPC` 表逐字对应。 */
const CHANNEL = Object.freeze({
  state: 'YuanMy:state',
  hostEvent: 'YuanMy:host-event',
  prompt: 'YuanMy:prompt',
  cancel: 'YuanMy:cancel',
  setModel: 'YuanMy:set-model',
  pickDirectory: 'YuanMy:pick-directory',
  restart: 'YuanMy:restart',
  newSession: 'YuanMy:new-session',
  listSessions: 'YuanMy:list-sessions',
  openPath: 'YuanMy:open-path',
  listProjectSessions: 'YuanMy:list-project-sessions',
  appInfo: 'YuanMy:app-info',
  steer: 'YuanMy:steer',
  listFiles: 'YuanMy:list-files',
  settingsList: 'YuanMy:settings-list',
  settingsRead: 'YuanMy:settings-read',
  settingsWrite: 'YuanMy:settings-write',
  previewRead: 'YuanMy:preview-read',
})

/** 读/写配置文件的结果。 */
export interface FileResult {
  readonly ok: boolean
  readonly content?: string
  readonly error?: string
}

/** 重启内核时允许覆盖的字段。 */
export interface RestartConfig {
  readonly cwd?: string
  readonly model?: string
  readonly provider?: string
  readonly effort?: string
  readonly persist?: boolean
  readonly sessionId?: string
  readonly resume?: string
}

/** 渲染进程可见的 API（`window.YuanMy` 的形状）。 */
const api = {
  /** 取当前 shell / agent 状态：`{ phase, info?, error? }`。 */
  getState: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.state),
  /** Electron / Node / 应用版本信息。 */
  getAppInfo: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.appInfo),
  /**
   * 订阅 agent 事件。
   * @param listener - 收到每一个事件帧。
   * @returns 取消订阅。
   */
  onEvent: (listener: (event: unknown) => void): (() => void) => {
    const handle = (_event: IpcRendererEvent, payload: unknown): void => { listener(payload) }
    ipcRenderer.on(CHANNEL.hostEvent, handle)
    return () => { ipcRenderer.off(CHANNEL.hostEvent, handle) }
  },
  /**
   * 发起一个回合。
   * @param text - 用户输入。
   * @returns 主进程分配的回合 id。
   */
  sendPrompt: (text: string): Promise<{ turnId: string }> => ipcRenderer.invoke(CHANNEL.prompt, text),
  /** 中断当前回合。 */
  cancel: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.cancel),
  /**
   * 让 agent host 重新扫描落盘会话。
   * 结果不是返回值，而是随后到达的 `workspace` 事件。
   */
  refreshSessions: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.listSessions),
  /**
   * 用系统默认程序打开一个文件（文件卡片的「打开」按钮）。
   * @param path - 绝对路径。
   * @returns 错误信息；成功时空串。
   */
  openPath: (path: string): Promise<string> => ipcRenderer.invoke(CHANNEL.openPath, path),
  /**
   * 读某个项目的会话明细（侧栏里点开一个折叠的项目时用）。
   * 结果不是返回值，而是随后到达的 `project-sessions` 事件。
   * @param path - 项目根目录。
   */
  listProjectSessions: (path: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.listProjectSessions, path),
  /**
   * 中途调整目标：插给正在跑的回合（内核在下个 step 边界消费）。
   * @param text - 纠偏内容。
   */
  steer: (text: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.steer, text),
  /**
   * 要一批 `#` 候选文件；结果以 `files` 事件异步回来。
   * @param query - 查询串（空串 = 列最短路径的前若干条）。
   */
  listFiles: (query: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.listFiles, query),
  /** 要一次设置数据（skill / 命令 / MCP）；结果以 `settings` 事件异步回来。 */
  settingsList: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.settingsList),
  /**
   * 读一个配置文件。
   * @param path - 绝对路径（主进程有白名单）。
   */
  settingsRead: (path: string): Promise<FileResult> => ipcRenderer.invoke(CHANNEL.settingsRead, path),
  /**
   * 写一个配置文件。
   * @param path - 绝对路径（主进程有白名单）。
   * @param content - 新内容。
   */
  settingsWrite: (path: string, content: string): Promise<FileResult> =>
    ipcRenderer.invoke(CHANNEL.settingsWrite, path, content),
  /**
   * 切换模型（下一次请求生效）。
   * @param model - 模型 id。
   */
  setModel: (model: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.setModel, model),
  /**
   * 打开原生目录选择框。
   * @returns 选中的目录，取消时为 null。
   */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(CHANNEL.pickDirectory),
  /**
   * 用新配置重启 agent host。
   * @param config - 允许覆盖的字段。
   */
  restart: (config: RestartConfig): Promise<unknown> => ipcRenderer.invoke(CHANNEL.restart, config),
  /**
   * 读一个文件用于右侧预览面板。
   *
   * 与 `openPath` 同一套路径语义（相对路径按工作目录解析），但**返回内容**：
   * 主进程按扩展名判断类型（markdown/code/image/text/binary）并限制体积。
   * @param path - 绝对路径或相对工作目录的路径。
   */
  previewRead: (path: string): Promise<PreviewPayload> => ipcRenderer.invoke(CHANNEL.previewRead, path),
  /** 新建一个空会话（重启 host，不恢复旧会话）。 */
  newSession: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.newSession),
}

contextBridge.exposeInMainWorld('YuanMy', Object.freeze(api))
