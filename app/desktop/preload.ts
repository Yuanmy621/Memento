/**
 * 安全桥（preload）：渲染进程能看到的全部原生能力，经 `contextBridge` 深拷贝到 `window.Memento`。
 *
 * 本文件是构建产物的源文件：`scripts/build-renderer.ts` 用 esbuild 打成 `app/desktop/preload.cjs`（CommonJS、
 * 自包含、只把 `electron` 留作外部依赖）；沙箱 preload 走 Electron 自己的 CJS 加载器，指到 `.ts` 会静默失败
 * （`window.Memento` 不存在），所以 `format` 固定为 cjs，且不能 `import` 任何本地文件（沙箱下 `require` 只认
 * `electron` 与少数内置模块），频道名只能自带字面量并与 `ipc.ts` 的 `IPC` 表逐字对应，改名要两处都改。
 *
 * @module Memento/desktop/preload
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GitPullResult, GitStatus, GitSwitchResult, PreviewPayload } from './ipc.ts'

/** 与 `ipc.ts` 的 `IPC` 表逐字对应。 */
const CHANNEL = Object.freeze({
  state: 'Memento:state',
  hostEvent: 'Memento:host-event',
  prompt: 'Memento:prompt',
  cancel: 'Memento:cancel',
  setModel: 'Memento:set-model',
  setEffort: 'Memento:set-effort',
  pickDirectory: 'Memento:pick-directory',
  attach: 'Memento:attach',
  listSessions: 'Memento:list-sessions',
  replayHistory: 'Memento:replay-history',
  openPath: 'Memento:open-path',
  listProjectSessions: 'Memento:list-project-sessions',
  appInfo: 'Memento:app-info',
  steer: 'Memento:steer',
  listFiles: 'Memento:list-files',
  settingsList: 'Memento:settings-list',
  settingsRead: 'Memento:settings-read',
  settingsWrite: 'Memento:settings-write',
  previewRead: 'Memento:preview-read',
  gitStatus: 'Memento:git-status',
  gitSwitch: 'Memento:git-switch',
  gitPull: 'Memento:git-pull',
})

/** 读/写配置文件的结果。 */
export interface FileResult {
  readonly ok: boolean
  readonly content?: string
  readonly error?: string
}

/** 「切到某个会话」的请求（与 `ipc.ts` 的 `AttachRequest` 逐字对应）。 */
export interface AttachRequest {
  readonly cwd?: string
  readonly resume?: string
  readonly reuse: boolean
  readonly activeBusy?: boolean
}

/** `attach` 的结果。 */
export interface AttachResult {
  readonly attached: boolean
  readonly key: string
}

/** 渲染进程可见的 API（`window.Memento` 的形状）。 */
const api = {
  /** 取当前 shell / agent 状态：`{ phase, info?, error? }`。 */
  getState: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.state),
  /** Electron / Node / 应用版本信息。 */
  getAppInfo: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.appInfo),
  /** 订阅 agent 事件：`listener` 收到每个事件帧，返回值是取消订阅。 */
  onEvent: (listener: (event: unknown) => void): (() => void) => {
    const handle = (_event: IpcRendererEvent, payload: unknown): void => { listener(payload) }
    ipcRenderer.on(CHANNEL.hostEvent, handle)
    return () => { ipcRenderer.off(CHANNEL.hostEvent, handle) }
  },
  /** 发起一个回合：`text` 是用户输入，返回主进程分配的回合 id。 */
  sendPrompt: (text: string): Promise<{ turnId: string }> => ipcRenderer.invoke(CHANNEL.prompt, text),
  /** 中断当前回合。 */
  cancel: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.cancel),
  /** 让 agent host 重新扫描落盘会话：结果不是返回值，而是随后到达的 `workspace` 事件。 */
  refreshSessions: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.listSessions),
  /** 用系统默认程序打开 `path`（绝对路径）；返回错误信息，成功时空串。 */
  openPath: (path: string): Promise<string> => ipcRenderer.invoke(CHANNEL.openPath, path),
  /** 读某个项目的会话明细（侧栏里点开折叠的项目时用）；结果以 `project-sessions` 事件回来。 */
  listProjectSessions: (path: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.listProjectSessions, path),
  /** 中途调整目标：把 `text` 插给正在跑的回合，内核在下个 step 边界消费。 */
  steer: (text: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.steer, text),
  /** 要一批 `#` 候选文件（`query` 为空串时列最短路径的前若干条）；结果以 `files` 事件异步回来。 */
  listFiles: (query: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.listFiles, query),
  /** 要一次设置数据（skill / 命令 / MCP）；结果以 `settings` 事件异步回来。 */
  settingsList: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.settingsList),
  /** 读一个配置文件（`path` 为绝对路径，主进程有白名单）。 */
  settingsRead: (path: string): Promise<FileResult> => ipcRenderer.invoke(CHANNEL.settingsRead, path),
  /** 写一个配置文件（`path` 为绝对路径，主进程有白名单）。 */
  settingsWrite: (path: string, content: string): Promise<FileResult> =>
    ipcRenderer.invoke(CHANNEL.settingsWrite, path, content),
  /** 切换模型（下一次请求生效）：`model` 是模型 id。 */
  setModel: (model: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.setModel, model),
  /** 切换推理强度（下一次请求生效）：`effort` 取 `off | low | high | max`。 */
  setEffort: (effort: string): Promise<unknown> => ipcRenderer.invoke(CHANNEL.setEffort, effort),
  /** 打开原生目录选择框；取消时返回 null。 */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(CHANNEL.pickDirectory),
  /**
   * 切到某个会话：主进程还留着它的 host 就直接挂回（后台回合不被打断），否则起一个新的。
   * 返回是否直接挂回了活着的 host 与目标会话视图键；`request` 的形状见 `AttachRequest`。
   */
  attach: (request: AttachRequest): Promise<AttachResult> => ipcRenderer.invoke(CHANNEL.attach, request),
  /**
   * 让当前会话重放一次历史（结果以 `history` 事件回来）：界面重载后视图没了但内核还活着，
   * 重放即可把内容补回来，不必重启。
   */
  replayHistory: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.replayHistory),
  /**
   * 读一个文件用于右侧预览面板：路径语义与 `openPath` 相同（相对路径按工作目录解析），
   * 但返回内容 —— 主进程按扩展名判断类型（markdown/code/image/text/binary）并限制体积。
   */
  previewRead: (path: string): Promise<PreviewPayload> => ipcRenderer.invoke(CHANNEL.previewRead, path),
  /**
   * 读当前工作目录的 git 情况（面包屑的分支段）：不接受路径参数，目录由主进程按当前会话的
   * 工作目录决定 —— 否则等于给网页开一个「在任意目录执行 git」的口子。
   */
  gitStatus: (): Promise<GitStatus> => ipcRenderer.invoke(CHANNEL.gitStatus),
  /** 切分支：`branch` 取自上一次 `gitStatus()` 给出的列表（主进程会校验）；返回是否成功、失败原因与切换后的最新状态。 */
  gitSwitch: (branch: string): Promise<GitSwitchResult> => ipcRenderer.invoke(CHANNEL.gitSwitch, branch),
  /**
   * 拉取当前分支的最新提交：不接受参数，分支与目录都由主进程定，跑的是 `git pull --ff-only`
   * （不生成合并提交，要 merge/rebase 去终端）；返回是否成功、git 的结论（「Already up to date.」/ diffstat）与最新状态。
   */
  gitPull: (): Promise<GitPullResult> => ipcRenderer.invoke(CHANNEL.gitPull),
}

contextBridge.exposeInMainWorld('Memento', Object.freeze(api))
