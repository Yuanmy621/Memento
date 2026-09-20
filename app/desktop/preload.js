/**
 * 安全桥（preload）—— 渲染进程能看到的**全部**原生能力都在这里。
 *
 * ⚠️ 这个 `.js` 文件是 **CommonJS**，不是 ESM —— 别把它改成 `import`。
 *
 *   根 `package.json` 是 `"type": "module"`，按 Node 的规则 `.js` 该是 ESM；
 *   但 **Electron 加载 preload 时会忽略 `"type": "module"`**，一律当 CommonJS 跑
 *   （官方文档 *ES Modules (ESM) in Electron* → "Preload scripts will ignore
 *   `type: module` fields"）。沙箱化 preload 也不支持 ESM `import`。
 *   所以这里用 `require('electron')` 是有效且经过冒烟测试验证的。
 *
 *   代价：所有静态工具（Node、编辑器、linter、打包器）都会把它**当成 ESM**，
 *   只有 Electron 自己知道真相。为了不让这个差异变成暗礁：
 *     - 它必须是 CommonJS：沙箱化 preload 里不能用 `import` / `export`；
 *     - 想让它自我说明，把扩展名换回 `.cjs` 即可（官方 DSH 桌面端就是
 *       `main.js`(ESM) + `preload-app.cjs`(CJS) 这种搭配），其余代码不用动。
 *
 * 为什么必须自包含、不 require 任何本地文件：
 *   沙箱下 preload 的 `require` 只认 `electron` 和少数内置模块，**不支持相对路径**。
 *   所以频道名字面量只能重复一份（与 `ipc.js` 的 `IPC` 表保持一致，改名字要两处都改）。
 *
 * 为什么只暴露这几个方法：
 *   渲染进程是「网页」，不该拿到 ipcRenderer / require / fs。`contextBridge` 把
 *   下面这个对象**深拷贝**到 `window.YuanMy`，网页只能看到函数，看不到 Electron 对象。
 *
 * @module YuanMy/desktop/preload
 */

const { contextBridge, ipcRenderer } = require('electron')

/** 与 `ipc.js` 的 `IPC` 表逐字对应。 */
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
})

/** 渲染进程可见的 API。 */
const api = {
  /** 取当前 shell / agent 状态：`{ phase, info?, error? }`。 */
  getState: () => ipcRenderer.invoke(CHANNEL.state),
  /** Electron / Node / 应用版本信息。 */
  getAppInfo: () => ipcRenderer.invoke(CHANNEL.appInfo),
  /**
   * 订阅 agent 事件。
   * @param {(event: object) => void} listener - 收到每一个事件帧。
   * @returns {() => void} 取消订阅。
   */
  onEvent: (listener) => {
    const handle = (_event, payload) => { listener(payload) }
    ipcRenderer.on(CHANNEL.hostEvent, handle)
    return () => { ipcRenderer.off(CHANNEL.hostEvent, handle) }
  },
  /**
   * 发起一个回合。
   * @param {string} text - 用户输入。
   * @returns {Promise<{ turnId: string }>} 主进程分配的回合 id。
   */
  sendPrompt: (text) => ipcRenderer.invoke(CHANNEL.prompt, text),
  /** 中断当前回合。 */
  cancel: () => ipcRenderer.invoke(CHANNEL.cancel),
  /**
   * 让 agent host 重新扫描落盘会话。
   * 结果不是返回值，而是随后到达的 `workspace` 事件。
   */
  refreshSessions: () => ipcRenderer.invoke(CHANNEL.listSessions),
  /**
   * 用系统默认程序打开一个文件（文件卡片的「打开」按钮）。
   * @param {string} path - 绝对路径。
   * @returns {Promise<string>} 错误信息；成功时空串。
   */
  openPath: (path) => ipcRenderer.invoke(CHANNEL.openPath, path),
  /**
   * 读某个项目的会话明细（侧栏里点开一个折叠的项目时用）。
   * 结果不是返回值，而是随后到达的 `project-sessions` 事件。
   * @param {string} path - 项目根目录。
   */
  listProjectSessions: (path) => ipcRenderer.invoke(CHANNEL.listProjectSessions, path),
  /** 中途调整目标：插给正在跑的回合（内核在下个 step 边界消费）。 */
  steer: (text) => ipcRenderer.invoke(CHANNEL.steer, text),
  /** 要一批 `#` 候选文件；结果以 `files` 事件异步回来。 */
  listFiles: (query) => ipcRenderer.invoke(CHANNEL.listFiles, query),
  /** 要一次设置数据（skill / 命令 / MCP）；结果以 `settings` 事件异步回来。 */
  settingsList: () => ipcRenderer.invoke(CHANNEL.settingsList),
  /** 读一个配置文件；返回 `{ ok, content?, error? }`。 */
  settingsRead: (path) => ipcRenderer.invoke(CHANNEL.settingsRead, path),
  /** 写一个配置文件；返回 `{ ok, error? }`。 */
  settingsWrite: (path, content) => ipcRenderer.invoke(CHANNEL.settingsWrite, path, content),
  /**
   * 切换模型（下一次请求生效）。
   * @param {string} model - 模型 id。
   */
  setModel: (model) => ipcRenderer.invoke(CHANNEL.setModel, model),
  /**
   * 打开原生目录选择框。
   * @returns {Promise<string | null>} 选中的目录，取消时为 null。
   */
  pickDirectory: () => ipcRenderer.invoke(CHANNEL.pickDirectory),
  /**
   * 用新配置重启 agent host。
   * @param {{ cwd?: string, model?: string }} config - 允许覆盖的字段。
   */
  restart: (config) => ipcRenderer.invoke(CHANNEL.restart, config),
  /** 新建一个空会话（重启 host，不恢复旧会话）。 */
  newSession: () => ipcRenderer.invoke(CHANNEL.newSession),
}

contextBridge.exposeInMainWorld('YuanMy', Object.freeze(api))
