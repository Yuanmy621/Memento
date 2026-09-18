/**
 * agent 状态机：把 `window.YuanMy` 的事件流归约成界面状态。
 *
 * 这里是**唯一**把 host 事件翻译成 UI 数据的地方，组件只读 `state.items`。
 * 归约器是纯函数，所以能在 Node 里直接回放测试（见 `scripts/ui-smoke.js`）。
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
  HostEvent,
  HostReadyInfo,
  LlmUsage,
  ProjectSummary,
  SessionSummary,
  TurnOutcome,
} from '../../host/protocol.ts'

/** 重新导出协议里的类型，让组件只依赖本模块这一处「界面类型面」。 */
export type { HostReadyInfo, LlmUsage, ProjectSummary, SessionSummary, TurnOutcome } from '../../host/protocol.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 主进程自己产生的事件（不在 host 协议里，见 `ipc.js` 的 SHELL_EVENT_TYPES）。 */
export type ShellEvent =
  | { readonly type: 'restarting'; readonly cwd: string }
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
  /** 读某个项目的会话明细（结果以 `project-sessions` 事件回来）。 */
  listProjectSessions(path: string): Promise<void>
}

declare global {
  interface Window {
    /** preload 注入；若注入失败则为 undefined（界面会给出明确提示）。 */
    readonly YuanMy?: AgentApi
  }
}

/** 助手正文块。 */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** 一次工具调用（`result === null` 表示还在跑）。 */
export interface ToolBlock {
  readonly type: 'tool'
  readonly callId: string
  readonly name: string
  readonly args: string
  readonly result: string | null
  readonly isError: boolean
}

export type Block = TextBlock | ToolBlock

/** 回合结论。 */
export interface TurnMeta {
  readonly outcome: TurnOutcome
  readonly error?: string
  readonly toolCalls: number
}

export interface UserItem {
  readonly id: string
  readonly kind: 'user'
  readonly text: string
}

export interface NoteItem {
  readonly id: string
  readonly kind: 'note'
  readonly level: 'info' | 'warn' | 'error'
  readonly text: string
}

export interface AssistantItem {
  readonly id: string
  readonly kind: 'assistant'
  /** 尚未认领主进程的 turnId 时为 null。 */
  readonly turnId: string | null
  readonly reasoning: string
  readonly blocks: readonly Block[]
  /** null 表示这一回合还在进行。 */
  readonly meta: TurnMeta | null
}

export type Item = UserItem | NoteItem | AssistantItem

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

/** 界面状态。 */
export interface AgentState {
  readonly phase: 'booting' | 'ready' | 'error'
  readonly error: string | null
  readonly info: HostReadyInfo | null
  readonly items: readonly Item[]
  readonly busy: boolean
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
}

/** 归约动作：来自 host 的事件，或界面自己的动作。 */
export type Action =
  | AgentEvent
  | { readonly type: 'user-send'; readonly text: string }
  | { readonly type: 'adopt-turn'; readonly turnId: string }
  | { readonly type: 'user-error'; readonly message: string }
  | { readonly type: 'project-sessions-loading'; readonly path: string }
  | { readonly type: 'project-sessions-error'; readonly path: string; readonly message: string }

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
  projects: [],
  sessions: [],
  projectSessions: {},
  loadingProject: null,
  usage: emptyUsage,
}

/** 生成条目 id（渲染列表的 key）。 */
function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`
}

/** 取当前正在流式渲染的助手条目；turnId 为 null 表示「还没拿到 id，先认领」。 */
function activeAssistant(items: readonly Item[], turnId: string | null): number {
  const last = items[items.length - 1]
  if (last === undefined || last.kind !== 'assistant') return -1
  if (last.turnId === null || last.turnId === turnId) return items.length - 1
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
      return { ...state, phase: 'ready', error: null, info: action.info, busy: false }

    case 'restarting':
      // 新内核 = 新会话：对话、token 累计、已展开项目的会话缓存都要归零；
      // 项目清单等新一帧 `workspace` 覆盖。
      return {
        ...state,
        phase: 'booting',
        error: null,
        info: null,
        items: [],
        busy: false,
        projectSessions: {},
        loadingProject: null,
        usage: emptyUsage,
      }

    case 'workspace':
      return { ...state, projects: action.projects, sessions: action.sessions }

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
      return { ...next, items: replaceItem(state.items, index, { ...current, blocks, meta }) }
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
    pickDirectory,
    getAppInfo,
  }
}
