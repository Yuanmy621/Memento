/**
 * Electron 主进程 ⇄ 渲染进程之间的 IPC 频道名与状态形状。
 *
 * 这个文件只被 **主进程**（`main.js`）引用。渲染进程拿不到它 ——
 * 渲染进程与主进程之间的唯一通道是 `preload.js` 通过 `contextBridge`
 * 暴露的 `window.YuanMy`，那是刻意设计的单向收口：
 *
 *   渲染进程（网页）── window.YuanMy ──▶ preload ──IPC──▶ 主进程 ──▶ agent host
 *
 * ⚠️ 频道名同时出现在三处：本文件、`preload.js`（CommonJS，沙箱化 preload 不支持
 * 相对路径 require，只能自带字面量）、以及渲染进程调用的方法名。改名字要一起改；
 * 漏改的表现是渲染进程 invoke 报 "No handler registered"。
 *
 * @module YuanMy/desktop/ipc
 */

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
  /** 渲染进程 → 主进程：读某个项目的会话明细（侧栏里点开折叠的项目）。 */
  listProjectSessions: 'YuanMy:list-project-sessions',
  /** 渲染进程 → 主进程：Electron / Node / 应用版本信息。 */
  appInfo: 'YuanMy:app-info',
})

/**
 * 主进程**自己**产生（不是从 host 转发）的事件类型，与 `HostEvent` 走同一条通道。
 *
 *   - `restarting`：即将用新配置重启内核，界面应清空当前对话；
 *   - `host-error`：host 启动失败或异常退出，界面进入不可用状态。
 */
export const SHELL_EVENT_TYPES = Object.freeze(['restarting', 'host-error'])

/**
 * @typedef {object} ShellState
 * @property {'booting' | 'ready' | 'error'} phase - shell 当前阶段。
 * @property {import('./host/protocol.ts').HostReadyInfo} [info] - 就绪后的内核信息。
 * @property {string} [error] - 失败原因。
 */

/**
 * @typedef {object} LaunchConfig
 * @property {string} cwd - agent 的工作目录。
 * @property {string} [model] - 模型 id。
 * @property {string} [provider] - provider id。
 * @property {string} [effort] - 推理强度。
 * @property {boolean} [persist] - 是否把会话写入磁盘。
 * @property {string} [sessionId] - 指定新会话 id。
 * @property {string} [resume] - 恢复已落盘的会话 id。
 */
