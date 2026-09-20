/**
 * Electron 主进程 ⇄ 渲染进程之间的 IPC 频道名与状态形状。
 *
 * 这个文件只被 **主进程**（`main.ts`）引用。渲染进程拿不到它 ——
 * 渲染进程与主进程之间的唯一通道是 `preload.cjs`（由 `preload.ts` 构建而来）
 * 通过 `contextBridge` 暴露的 `window.YuanMy`，那是刻意设计的单向收口：
 *
 *   渲染进程（网页）── window.YuanMy ──▶ preload ──IPC──▶ 主进程 ──▶ agent host
 *
 * ⚠️ 频道名同时出现在三处：本文件、`preload.ts`（构建成**沙箱 preload**，
 * 不能 require 本地文件，只能自带字面量）、以及渲染进程调用的方法名。
 * 改名字要一起改；漏改的表现是渲染进程 invoke 报 "No handler registered"。
 *
 * @module YuanMy/desktop/ipc
 */

import type { HostEvent, HostReadyInfo } from './host/protocol.ts'

/** 全部 IPC 频道名（`invoke/handle` 用请求-响应，`send` 用单向事件）。 */
export const IPC = Object.freeze({
  /** 渲染进程 → 主进程：取当前 shell / agent 状态。 */
  state: 'YuanMy:state',
  /** 主进程 → 渲染进程：agent host 推来的事件（单向）。 */
  hostEvent: 'YuanMy:host-event',
  /** 渲染进程 → 主进程：发起一个回合。 */
  prompt: 'YuanMy:prompt',
  /** 渲染进程 → 主进程：中断当前回合。 */
  cancel: 'YuanMy:cancel',
  /** 渲染进程 → 主进程：运行中切换模型。 */
  setModel: 'YuanMy:set-model',
  /** 渲染进程 → 主进程：打开原生目录选择框。 */
  pickDirectory: 'YuanMy:pick-directory',
  /** 渲染进程 → 主进程：用新的配置重启 agent host。 */
  restart: 'YuanMy:restart',
  /** 渲染进程 → 主进程：新建一个空会话（重启 host，不恢复旧会话）。 */
  newSession: 'YuanMy:new-session',
  /** 渲染进程 → 主进程：让 host 重新扫描落盘会话。 */
  listSessions: 'YuanMy:list-sessions',
  /** 渲染进程 → 主进程：用系统默认程序打开一个文件。 */
  openPath: 'YuanMy:open-path',
  /** 渲染进程 → 主进程：读某个项目的会话明细（侧栏里点开折叠的项目）。 */
  listProjectSessions: 'YuanMy:list-project-sessions',
  /** 渲染进程 → 主进程：中途调整目标（插给正在跑的回合，不排队）。 */
  steer: 'YuanMy:steer',
  /** 渲染进程 → 主进程：要一批 `#` 候选文件（结果以 `files` 事件回来）。 */
  listFiles: 'YuanMy:list-files',
  /** 渲染进程 → 主进程：要一次设置数据（skill / 命令 / MCP，结果以 `settings` 事件回来）。 */
  settingsList: 'YuanMy:settings-list',
  /** 渲染进程 → 主进程：读一个配置文件（设置界面的编辑器用；只允许白名单目录）。 */
  settingsRead: 'YuanMy:settings-read',
  /** 渲染进程 → 主进程：写一个配置文件（同上）。 */
  settingsWrite: 'YuanMy:settings-write',
  /** 渲染进程 → 主进程：Electron / Node / 应用版本信息。 */
  appInfo: 'YuanMy:app-info',
  /** 渲染进程 → 主进程：读一个文件用于**右侧预览面板**（有类型判断与体积上限）。 */
  previewRead: 'YuanMy:preview-read',
})

/**
 * 主进程**自己**产生（不是从 host 转发）的事件，与 `HostEvent` 走同一条通道。
 *
 * 单独一个类型而不是塞进 `HostEvent`：`HostEvent` 描述的是 host 子进程的协议，
 * 这两个事件主进程自己就能发（重启时、host 崩了时），不需要 host 参与。
 *
 * ⚠️ 渲染进程那边有一份**更大的**同名词条类型（`renderer/src/use-agent.ts` 的
 * `ShellEvent`）：它还要收下自己内部的动作（`switch-timeout`）。两边故意不同 ——
 * 这里是「主进程会发什么」的契约，那里是「界面要处理什么」的清单。
 */
export type ShellEvent =
  /** 即将用新配置重启内核：界面保留当前内容并显示「正在切换」。 */
  | { readonly type: 'restarting'; readonly cwd: string }
  /** host 启动失败或异常退出：界面进入不可用状态。 */
  | { readonly type: 'host-error'; readonly message: string }

/** 走 `hostEvent` 通道的全部事件（host 的 + 主进程自己的）。 */
export type BridgeEvent = HostEvent | ShellEvent

/** shell 当前阶段（主进程维护的那一份，随 `state` 频道给渲染进程）。 */
export interface ShellState {
  readonly phase: 'booting' | 'ready' | 'error'
  /** 就绪后的内核信息。 */
  readonly info?: HostReadyInfo
  /** 失败原因。 */
  readonly error?: string
}

/** 启动（或重启）内核的配置。 */
export interface LaunchConfig {
  /** agent 的工作目录。 */
  readonly cwd: string
  /** 模型 id。 */
  readonly model?: string
  /** provider id。 */
  readonly provider?: string
  /** 推理强度。 */
  readonly effort?: string
  /** 是否把会话写入磁盘。 */
  readonly persist?: boolean
  /** 指定新会话 id。 */
  readonly sessionId?: string
  /** 恢复已落盘的会话 id。 */
  readonly resume?: string
}

/** 预览面板能渲染的类型（由主进程按扩展名判断，渲染进程只负责画）。 */
export type PreviewKind = 'markdown' | 'code' | 'image' | 'text' | 'binary'

/** 一次预览读取的结果。 */
export interface PreviewPayload {
  readonly ok: boolean
  /** 文件绝对路径（相对路径已按工作目录解析）。 */
  readonly path: string
  /** 渲染类型。 */
  readonly kind: PreviewKind
  /** 文本内容（`kind` 为 markdown / code / text 时）。 */
  readonly text?: string
  /** 代码高亮用的语言提示（`kind` 为 code 时，可能为空串）。 */
  readonly language?: string
  /** 图片的 data URL（`kind` 为 image 时）。 */
  readonly dataUrl?: string
  /** 文件字节数。 */
  readonly bytes?: number
  /** 文件太大 / 读失败时的说明。 */
  readonly error?: string
}
