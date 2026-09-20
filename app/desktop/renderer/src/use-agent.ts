/**
 * agent 状态机：把 `window.YuanMy` 的事件流归约成界面状态。
 *
 * 这里是**唯一**把 host 事件翻译成 UI 数据的地方，组件只读 `state.items`。
 * 归约器是纯函数：事件进、状态出，不碰 DOM、不碰网络。
 *
 * 一条会话由若干条目（items）组成：
 *   { kind: 'user',      text }
 *   { kind: 'note',      level, text }                  系统提示
 *   { kind: 'assistant', turnId, reasoning, blocks[], meta }
 * 其中 assistant 的 `blocks` 是**有序**的：正文块与工具卡片交替，
 * 这样「先说话 → 调工具 → 再说话」能被如实还原。
 *
 * 事件类型直接取自 host 的协议定义（`host/protocol.ts`）—— 只做类型导入，
 * 编译后不留运行时依赖，于是「协议真相」仍然只有一份。
 *
 * @module YuanMy/desktop/renderer/use-agent
 */

import { useCallback, useEffect, useReducer, useRef, type Dispatch } from 'react'
import type {
  AssistantItem,
  Block,
  CommandEntry,
  HostEvent,
  HostReadyInfo,
  Item,
  LlmUsage,
  McpEntry,
  ModelInfo,
  ProjectSummary,
  FileBrief,
  SessionSummary,
  SkillEntry,
  ToolBlock,
  TurnMeta,
} from '../../host/protocol.ts'

/** 重新导出协议里的类型，让组件只依赖本模块这一处「界面类型面」。 */
export type {
  AssistantItem, Block, CommandBrief, CommandEntry, FileBrief, HostReadyInfo, HostToolInfo, Item,
  LlmUsage, McpEntry, ModelInfo, ProjectSummary, SessionSummary, SkillBrief, SkillEntry, SteerItem,
  TextBlock, ToolBlock, TurnMeta, TurnOutcome, UserItem,
} from '../../host/protocol.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 主进程自己产生的事件（不在 host 协议里，见 `ipc.js` 的 SHELL_EVENT_TYPES）。 */
export type ShellEvent =
  | { readonly type: 'restarting'; readonly cwd: string }
  /** 切换超时兜底：`history` 帧迟迟不来时放开 `switching`（见 provider 里的定时器）。 */
  | { readonly type: 'switch-timeout' }
  | { readonly type: 'host-error'; readonly message: string }

/** 界面能收到的一切事件。 */
export type AgentEvent = HostEvent | ShellEvent

/** shell / agent 状态快照（`YuanMy:state` 的返回）。 */
export interface ShellState {
  readonly phase: 'booting' | 'ready' | 'error'
  readonly info?: HostReadyInfo
  readonly error?: string
  /**
   * 主进程缓存的项目 / 会话清单。
   *
   * 首帧 `workspace` 事件多半在界面订阅**之前**就推过了（界面要解析 10MB bundle），
   * 所以状态快照里带一份，保证侧栏一定能填上。见 `main.js` 的 `workspaceSnapshot`。
   */
  readonly workspace?: {
    readonly projects: readonly ProjectSummary[]
    readonly sessions: readonly SessionSummary[]
  }
}

/**
 * 设置界面要的一整份数据（host 的 `settings` 帧）。
 *
 * 三样东西一起给：技能、命令、MCP —— 它们都住在「配置目录」里，
 * 用户调一个的时候往往也想看另一个。
 */
export interface SettingsData {
  readonly skills: readonly SkillEntry[]
  readonly commands: readonly CommandEntry[]
  readonly mcp: readonly McpEntry[]
  /** MCP 配置文件路径（`<cwd>/.YuanMy/mcp.json`）。 */
  readonly mcpConfigPath: string
  /** 配置文件存在但解析失败时的原因。 */
  readonly mcpConfigError?: string
}

/** `YuanMy:settings-read` / `settings-write` 的返回。 */
export interface FileResult {
  readonly ok: boolean
  readonly content?: string
  readonly error?: string
}

/** `YuanMy:app-info` 的返回。 */
export interface AppInfo {
  readonly name: string
  readonly version: string
  readonly electron: string
  readonly chrome: string
  readonly node: string
  readonly platform: string
  readonly arch: string
  readonly hostNode?: string
  /** 窗口是否启用了原生磨砂玻璃。 */
  readonly nativeMaterial?: boolean
}

/** 启动 host 时可覆盖的配置。 */
export interface LaunchConfig {
  readonly cwd?: string
  readonly model?: string
  readonly provider?: string
  readonly effort?: string
  readonly persist?: boolean
  readonly sessionId?: string
  readonly resume?: string
}

/** preload 通过 `contextBridge` 暴露的全部能力。 */
export interface AgentApi {
  getState(): Promise<ShellState>
  getAppInfo(): Promise<AppInfo>
  onEvent(listener: (event: AgentEvent) => void): () => void
  sendPrompt(text: string): Promise<{ readonly turnId: string }>
  cancel(): Promise<void>
  setModel(model: string): Promise<void>
  pickDirectory(): Promise<string | null>
  restart(config: LaunchConfig): Promise<ShellState>
  newSession(): Promise<ShellState>
  /** 让 host 重新扫描落盘会话（结果以 `workspace` 事件回来）。 */
  refreshSessions(): Promise<void>
  /** 用系统默认程序打开一个文件；返回错误信息（成功时空串）。 */
  openPath(path: string): Promise<string>
  /** 读某个项目的会话明细（结果以 `project-sessions` 事件回来）。 */
  listProjectSessions(path: string): Promise<void>
  /** 中途调整目标：插给正在跑的回合（不排队、不新开回合）。 */
  steer(text: string): Promise<void>
  /** 要一批 `#` 候选文件（结果以 `files` 事件回来）。 */
  listFiles(query: string): Promise<void>
  /** 要一次设置数据（结果以 `settings` 事件回来）。 */
  settingsList(): Promise<void>
  /** 读写设置界面里的文件（主进程只允许配置与技能/命令目录）。 */
  settingsRead(path: string): Promise<FileResult>
  settingsWrite(path: string, content: string): Promise<FileResult>
}

declare global {
  interface Window {
    /** preload 注入；若注入失败则为 undefined（界面会给出明确提示）。 */
    readonly YuanMy?: AgentApi
  }
}

/**
 * 会话级 token 累计。
 *
 * ⚠️ DSH 的计数是**互斥**的（见 `host/protocol.ts` 的 `LlmUsage`）：
 * `inputTokens` 只算未命中缓存的输入，命中部分单独记在 `cacheReadTokens`，
 * 写缓存的记在 `cacheWriteTokens`。所以：
 *   - 计费输入 = 三者之和（{@link billedInputTokens}）
 *   - 命中率 = cacheReadTokens / 计费输入（{@link cacheHitRate}）
 */
export interface UsageTotals {
  /** 未命中缓存的输入 token。 */
  readonly inputTokens: number
  /** 输出 token。 */
  readonly outputTokens: number
  /** 命中缓存的输入 token。 */
  readonly cacheReadTokens: number
  /** 写入缓存的输入 token。 */
  readonly cacheWriteTokens: number
  /** 推理 token（output 的子集，只作展示）。 */
  readonly reasoningTokens: number
  /** 模型调用次数（一个回合可能有多个 step）。 */
  readonly calls: number
  /** 最近一次调用的原始计量，用于 tooltip 展示明细。 */
  readonly last: LlmUsage | null
}

/** 空的累计值。 */
export const emptyUsage: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  calls: 0,
  last: null,
}

/** 计费输入：未命中 + 命中 + 写入（三者互斥，相加才是这次请求的全部提示词 token）。 */
export function billedInputTokens(usage: UsageTotals): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * 缓存命中率。
 * @param usage - 累计值。
 * @returns `0..1`；还没有任何输入 token 时返回 `null`（界面显示 `—`，不要伪造 0%）。
 */
export function cacheHitRate(usage: UsageTotals): number | null {
  const billed = billedInputTokens(usage)
  if (billed <= 0) return null
  return usage.cacheReadTokens / billed
}

/** 把一次调用的计量并入累计。 */
function accumulate(usage: UsageTotals, next: LlmUsage): UsageTotals {
  return {
    inputTokens: usage.inputTokens + (next.inputTokens ?? 0),
    outputTokens: usage.outputTokens + (next.outputTokens ?? 0),
    cacheReadTokens: usage.cacheReadTokens + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: usage.cacheWriteTokens + (next.cacheWriteTokens ?? 0),
    reasoningTokens: usage.reasoningTokens + (next.reasoningTokens ?? 0),
    calls: usage.calls + 1,
    last: next,
  }
}

/**
 * 从工具调用里认出「这是个文件操作」，供界面渲染文件卡片。
 *
 * 只认最常见的三个文件工具与它们惯用的参数名 —— 认不出来就返回 undefined，
 * 界面退回普通工具行，不会硬编一张错卡片。
 * @param name - 工具名。
 * @param args - 工具参数摘要（`summarizeCall` 生成的一行文本）。
 * @returns 文件路径与操作类型；不是文件操作则 undefined。
 */
export function fileActionOf(
  name: string,
  args: string,
): { readonly path: string; readonly action: string } | undefined {
  const verbs: Record<string, string> = { read: '读取', read_image: '读取', write: '写入', edit: '修改' }
  const action = verbs[name]
  if (action === undefined) return undefined
  // summarizeCall 的输出形如 "src/foo.ts (lines=1+50)"，取第一个路径片段。
  const path = args.split(' ')[0]?.trim() ?? ''
  if (path === '' || path.startsWith('(')) return undefined
  return { path, action }
}

/** 轨迹视图的一步。 */
export interface TraceStep {
  readonly id: string
  readonly kind: 'user' | 'reasoning' | 'text' | 'tool' | 'note' | 'steer'
  /** 一行标题（工具名 / 用户 / 推理 等）。 */
  readonly label: string
  /** 细节：工具参数、结果摘要、正文片段。 */
  readonly detail: string
  /** 这一步是否失败（结果带错误）。 */
  readonly isError: boolean
}

/**
 * 把会话条目摊平成「轨迹」——按发生顺序列出 agent 做过的每一步。
 *
 * 这是调试视角：不追求好看，追求**顺序与结果一目了然**。
 * 纯函数：给定同样的条目，永远得到同样的步骤列表。
 * @param items - 会话条目。
 * @returns 轨迹步骤。
 */
export function traceSteps(items: readonly Item[]): TraceStep[] {
  const steps: TraceStep[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      steps.push({ id: item.id, kind: 'user', label: '用户', detail: item.text, isError: false })
      continue
    }
    if (item.kind === 'note') {
      steps.push({ id: item.id, kind: 'note', label: `提示(${item.level})`, detail: item.text, isError: item.level === 'error' })
      continue
    }
    if (item.kind === 'steer') {
      steps.push({ id: item.id, kind: 'steer', label: '目标调整', detail: item.text, isError: false })
      continue
    }
    if (item.reasoning !== '') {
      steps.push({ id: `${item.id}-r`, kind: 'reasoning', label: '推理', detail: item.reasoning, isError: false })
    }
    item.blocks.forEach((block, index) => {
      if (block.type === 'text') {
        steps.push({ id: `${item.id}-t${String(index)}`, kind: 'text', label: '回复', detail: block.text, isError: false })
        return
      }
      steps.push({
        id: `${item.id}-c${String(index)}`,
        kind: 'tool',
        label: block.name,
        detail: block.result === null ? `${block.args}（运行中）` : `${block.args}\n→ ${block.result}`,
        isError: block.isError,
      })
    })
    if (item.meta !== null && item.meta.outcome !== 'completed') {
      steps.push({ id: `${item.id}-m`, kind: 'note', label: '结束', detail: item.meta.error ?? item.meta.outcome, isError: item.meta.outcome === 'error' })
    }
  }
  return steps
}

/** 界面状态。 */
export interface AgentState {
  readonly phase: 'booting' | 'ready' | 'error'
  readonly error: string | null
  readonly info: HostReadyInfo | null
  readonly items: readonly Item[]
  readonly busy: boolean
  /**
   * 正在换会话 / 换项目 / 重启内核（内核已经在重启了，但界面**仍然显示旧内容**）。
   *
   * 为什么要有它，而不是直接把 `phase` 打回 `booting`：切换时旧内容不该消失 ——
   * 内容只在 `history` 帧到达时整段替换（见那个 case）。这个标记只用来
   * 显示「正在切换」并在切换期间挡掉提交（新内核还没就绪，发过去会失败）。
   */
  readonly switching: boolean
  /** 所有出现过的项目（当前项目排在最前）。 */
  readonly projects: readonly ProjectSummary[]
  /** **当前项目**的会话，按最近活动倒序。 */
  readonly sessions: readonly SessionSummary[]
  /**
   * **非当前项目**已加载的会话明细：项目路径 → 会话列表。
   *
   * 只装「被点开过」的项目 —— 侧栏里折叠的项目点开时才向 host 要数据
   * （`project-sessions` 事件），项目再多也不拖慢首屏。
   */
  readonly projectSessions: Readonly<Record<string, readonly SessionSummary[]>>
  /** 正在读取会话的项目路径（界面据此显示「读取中…」）；没有则是 null。 */
  readonly loadingProject: string | null
  /** 本会话的 token 累计。 */
  readonly usage: UsageTotals
  /** 该 provider 申报的可选模型（来自内核，不是界面写死的）。 */
  readonly models: readonly ModelInfo[]
  /** 上一回合的墙钟耗时（毫秒）；还没跑过为 null。 */
  readonly lastTurnMs: number | null
  /** 本会话已完成的回合数。 */
  readonly turns: number
  /** `#` 菜单的候选文件（响应 `files` 帧）。 */
  readonly files: readonly FileBrief[]
  /** 上面这批候选对应的查询串（界面据此丢弃过期结果）。 */
  readonly filesQuery: string
  /** 设置界面的数据；没打开过设置面板时为 null。 */
  readonly settings: SettingsData | null
  /** 正在等 host 回 `settings` 帧。 */
  readonly settingsBusy: boolean
}

/** 归约动作：来自 host 的事件，或界面自己的动作。 */
export type Action =
  | AgentEvent
  | { readonly type: 'user-send'; readonly text: string }
  | { readonly type: 'adopt-turn'; readonly turnId: string }
  | { readonly type: 'user-error'; readonly message: string }
  | { readonly type: 'project-sessions-loading'; readonly path: string }
  | { readonly type: 'project-sessions-error'; readonly path: string; readonly message: string }
  | { readonly type: 'settings-loading' }
  | { readonly type: 'steer-send'; readonly text: string }

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数工具
// ─────────────────────────────────────────────────────────────────────────────

/** 初始状态。 */
export const initialState: AgentState = {
  phase: 'booting',
  error: null,
  info: null,
  items: [],
  busy: false,
  switching: false,
  projects: [],
  sessions: [],
  projectSessions: {},
  loadingProject: null,
  usage: emptyUsage,
  models: [],
  lastTurnMs: null,
  turns: 0,
  settings: null,
  settingsBusy: false,
  files: [],
  filesQuery: '',
}

/** 生成条目 id（渲染列表的 key）。 */
function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`
}

/** 取当前正在流式渲染的助手条目；turnId 为 null 表示「还没拿到 id，先认领」。 */
function activeAssistant(items: readonly Item[], turnId: string | null): number {
  // ⚠️ 从后往前找**最后一条助手条目**，而不是只看最后一项：
  // 回合进行中用户可以「中途调整目标」，那会在助手条目后面追加一条 steer 条目 ——
  // 只看末项的话，后续的流式增量会找不到正在写的那条助手消息，
  // 于是把同一次回复拆成两个气泡。
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined || item.kind !== 'assistant') continue
    if (item.turnId === null || item.turnId === turnId) return index
    // 最近的一条助手条目属于别的回合：不再往前找（那是历史）
    return -1
  }
  return -1
}

/** 取助手条目；不是助手返回 null（用于类型收窄）。 */
function asAssistant(item: Item | undefined): AssistantItem | null {
  return item !== undefined && item.kind === 'assistant' ? item : null
}

/**
 * 取当前助手条目；没有就**补一个**。
 *
 * 正常情况下它一定存在（`user-send` 会先建好占位）。但界面重载、`getState()`
 * 与事件竞态等情况下可能先收到流式帧 —— 那时宁可多一条消息，也不能丢内容。
 * @returns 新的 items 与助手条目的下标。
 */
function ensureAssistant(items: readonly Item[], turnId: string): [Item[], number] {
  const index = activeAssistant(items, turnId)
  if (index !== -1) return [[...items], index]
  const created: AssistantItem = { id: newId(), kind: 'assistant', turnId, reasoning: '', blocks: [], meta: null }
  return [[...items, created], items.length]
}

/** 追加一段文本到「最后一个正文块」，没有就新建一块。 */
function appendText(blocks: readonly Block[], delta: string): Block[] {
  const tail = blocks[blocks.length - 1]
  if (tail !== undefined && tail.type === 'text') {
    return [...blocks.slice(0, -1), { ...tail, text: tail.text + delta }]
  }
  return [...blocks, { type: 'text', text: delta }]
}

/** 替换第 index 条。 */
function replaceItem(items: readonly Item[], index: number, next: Item): Item[] {
  return [...items.slice(0, index), next, ...items.slice(index + 1)]
}

// ─────────────────────────────────────────────────────────────────────────────
// 归约器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归约器：事件与界面动作 → 新状态。
 * @param state - 当前状态。
 * @param action - 事件或本地动作。
 */
export function reducer(state: AgentState, action: Action): AgentState {
  switch (action.type) {
    // ── 内核生命周期 ──────────────────────────────────────────────────
    case 'ready':
      return {
        ...state,
        phase: 'ready',
        error: null,
        info: action.info,
        busy: false,
        models: action.info.models ?? [],
      }

    /**
     * 换会话 / 换项目 / 重启内核。
     *
     * 两条路，判据是「界面上有没有内容」：
     *
     * | 情形 | 做什么 |
     * | --- | --- |
     * | **冷启动**（还没有内核） | 老路：清空 + `booting`，界面上本来就是空的 |
     * | **已经有内容**（切会话/切项目/重启内核） | **什么都不清**，只打 `switching` 标记；内容等 `history` 帧整段替换 |
     *
     * 第二条是「切换丝滑」的关键。早先这里无条件清空，于是点一下侧栏会连着抖四下：
     * 消息区白掉并闪出「正在启动内核…」、token 统计与轮次归零、模型下拉变空、
     * 已展开项目的会话列表显示「读取中…」。这些数据在切换前后其实都还有效
     * （模型来自内核配置、内容马上就会被历史覆盖），没有理由先抹掉再填回来。
     */
    case 'restarting':
      if (state.phase === 'ready' && state.info !== null) {
        // 回合状态要清：内核正在被杀，那一轮不可能再继续（内容由历史帧接管）。
        return { ...state, switching: true, busy: false }
      }
      // 新内核 = 新会话：对话、token 累计、已展开项目的会话缓存都要归零；
      // 项目清单等新一帧 `workspace` 覆盖。
      return {
        ...state,
        phase: 'booting',
        switching: false,
        error: null,
        info: null,
        items: [],
        busy: false,
        projectSessions: {},
        loadingProject: null,
        usage: emptyUsage,
        models: [],
        lastTurnMs: null,
        turns: 0,
      }

    /** 切换超时兜底：宁可放开标记（顶多显示旧内容），也别把界面永远锁在「正在切换」。 */
    case 'switch-timeout':
      return state.switching ? { ...state, switching: false } : state

    case 'workspace':
      return { ...state, projects: action.projects, sessions: action.sessions }

    /** 设置数据到了（打开设置面板、或点了刷新）。 */
    case 'settings':
      return {
        ...state,
        settingsBusy: false,
        settings: {
          skills: action.skills,
          commands: action.commands,
          mcp: action.mcp,
          mcpConfigPath: action.mcpConfigPath,
          ...(action.mcpConfigError === undefined ? {} : { mcpConfigError: action.mcpConfigError }),
        },
      }

    case 'settings-loading':
      return { ...state, settingsBusy: true }

    /** `#` 菜单的候选文件到了。 */
    case 'files':
      return { ...state, files: action.items, filesQuery: action.query }

    /**
     * 中途调整目标：本地先把这条记进会话，再让 host 转交给内核的 `steer`。
     *
     * 为什么不像 `user-send` 那样建一条助手占位：纠偏**不开启新回合** ——
     * 正在跑的那条助手消息还在写，凭空插一个占位会把它的流式增量引到新气泡上。
     */
    case 'steer-send':
      return {
        ...state,
        items: [...state.items, { id: newId(), kind: 'steer', text: action.text }],
      }

    /**
     * 历史回放：恢复会话时 host 读日志送来的完整记录。
     *
     * **整段替换**而不是追加 —— 回放与实时是两条独立路径，混起来会重复。
     * `usage` 同样按「历史总和」重置（`last` 置空：历史里没有「最近一次调用」的
     * 明细，硬凑一个反而误导）。
     */
    /**
     * 历史回放（host 在每次就绪后**一定会**发一帧，新建会话发的是空历史）。
     *
     * 这一帧也是「切换结束」的信号：`switching` 在这里解除，而不是在 `ready` 那里 ——
     * `ready` 先到、历史后到，若在 `ready` 就放开，用户此时按下回车可能把消息发进
     * 一个「内容马上要被历史覆盖」的界面，那条消息会被覆盖掉。
     */
    case 'history':
      return {
        ...state,
        switching: false,
        items: action.items,
        usage: { ...emptyUsage, ...action.usage, last: null },
        turns: action.turns,
        // 耗时是「上一回合」的量，历史里没有记录 → 保持未知，不伪造。
        lastTurnMs: null,
      }

    /** 某个折叠项目的会话明细到了（也可能是「读不到」的空结果）。 */
    case 'project-sessions':
      return {
        ...state,
        loadingProject: state.loadingProject === action.path ? null : state.loadingProject,
        projectSessions: { ...state.projectSessions, [action.path]: action.sessions },
      }

    case 'usage':
      return { ...state, usage: accumulate(state.usage, action.usage) }

    case 'host-error':
    case 'fatal':
      return {
        ...state,
        phase: 'error',
        error: action.message,
        busy: false,
        items: [...state.items, { id: newId(), kind: 'note', level: 'error', text: action.message }],
      }

    case 'notice':
      // 子进程输出不可信：主进程只做了浅校验，这里补齐缺省值。
      return {
        ...state,
        items: [...state.items, { id: newId(), kind: 'note', level: action.level ?? 'info', text: action.message }],
      }

    case 'model-changed':
      return { ...state, info: state.info === null ? null : { ...state.info, model: action.model } }

    // ── 本地动作：用户点了发送 ────────────────────────────────────────
    case 'user-send':
      return {
        ...state,
        busy: true,
        items: [
          ...state.items,
          { id: newId(), kind: 'user', text: action.text },
          // 先建好助手条目再发请求：首个流式帧可能比 invoke 的响应先到。
          { id: newId(), kind: 'assistant', turnId: null, reasoning: '', blocks: [], meta: null },
        ],
      }

    /** 助手占位条目认领主进程返回的 turnId。 */
    case 'adopt-turn': {
      const index = activeAssistant(state.items, null)
      const current = asAssistant(state.items[index])
      if (current === null || current.turnId !== null) return state
      return { ...state, items: replaceItem(state.items, index, { ...current, turnId: action.turnId }) }
    }

    // ── 流式增量 ──────────────────────────────────────────────────────
    case 'text-delta': {
      const [items, index] = ensureAssistant(state.items, action.turnId)
      const current = asAssistant(items[index])
      if (current === null) return state
      const next: AssistantItem = {
        ...current,
        blocks: appendText(current.blocks, action.text),
      }
      return { ...state, items: replaceItem(items, index, next) }
    }

    case 'reasoning-delta': {
      const [items, index] = ensureAssistant(state.items, action.turnId)
      const current = asAssistant(items[index])
      if (current === null) return state
      const next: AssistantItem = { ...current, reasoning: current.reasoning + action.text }
      return { ...state, items: replaceItem(items, index, next) }
    }

    // ── 工具调用 ──────────────────────────────────────────────────────
    case 'tool-call': {
      const [items, index] = ensureAssistant(state.items, action.turnId)
      const current = asAssistant(items[index])
      if (current === null) return state
      const block: ToolBlock = {
        type: 'tool',
        callId: action.callId,
        name: action.name,
        args: action.summary,
        result: null,
        isError: false,
      }
      const next: AssistantItem = { ...current, blocks: [...current.blocks, block] }
      return { ...state, items: replaceItem(items, index, next) }
    }

    case 'tool-result': {
      const [items, index] = ensureAssistant(state.items, action.turnId)
      const current = asAssistant(items[index])
      if (current === null) return state
      let matched = false
      const blocks: Block[] = current.blocks.map((block) => {
        if (block.type !== 'tool' || block.callId !== action.callId) return block
        matched = true
        return { ...block, result: action.summary, isError: action.isError === true }
      })
      // 结果先于调用到达（或缺了调用帧）：补一张卡片，信息别丢。
      if (!matched) {
        blocks.push({
          type: 'tool',
          callId: action.callId,
          name: action.name,
          args: '',
          result: action.summary,
          isError: action.isError === true,
        })
      }
      return { ...state, items: replaceItem(items, index, { ...current, blocks }) }
    }

    // ── 回合收尾 ──────────────────────────────────────────────────────
    case 'turn-end': {
      const index = activeAssistant(state.items, action.turnId)
      const next: AgentState = { ...state, busy: false }
      const current = asAssistant(state.items[index])
      if (current === null) return next
      // 流式增量是正文的权威来源；真丢了帧才用 turn-end 的汇总补。
      const fallbackText = action.text ?? ''
      const blocks: readonly Block[] = current.blocks.length === 0 && fallbackText !== ''
        ? [{ type: 'text', text: fallbackText }]
        : current.blocks
      const meta: TurnMeta = { outcome: action.outcome, error: action.error, toolCalls: action.toolCalls ?? 0 }
      return {
        ...next,
        items: replaceItem(state.items, index, { ...current, blocks, meta }),
        // 统计条用的「上一轮耗时 / 已完成轮次」
        lastTurnMs: action.durationMs ?? null,
        turns: state.turns + 1,
      }
    }

    case 'user-error':
      return {
        ...state,
        busy: false,
        items: [...state.items, { id: newId(), kind: 'note', level: 'error', text: action.message }],
      }

    // ── 本地动作：展开一个折叠的项目 ──────────────────────────────────
    /** 开始读：标记「读取中」，界面此刻显示占位而不是空列表。 */
    case 'project-sessions-loading':
      return { ...state, loadingProject: action.path }

    case 'project-sessions-error':
      return {
        ...state,
        loadingProject: state.loadingProject === action.path ? null : state.loadingProject,
        items: [...state.items, { id: newId(), kind: 'note', level: 'warn', text: action.message }],
      }

    default:
      return state
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

/** `useAgent()` 的返回值。 */
export interface AgentController {
  readonly state: AgentState
  readonly send: (text: string) => Promise<void>
  readonly cancel: () => Promise<void> | undefined
  readonly setModel: (model: string) => Promise<void> | undefined
  readonly newSession: () => Promise<ShellState> | undefined
  /**
   * 恢复一个已落盘的会话。
   * @param sessionId - 会话 id。
   * @param cwd - 该会话所属的项目；省略表示当前项目。
   */
  readonly resumeSession: (sessionId: string, cwd?: string) => Promise<void>
  /** 切到另一个项目（换工作目录 = 用新 cwd 重启内核）。 */
  readonly openProject: (path: string) => Promise<void>
  /** 重新扫描会话列表。 */
  readonly refreshSessions: () => Promise<void>
  /** 读一个折叠项目的会话明细（结果以 `project-sessions` 事件回来）。 */
  readonly loadProjectSessions: (path: string) => Promise<void>
  /** 用系统默认程序打开一个文件（文件卡片的「打开」按钮）。 */
  readonly openPath: (path: string) => Promise<void>
  /**
   * 用当前配置重启内核。
   *
   * 用途：改完 MCP 配置（`<cwd>/.YuanMy/mcp.json`）后让它生效 ——
   * MCP 服务器是启动时挂的，不重启不会变。
   */
  readonly restartKernel: () => Promise<ShellState> | undefined
  /**
   * 中途调整目标：把这段话插给正在跑的回合。
   *
   * 用内核的 `steer` 而不是再发一个 `prompt`：后者是排队（等这轮跑完才轮到它），
   * 而「调整目标」要的是**立刻改方向** —— 内核会在下一个 step 边界消费它。
   */
  readonly steer: (text: string) => Promise<void>
  /** 要一批 `#` 候选文件（结果以 `files` 事件回来）。 */
  readonly listFiles: (query: string) => Promise<void>
  /** 拉一次设置数据（打开设置面板时调用）。 */
  readonly loadSettings: () => Promise<void>
  /** 读一个配置文件。 */
  readonly readFile: (path: string) => Promise<FileResult>
  /** 写一个配置文件。 */
  readonly writeFile: (path: string, content: string) => Promise<FileResult>
  readonly pickDirectory: () => Promise<string | null>
  readonly getAppInfo: () => Promise<AppInfo> | undefined
}

/**
 * 把主进程的事件接进 React。
 *
 * 订阅 + 拉快照**两条腿**：先订阅再 `getState()`，这样无论内核在界面订阅之前
 * 还是之后就绪，都不会漏掉 `ready`。
 * @returns 状态与可调用的动作。
 */
export function useAgent(): AgentController {
  const [state, dispatch] = useReducer(reducer, initialState)
  /** 事件回调放在 ref 里，避免订阅在每次渲染时重建。 */
  const dispatchRef = useRef<Dispatch<Action>>(dispatch)
  dispatchRef.current = dispatch

  /**
   * 切换会话的兜底：`switching` 正常由 `history` 帧解除，
   * 但万一那一帧永远不来（host 崩了 / 读日志卡住），不能把界面锁死在「正在切换」上。
   * 3 秒后自己放开 —— 顶多是显示着旧内容，比锁死好。
   */
  useEffect(() => {
    if (!state.switching) return undefined
    const timer = setTimeout(() => { dispatch({ type: 'switch-timeout' }) }, 3000)
    return () => { clearTimeout(timer) }
  }, [state.switching])

  useEffect(() => {
    const api = globalThis.window?.YuanMy
    if (api === undefined) {
      dispatch({ type: 'notice', level: 'error', message: 'window.YuanMy 不存在：preload 没有加载。' })
      return undefined
    }

    // host 事件与主进程自产事件共用一条通道，形状由协议保证。
    const off = api.onEvent((event) => { dispatchRef.current(event) })

    // 清单也主动拉一次：即使首帧推送被丢掉，也能自己补上（host 会重新扫盘）。
    void api.refreshSessions().catch(() => { /* 拿不到就等下一次推送 */ })

    api.getState().then(
      (current) => {
        if (current.workspace !== undefined) {
          dispatchRef.current({ type: 'workspace', ...current.workspace })
        }
        if (current.phase === 'ready' && current.info !== undefined) {
          dispatchRef.current({ type: 'ready', info: current.info })
        } else if (current.phase === 'error') {
          dispatchRef.current({ type: 'host-error', message: current.error ?? '内核不可用' })
        }
      },
      (error: unknown) => {
        dispatchRef.current({ type: 'host-error', message: String((error as Error | undefined)?.message ?? error) })
      },
    )

    return off
  }, [])

  const api = globalThis.window?.YuanMy

  /** 发送一个回合。 */
  const send = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === '' || api === undefined) return
    dispatch({ type: 'user-send', text: trimmed })
    try {
      const result = await api.sendPrompt(trimmed)
      // 让助手条目认领真正的 turnId（若首帧已经先到，它已经认领过了）。
      dispatch({ type: 'adopt-turn', turnId: result.turnId })
    } catch (error) {
      dispatch({ type: 'user-error', message: `发送失败：${String((error as Error | undefined)?.message ?? error)}` })
    }
  }, [api])

  const cancel = useCallback(() => api?.cancel(), [api])
  const setModel = useCallback((model: string) => api?.setModel(model), [api])
  const newSession = useCallback(() => api?.newSession(), [api])
  /**
   * 恢复会话：`--resume` 要求开启持久化，桌面端默认是开的。
   *
   * 跨项目恢复必须带上 `cwd`：会话 id 只在它自己的项目里有效，否则会得到
   * 「会话不存在」（`main.js` 换目录时也会主动丢掉 resume）。
   */
  const resumeSession = useCallback(async (sessionId: string, cwd?: string): Promise<void> => {
    dispatch({ type: 'restarting', cwd: cwd ?? '' })
    try {
      await api?.restart({ cwd, resume: sessionId, sessionId: undefined })
    } catch (error) {
      dispatch({ type: 'user-error', message: `恢复会话失败：${String((error as Error | undefined)?.message ?? error)}` })
    }
  }, [api])
  const openProject = useCallback(async (path: string): Promise<void> => {
    dispatch({ type: 'restarting', cwd: path })
    try {
      await api?.restart({ cwd: path, resume: undefined, sessionId: undefined })
    } catch (error) {
      dispatch({ type: 'user-error', message: `切换项目失败：${String((error as Error | undefined)?.message ?? error)}` })
    }
  }, [api])
  const refreshSessions = useCallback(async (): Promise<void> => {
    // 主进程会把这个请求转给 host，结果以 `workspace` 帧回来。
    await api?.refreshSessions()
  }, [api])
  /**
   * 展开一个折叠的项目：让 host 去读它的会话。
   * 读盘发生在 host 侧，界面这一侧只负责发请求与标记「读取中」。
   */
  const loadProjectSessions = useCallback(async (path: string): Promise<void> => {
    dispatch({ type: 'project-sessions-loading', path })
    try {
      await api?.listProjectSessions(path)
    } catch (error) {
      dispatch({
        type: 'project-sessions-error',
        path,
        message: `读取项目会话失败：${String((error as Error | undefined)?.message ?? error)}`,
      })
    }
  }, [api])
  const pickDirectory = useCallback(async (): Promise<string | null> => {
    const picked = await api?.pickDirectory()
    if (typeof picked === 'string' && picked !== '') await api?.restart({ cwd: picked })
    return picked ?? null
  }, [api])
  const openPath = useCallback(async (path: string): Promise<void> => {
    const result = await api?.openPath(path)
    // 主进程返回错误字符串（例如文件不存在），成功时空字符串
    if (typeof result === 'string' && result !== '') {
      dispatch({ type: 'user-error', message: `打开失败：${result}` })
    }
  }, [api])
  /**
   * 拉一次设置数据。
   *
   * 刻意**不**缓存到 state 以外的地方：每次打开设置面板都重新拉，
   * 这样「改完文件切回来」看到的一定是盘上的现状。
   */
  const restartKernel = useCallback((): Promise<ShellState> | undefined => {
    const cwd = state.info?.cwd
    dispatch({ type: 'restarting', cwd: cwd ?? '' })
    return api?.restart(cwd === undefined ? {} : { cwd })
  }, [api, state.info?.cwd])

  const steer = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === '' || api === undefined) return
    dispatch({ type: 'steer-send', text: trimmed })
    try {
      await api.steer(trimmed)
    } catch (error) {
      dispatch({ type: 'user-error', message: `目标调整没送出去：${String((error as Error | undefined)?.message ?? error)}` })
    }
  }, [api])

  const listFiles = useCallback(async (query: string): Promise<void> => {
    if (api === undefined) return
    try {
      await api.listFiles(query)
    } catch {
      // 文件索引拿不到就是菜单空着，不值得打断输入
    }
  }, [api])

  const loadSettings = useCallback(async (): Promise<void> => {
    if (api === undefined) return
    dispatch({ type: 'settings-loading' })
    try {
      await api.settingsList()
    } catch (error) {
      dispatch({ type: 'settings-loading' })
      dispatch({ type: 'user-error', message: `读设置失败：${String((error as Error | undefined)?.message ?? error)}` })
    }
  }, [api])

  const readFile = useCallback(async (path: string): Promise<FileResult> => {
    if (api === undefined) return { ok: false, error: 'window.YuanMy 不可用' }
    return api.settingsRead(path)
  }, [api])

  const writeFile = useCallback(async (path: string, content: string): Promise<FileResult> => {
    if (api === undefined) return { ok: false, error: 'window.YuanMy 不可用' }
    const result = await api.settingsWrite(path, content)
    // 写成功后顺手刷新设置数据：列表里的「大小/告警」要跟着变
    if (result.ok) void loadSettings()
    return result
  }, [api, loadSettings])

  const getAppInfo = useCallback(() => api?.getAppInfo(), [api])

  return {
    state,
    send,
    cancel,
    setModel,
    newSession,
    resumeSession,
    openProject,
    refreshSessions,
    loadProjectSessions,
    openPath,
    pickDirectory,
    getAppInfo,
    steer,
    listFiles,
    restartKernel,
    loadSettings,
    readFile,
    writeFile,
  }
}
