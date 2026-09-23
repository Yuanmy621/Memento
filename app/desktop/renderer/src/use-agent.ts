/**
 * agent 状态机：把 `window.Memento` 的事件流归约成界面状态，是唯一把 host 事件翻译成 UI 数据的地方。
 *
 * 归约器是纯函数（事件进、状态出，不碰 DOM 与网络），组件只读 `state.items`。assistant 条目的
 * `blocks` 有序：正文块与工具卡片交替，据此还原「先说话 → 调工具 → 再说话」。事件类型只做类型
 * 导入，协议真相仍然只有 `host/protocol.ts` 一份。
 *
 * @module Memento/desktop/renderer/use-agent
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
/** 会话视图键（`sessionKey`）：与主进程共用同一个算法，事件按它路由；值是纯函数，所以值导入。 */
import { sessionKey } from '../../host/protocol.ts'
/** 预览面板、git 与「切会话」的类型面同样只有一份。 */
export type { GitPullResult, GitStatus, GitSwitchResult } from '../../ipc.ts'
import type {
  AttachRequest, AttachResult, GitPullResult, GitStatus, GitSwitchResult, PreviewPayload,
} from '../../ipc.ts'
/** 显示用的小工具（首行预览）；纯函数，界面与轨迹共用一套口径。 */
import { firstLine } from './tool-names.ts'

/** 重新导出协议里的类型，让组件只依赖本模块这一处「界面类型面」。 */
export type {
  AssistantItem, Block, CommandBrief, CommandEntry, FileBrief, HostReadyInfo, HostToolInfo, Item,
  LlmUsage, McpEntry, ModelEffortInfo, ModelInfo, ProjectSummary, SessionSummary, SkillBrief, SkillEntry,
  SteerItem, TextBlock, ToolBlock, TurnMeta, TurnOutcome, UserItem,
} from '../../host/protocol.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 界面能收到的「非 host 事件」。比主进程那边的 `ShellEvent`（`app/desktop/ipc.ts`）多一条
 * `switch-timeout`：那是界面自己的兜底动作，不是主进程发来的。
 */
export type ShellEvent =
  | { readonly type: 'restarting'; readonly cwd: string }
  /** 切换超时兜底：`history` 帧迟迟不来时放开 `switching`（见 hook 里的定时器）。 */
  | { readonly type: 'switch-timeout' }
  | { readonly type: 'host-error'; readonly message: string }

/** 界面能收到的一切事件。 */
export type AgentEvent = (HostEvent | ShellEvent) & {
  /**
   * 这一帧属于哪个会话视图（`sessionKey()`，由主进程打上）；界面自己的动作没有它，落到当前会话。
   * 主进程可以同时持有多个 host，不按它分发，后台会话的正文就会串进前台。
   */
  readonly hostId?: string
}

/** shell / agent 状态快照（`Memento:state` 的返回）。 */
export interface ShellState {
  readonly phase: 'booting' | 'ready' | 'error'
  readonly info?: HostReadyInfo
  readonly error?: string
  /** 当前会话视图的键（界面重载后据此重新接管那个会话）。 */
  readonly activeKey?: string
  /**
   * 主进程缓存的项目 / 会话清单：首帧 `workspace` 事件多半在界面订阅之前就推过了（界面要解析
   * 10MB 的 bundle），快照里带一份，侧栏才一定能填上（见 `main.ts` 的 `workspaceSnapshot`）。
   */
  readonly workspace?: {
    readonly projects: readonly ProjectSummary[]
    readonly sessions: readonly SessionSummary[]
  }
}

/**
 * 设置界面要的一整份数据（host 的 `settings` 帧）：技能、命令、MCP 都住在「配置目录」里，
 * 用户调一个的时候往往也想看另一个，所以一起给。
 */
export interface SettingsData {
  readonly skills: readonly SkillEntry[]
  readonly commands: readonly CommandEntry[]
  readonly mcp: readonly McpEntry[]
  /** MCP 配置文件路径（`<cwd>/.Memento/mcp.json`）。 */
  readonly mcpConfigPath: string
  /** 配置文件存在但解析失败时的原因。 */
  readonly mcpConfigError?: string
}

/** `Memento:settings-read` / `settings-write` 的返回。 */
export interface FileResult {
  readonly ok: boolean
  readonly content?: string
  readonly error?: string
}

/** `Memento:app-info` 的返回。 */
export interface AppInfo {
  readonly name: string
  readonly version: string
  readonly electron: string
  readonly chrome: string
  readonly node: string
  readonly platform: string
  readonly arch: string
  /** 家目录：面包屑用它把绝对路径缩写成一个 `~` 段（见 `breadcrumb.tsx` 的 `crumbsOf`）。 */
  readonly home: string
  readonly hostNode?: string
  /** 窗口是否启用了原生磨砂玻璃。 */
  readonly nativeMaterial?: boolean
}

/** preload 通过 `contextBridge` 暴露的全部能力。 */
export interface AgentApi {
  getState(): Promise<ShellState>
  getAppInfo(): Promise<AppInfo>
  onEvent(listener: (event: AgentEvent) => void): () => void
  sendPrompt(text: string): Promise<{ readonly turnId: string }>
  cancel(): Promise<void>
  setModel(model: string): Promise<void>
  /** 运行中切换推理强度（`low | high | max`）：下一次请求生效。 */
  setEffort(effort: string): Promise<void>
  /** 读当前工作目录的 git 情况（面包屑的分支段）。 */
  gitStatus(): Promise<GitStatus>
  /** 切分支；分支名取自上一次 `gitStatus()` 的列表。 */
  gitSwitch(branch: string): Promise<GitSwitchResult>
  /** 拉取当前分支最新（`git pull --ff-only`）。 */
  gitPull(): Promise<GitPullResult>
  pickDirectory(): Promise<string | null>
  /**
   * 切到某个会话：主进程还留着它的 host（多半是后台回合还在跑）就直接挂回、不重启，否则起一个
   * 新 host（必要时 `--resume` 回放历史）。
   */
  attach(request: AttachRequest): Promise<AttachResult>
  /** 让 host 重新扫描落盘会话（结果以 `workspace` 事件回来）。 */
  refreshSessions(): Promise<void>
  /**
   * 让当前会话重放一次历史（结果以 `history` 事件回来）；界面重载后视图是空的而内核还活着，
   * 重放就能把内容补回来，后台还在跑的回合不受影响。
   */
  replayHistory(): Promise<void>
  /** 用系统默认程序打开一个文件；返回错误信息（成功时空串）。 */
  openPath(path: string): Promise<string>
  /** 读文件给右侧预览面板（主进程按扩展名判断类型并有体积上限）。 */
  previewRead(path: string): Promise<PreviewPayload>
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
    readonly Memento?: AgentApi
  }
}

/**
 * 会话级 token 累计。内核的计数是互斥的（见 `host/protocol.ts` 的 `LlmUsage`）：`inputTokens`
 * 只算未命中缓存的输入，命中部分在 `cacheReadTokens`、写缓存在 `cacheWriteTokens`。
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

/** 缓存命中率 `0..1`；还没有任何输入 token 时返回 `null`（界面显示 `—`，不伪造 0%）。 */
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
 * 从工具调用里认出「这是个文件操作」，供界面渲染文件卡片；认不出来返回 undefined，界面退回
 * 普通工具行。参数摘要是 `summarizeCall` 生成的一行文本，取第一个路径片段当路径。
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
  /** 展开后显示的完整文本：工具步骤是完整输出，其余步骤是正文 / 推理 / 提示原文。 */
  readonly detail: string
  /** 行内一行预览（工具=输出首行，其余=正文首行）—— 折叠时看的就是它。 */
  readonly preview: string
  /** 工具步骤的参数摘要（chip 里显示整条命令 / 路径），其余步骤为空串。 */
  readonly token: string
  /** 这一步是否失败（结果带错误）。 */
  readonly isError: boolean
}

/**
 * 把会话条目摊平成「轨迹」——按发生顺序列出 agent 做过的每一步，纯函数。工具步骤的 `detail` 直接
 * 引用 `block.output` 而不复制：流式正文每来一个 delta 都会重算这条列表，拼一遍就是几十 KB 的复制。
 */
export function traceSteps(items: readonly Item[]): TraceStep[] {
  const steps: TraceStep[] = []
  /** 通用步骤（非工具）：正文即明细，首行即预览。 */
  const plain = (
    id: string,
    kind: TraceStep['kind'],
    label: string,
    text: string,
    isError = false,
  ): void => {
    steps.push({ id, kind, label, detail: text, preview: firstLine(text), token: '', isError })
  }
  for (const item of items) {
    if (item.kind === 'user') {
      plain(item.id, 'user', '用户', item.text)
      continue
    }
    if (item.kind === 'note') {
      plain(item.id, 'note', `提示(${item.level})`, item.text, item.level === 'error')
      continue
    }
    if (item.kind === 'steer') {
      plain(item.id, 'steer', '目标调整', item.text)
      continue
    }
    // 推理已经作为 `blocks` 里的一块，跟着下面的循环按真实顺序出现（想一段 → 做一步 → 再想一段）。
    item.blocks.forEach((block, index) => {
      if (block.type === 'reasoning') {
        plain(`${item.id}-r${String(index)}`, 'reasoning', '推理', block.text)
        return
      }
      if (block.type === 'text') {
        plain(`${item.id}-t${String(index)}`, 'text', '回复', block.text)
        return
      }
      const output = (block.output ?? '').trim()
      const detail = block.result === null ? '（运行中…）' : (output === '' ? block.result : output)
      steps.push({
        id: `${item.id}-c${String(index)}`,
        kind: 'tool',
        label: block.name,
        detail,
        preview: block.result === null ? '运行中…' : firstLine(detail),
        token: block.args,
        isError: block.isError,
      })
    })
    if (item.meta !== null && item.meta.outcome !== 'completed') {
      plain(`${item.id}-m`, 'note', '结束', item.meta.error ?? item.meta.outcome, item.meta.outcome === 'error')
    }
  }
  return steps
}

// ─────────────────────────────────────────────────────────────────────────────
// 右侧刻度滑杆 / 预览面板要的派生数据
// ─────────────────────────────────────────────────────────────────────────────

/** 滑杆上的一个刻度：对应会话里的一条条目。 */
export interface RailMark {
  /** 条目 id（与消息行上的 `data-item-id` 一致，点击时用它找 DOM）。 */
  readonly id: string
  /** 角色类别，决定刻度颜色。 */
  readonly kind: 'user' | 'assistant' | 'note' | 'steer'
  /** 角标文字（「你」/「助手」…）。 */
  readonly role: string
  /** 截断后的摘要，hover 时展示。 */
  readonly summary: string
  /** 这一条里有多少次工具调用（>0 时角标里带上）。 */
  readonly tools: number
  /** 是否还没跑完（角标显示「运行中」）。 */
  readonly running: boolean
}

/** 摘要截断长度：hooks 提示框最多显示这么多字（CSS 还会再按行数收敛一次）。 */
const RAIL_SUMMARY_MAX = 140

/**
 * 把会话文本压成滑杆刻度用的一行摘要：换行与连续空格压成单空格，超过 `RAIL_SUMMARY_MAX` 截断。
 */
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > RAIL_SUMMARY_MAX ? `${flat.slice(0, RAIL_SUMMARY_MAX)}…` : flat
}

/**
 * 由会话条目算出滑杆刻度 —— 一条条目一个刻度（助手消息整条算一个），顺序与消息流一致。几何信息
 * 不在这里算：位置得问真实 DOM（见 `message-rail.tsx`），这里只管「有哪些刻度」。
 */
export function railMarks(items: readonly Item[]): RailMark[] {
  return items.map((item): RailMark => {
    if (item.kind === 'user') {
      return { id: item.id, kind: 'user', role: '你', summary: summarize(item.text), tools: 0, running: false }
    }
    if (item.kind === 'note') {
      return { id: item.id, kind: 'note', role: '提示', summary: summarize(item.text), tools: 0, running: false }
    }
    if (item.kind === 'steer') {
      return { id: item.id, kind: 'steer', role: '目标调整', summary: summarize(item.text), tools: 0, running: false }
    }
    const texts = item.blocks.filter((block) => block.type === 'text').map((block) => block.text)
    const tools = item.blocks.filter((block) => block.type === 'tool').length
    const body = texts.length > 0 ? texts.join(' ') : item.reasoning
    return {
      id: item.id,
      kind: 'assistant',
      role: '助手',
      summary: summarize(body === '' ? `${String(tools)} 次工具调用` : body),
      tools,
      running: item.meta === null,
    }
  })
}

/** 会话里出现过的一个文件（预览面板的「最近文件」列表）。 */
export interface RecentFile {
  /** 路径（可能是相对的，预览时由主进程按工作目录解析）。 */
  readonly path: string
  /** 最后一次操作（读取 / 写入 / 修改）。 */
  readonly action: string
  /** 最后一次出现的条目 id，用作 React key。 */
  readonly id: string
}

/**
 * 从会话条目里倒着捞「碰过的文件」，按最近使用排序、同一路径只留最新一次（最关心的是刚生成的那
 * 份报告 / 脚本）。认文件靠 `fileActionOf()`，认不出不进列表。
 */
export function recentFiles(items: readonly Item[], limit = 40): RecentFile[] {
  const seen = new Set<string>()
  const files: RecentFile[] = []
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item === undefined || item.kind !== 'assistant') continue
    for (let j = item.blocks.length - 1; j >= 0; j -= 1) {
      const block = item.blocks[j]
      if (block === undefined || block.type !== 'tool') continue
      const file = fileActionOf(block.name, block.args)
      if (file === undefined || seen.has(file.path)) continue
      seen.add(file.path)
      files.push({ path: file.path, action: file.action, id: `${item.id}-${block.callId === '' ? String(j) : block.callId}` })
      if (files.length >= limit) return files
    }
  }
  return files
}

/**
 * 一个会话视图的状态。界面按会话分开存：后台会话还在跑，它的流式增量要落进它自己那一份，不能
 * 串进前台（见 `locate`）；切会话就是换一个视图，切走再切回来看到的还是原来那份。
 */
export interface SessionView {
  /** 视图键（`sessionKey(cwd, sessionId)`）。 */
  readonly key: string
  /** 会话所属项目根目录。 */
  readonly cwd: string
  readonly phase: 'booting' | 'ready' | 'error'
  readonly error: string | null
  readonly info: HostReadyInfo | null
  readonly items: readonly Item[]
  readonly busy: boolean
  /**
   * 正在换会话 / 换项目 / 重启内核，此时界面仍显示旧内容。不直接把 `phase` 打回 `booting`：
   * 旧内容只在 `history` 帧到达时整段替换；这个标记同时用来挡掉切换期间的提交。
   */
  readonly switching: boolean
  /** 本会话的 token 累计。 */
  readonly usage: UsageTotals
  /** 该 provider 申报的可选模型（来自内核，不是界面写死的）。 */
  readonly models: readonly ModelInfo[]
  /** 上一回合的墙钟耗时（毫秒）；还没跑过为 null。 */
  readonly lastTurnMs: number | null
  /** 本会话已完成的回合数。 */
  readonly turns: number
}

/**
 * 界面状态 = 当前会话的视图 + 全局部分（项目清单 / `#` 候选 / 设置）。组件只读这一份，于是
 * 「多会话」对组件是透明的：`state.items` 永远就是当前会话的内容。
 */
export interface AgentState extends SessionView {
  /** 当前视图的键；还没有任何会话时是空串。 */
  readonly activeKey: string
  /**
   * 已经建立过视图的会话键：切会话时用它决定「挂回」还是「重启」——只有见过的会话才谈得上
   * 挂回主进程里还留着的 host（见 `resumeSession` 的 `reuse`）。
   */
  readonly knownViews: readonly string[]
  /** 有回合在跑的会话 id（后台也算）—— 侧栏给这些行打运行标记。 */
  readonly runningIds: readonly string[]
  /** 所有出现过的项目（当前项目排在最前）。 */
  readonly projects: readonly ProjectSummary[]
  /** 当前项目的会话，按最近活动倒序。 */
  readonly sessions: readonly SessionSummary[]
  /**
   * 非当前项目已加载的会话明细（项目路径 → 会话列表）：只装「被点开过」的项目，折叠的项目
   * 展开时才向 host 要数据（`project-sessions` 事件），项目再多也不拖慢首屏。
   */
  readonly projectSessions: Readonly<Record<string, readonly SessionSummary[]>>
  /** 正在读取会话的项目路径（界面据此显示「读取中…」）；没有则是 null。 */
  readonly loadingProject: string | null
  /** `#` 菜单的候选文件（响应 `files` 帧）。 */
  readonly files: readonly FileBrief[]
  /** 上面这批候选对应的查询串（界面据此丢弃过期结果）。 */
  readonly filesQuery: string
  /** 设置界面的数据；没打开过设置面板时为 null。 */
  readonly settings: SettingsData | null
  /** 正在等 host 回 `settings` 帧。 */
  readonly settingsBusy: boolean
  /** 当前工作目录的 git 情况；null = 还没探测到或探测失败。 */
  readonly git: GitRead | null
  /** 正在探测 git / 正在切分支。 */
  readonly gitBusy: boolean
}

/**
 * 一次 git 探测的结果以及它探测的是哪个目录。git 状态是目录的属性，而界面随时可能切到另一个
 * 会话（另一个项目），带上 `cwd` 才能在「探测的目录 === 当前会话的目录」时才显示分支。
 */
export interface GitRead {
  /** 这次探测针对的工作目录。 */
  readonly cwd: string
  readonly status: GitStatus
}

/**
 * 一次 git 动作（切分支 / 拉取）的结果，已经压成「界面要显示的一句话」：`GitSwitchResult` 只有
 * `error`、`GitPullResult` 还有 `message`，界面只关心「说什么、是不是坏消息」；空串表示没什么可说。
 */
export interface GitActionResult {
  /** 动作是否成功。决定那句话说出来的语气（普通 / 错误色）。 */
  readonly ok: boolean
  /** 要显示的话；没什么可说时是空串。 */
  readonly message: string
}

/**
 * 归约器的内部状态：视图表 + 全局部分。这里要留下完整的那张表，而不是直接投影成
 * `AgentState` —— 后台会话的视图不能因为不是当前会话就被丢掉，否则切回去只剩历史回放。
 */
interface Store {
  readonly activeKey: string
  readonly views: Readonly<Record<string, SessionView>>
  readonly projects: readonly ProjectSummary[]
  readonly sessions: readonly SessionSummary[]
  readonly projectSessions: Readonly<Record<string, readonly SessionSummary[]>>
  readonly loadingProject: string | null
  readonly files: readonly FileBrief[]
  readonly filesQuery: string
  readonly settings: SettingsData | null
  readonly settingsBusy: boolean
  readonly git: GitRead | null
  readonly gitBusy: boolean
}

/** 归约动作：来自 host 的事件，或界面自己的动作。 */
export type Action =
  | AgentEvent
  /** 换前台会话（只挪视角，数据不动）。 */
  | { readonly type: 'activate'; readonly key: string; readonly cwd: string }
  /** 直接挂回了活着的 host：视图本来就是最新的。 */
  | { readonly type: 'attached'; readonly key: string }
  | { readonly type: 'user-send'; readonly text: string }
  | { readonly type: 'adopt-turn'; readonly turnId: string }
  | { readonly type: 'user-error'; readonly message: string }
  | { readonly type: 'project-sessions-loading'; readonly path: string }
  | { readonly type: 'project-sessions-error'; readonly path: string; readonly message: string }
  | { readonly type: 'settings-loading' }
  | { readonly type: 'steer-send'; readonly text: string }
  /** 开始探测 git（面包屑转一下「读取中」）。 */
  | { readonly type: 'git-loading' }
  /** git 探测回来了；`cwd` 是它探测的那个目录。 */
  | { readonly type: 'git-status'; readonly cwd: string; readonly status: GitStatus }
  /** git 探测失败（主进程不可用之类）：把分支段收起来。 */
  | { readonly type: 'git-failed' }

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数工具
// ─────────────────────────────────────────────────────────────────────────────

/** 空视图（还没见过 / 还没就绪的会话）。 */
function emptyView(key: string, cwd: string): SessionView {
  return {
    key,
    cwd,
    phase: 'booting',
    error: null,
    info: null,
    items: [],
    busy: false,
    switching: false,
    usage: emptyUsage,
    models: [],
    lastTurnMs: null,
    turns: 0,
  }
}

/** 归约器的初始状态：一张空的视图表。 */
export const initialState: Store = {
  activeKey: '',
  views: {},
  projects: [],
  sessions: [],
  projectSessions: {},
  loadingProject: null,
  files: [],
  filesQuery: '',
  settings: null,
  settingsBusy: false,
  git: null,
  gitBusy: false,
}

/**
 * 一帧该落到哪个会话：`hostId` 由主进程打在每一帧上（见 `ipc.ts` 的 `BridgeEvent`），界面自己的
 * 动作没有它、落到当前会话；视图不存在就先建一个空视图（冷启动的第一帧就是这样进来的）。
 */
function locate(state: Store, hostId: string | undefined, cwd?: string): { key: string; view: SessionView } {
  const key = hostId ?? state.activeKey
  const existing = state.views[key]
  return existing === undefined ? { key, view: emptyView(key, cwd ?? '') } : { key, view: existing }
}

/** 写回一个视图；顺手在「还没有当前会话」时把它设为当前（冷启动第一帧）。 */
function put(state: Store, key: string, view: SessionView): Store {
  return {
    ...state,
    activeKey: state.activeKey === '' ? key : state.activeKey,
    views: { ...state.views, [key]: view },
  }
}

/** 给某个会话的旧视图算新视图再写回；算出来还是同一个对象就原样返回。 */
function withView(state: Store, key: string, update: (view: SessionView) => SessionView): Store {
  const view = locate(state, key).view
  const next = update(view)
  return next === view ? state : put(state, key, next)
}

/**
 * 按界面自己的当前会话重写列表里的 `current` 标记：多个 host 各自把「它自己」标成 current，帧上
 * 的值不可信，而挂回一个还活着的会话又不会来新的 `workspace` 帧，标记一律在投影时现算。
 */
function markCurrent(
  sessions: readonly SessionSummary[],
  currentId: string | null,
): readonly SessionSummary[] {
  if (currentId === null) return sessions
  let changed = false
  const next = sessions.map((session) => {
    const want = session.id === currentId
    if (session.current === want) return session
    changed = true
    return { ...session, current: want }
  })
  return changed ? next : sessions
}

/** 同上，作用于「当前项目」那一列（当前项目 = 当前视图的 cwd）。 */
function markCurrentProject(
  projects: readonly ProjectSummary[],
  currentCwd: string,
): readonly ProjectSummary[] {
  if (currentCwd === '') return projects
  let changed = false
  const next = projects.map((project) => {
    const want = project.path === currentCwd
    if (project.current === want) return project
    changed = true
    return { ...project, current: want }
  })
  return changed ? next : projects
}

/**
 * 把内部状态投影成组件读的那一份（当前会话的视图摊平 + 全局部分）。导出是给冒烟脚本用的：
 * `current` 标记这类「看起来该是状态、其实是视图」的东西都在这里现算，得能单独验。
 */
export function project(store: Store): AgentState {
  const view = store.views[store.activeKey] ?? emptyView(store.activeKey, '')
  const currentId = view.info?.sessionId ?? null
  const runningIds: string[] = []
  for (const item of Object.values(store.views)) {
    const id = item.info?.sessionId
    if (item.busy && id !== undefined && !runningIds.includes(id)) runningIds.push(id)
  }
  const projectSessions: Record<string, readonly SessionSummary[]> = {}
  for (const [path, list] of Object.entries(store.projectSessions)) {
    projectSessions[path] = markCurrent(list, currentId)
  }
  return {
    ...view,
    activeKey: store.activeKey,
    knownViews: Object.keys(store.views),
    runningIds,
    // `current` 标记在这里现算：切到一个还活着的会话不会来新的 `workspace` 帧，
    // 只靠帧上的标记会让侧栏一直高亮着上一个会话（见 `markCurrent`）。
    projects: markCurrentProject(store.projects, view.cwd),
    sessions: markCurrent(store.sessions, currentId),
    projectSessions,
    loadingProject: store.loadingProject,
    files: store.files,
    filesQuery: store.filesQuery,
    settings: store.settings,
    settingsBusy: store.settingsBusy,
    git: store.git,
    gitBusy: store.gitBusy,
  }
}

/** 生成条目 id（渲染列表的 key）。 */
function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`
}

/** 取当前正在流式渲染的助手条目；turnId 为 null 表示「还没拿到 id，先认领」。 */
function activeAssistant(items: readonly Item[], turnId: string | null): number {
  // 从后往前找最后一条助手条目，而不是只看最后一项：回合进行中用户可以「中途调整目标」，那会在
  // 助手条目后面追加一条 steer 条目，只看末项会让后续增量找不到正在写的那条消息、把回复拆成两个气泡。
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined || item.kind !== 'assistant') continue
    if (item.turnId === null || item.turnId === turnId) return index
    // 最近的一条助手条目属于别的回合：到此为止，不往前找（那是历史）。
    return -1
  }
  return -1
}

/** 取助手条目；不是助手返回 null（用于类型收窄）。 */
function asAssistant(item: Item | undefined): AssistantItem | null {
  return item !== undefined && item.kind === 'assistant' ? item : null
}

/**
 * 取当前助手条目，没有就补一个：正常情况下它一定存在（`user-send` 先建好占位），但界面重载或
 * `getState()` 与事件竞态时可能先收到流式帧，这时宁可多一条消息，也不能丢内容。
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

/**
 * 追加一段推理增量到「最后一个推理块」，没有就新起一块 —— 中间夹了正文或工具调用之后，末尾就不是
 * 推理块，下一段推理自然成为新的一块，排在它真实发生的位置上。
 */
function appendReasoning(blocks: readonly Block[], delta: string): Block[] {
  const tail = blocks[blocks.length - 1]
  if (tail !== undefined && tail.type === 'reasoning') {
    return [...blocks.slice(0, -1), { ...tail, text: tail.text + delta }]
  }
  return [...blocks, { type: 'reasoning', text: delta }]
}

/** 替换第 index 条。 */
function replaceItem(items: readonly Item[], index: number, next: Item): Item[] {
  return [...items.slice(0, index), next, ...items.slice(index + 1)]
}

// ─────────────────────────────────────────────────────────────────────────────
// 归约器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归约器：事件与界面动作 → 新状态。每个 host 帧带着 `hostId`，归约到对应会话的视图上（见
 * `locate`），当前会话只是「正在看的那个视图」，于是后台会话的增量落进它自己那份。
 */
export function reducer(state: Store, action: Action): Store {
  switch (action.type) {
    // ── 会话视图的定位 ────────────────────────────────────────────────
    /**
     * 换前台会话：只挪视角，不动任何数据。`switching` 先置上（目标可能是没见过 / 已被回收的
     * 会话，要等新内核回放历史）；若主进程回的是「挂回活着的 host」，`attached` 会立刻放开它。
     */
    case 'activate': {
      const view = state.views[action.key] ?? emptyView(action.key, action.cwd)
      return {
        ...state,
        activeKey: action.key,
        views: { ...state.views, [action.key]: { ...view, cwd: action.cwd, switching: true } },
      }
    }

    /** 挂回了活着的 host：视图一直是实时更新的，放开切换标记即可。 */
    case 'attached':
      return withView(state, action.key, (view) => ({ ...view, switching: false }))

    // ── 内核生命周期 ──────────────────────────────────────────────────
    case 'ready': {
      const info = action.info
      const from = action.hostId ?? state.activeKey
      const { view } = locate(state, from, info.cwd)
      /**
       * 新建会话：真正的会话 id 在 `ready` 里才给出，占位键（`cwd\n`）在这里换成带 id 的键，主进程
       * 同时也在改名。不换的话切走再切回来会另起一个 host，两个内核写同一份会话日志。
       */
      const key = sessionKey(info.cwd, info.sessionId)
      const views: Record<string, SessionView> = {
        ...state.views,
        [key]: {
          ...view,
          key,
          cwd: info.cwd,
          phase: 'ready',
          error: null,
          info,
          busy: false,
          switching: false,
          models: info.models ?? [],
        },
      }
      if (from !== key) delete views[from]
      return {
        ...state,
        activeKey: state.activeKey === '' || state.activeKey === from ? key : state.activeKey,
        views,
      }
    }

    /**
     * 换会话 / 换项目 / 重启内核：什么都不清，只打 `switching` 标记，内容等 `history` 帧整段替换。
     * 清空的话点一下侧栏会连着抖四下（消息区白掉、token 统计归零、模型下拉变空、会话列表变「读取中…」）。
     */
    case 'restarting': {
      const { key } = locate(state, action.hostId, action.cwd)
      return withView(state, key, (view) => ({
        ...view,
        cwd: action.cwd,
        switching: true,
        // 回合状态要清：内核正在被杀 / 换，那一轮不可能再继续（内容由历史帧接管）。
        busy: false,
      }))
    }

    /** 切换超时兜底：宁可放开标记（顶多显示旧内容），也别把界面永远锁在「正在切换」。 */
    case 'switch-timeout':
      return state.activeKey === ''
        ? state
        : withView(state, state.activeKey, (view) => ({ ...view, switching: false }))

    /**
     * 项目与会话清单原样存下来，里面的 `current` 标记以投影时现算的为准（见 `markCurrent`）：
     * 多个 host 都会推这一帧、各自把「它自己」标成 current，帧上的值不可信。
     */
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
     * 中途调整目标：本地先把这条记进会话，再让 host 转交给内核的 `steer`。不像 `user-send` 那样
     * 建助手占位：纠偏不开启新回合，凭空插一个占位会把正在写的那条消息的增量引到新气泡上。
     */
    case 'steer-send':
      return withView(state, state.activeKey, (view) => ({
        ...view,
        items: [...view.items, { id: newId(), kind: 'steer', text: action.text }],
      }))

    /**
     * 历史回放（host 每次就绪后一定会发一帧，新建会话发的是空历史）。这一帧也是「切换结束」的
     * 信号：`ready` 先到、历史后到，若在 `ready` 就放开 `switching`，用户此时发的消息会被覆盖。
     */
    case 'history':
      return withView(state, action.hostId ?? state.activeKey, (view) => ({
        ...view,
        switching: false,
        items: action.items,
        usage: { ...emptyUsage, ...action.usage, last: null },
        turns: action.turns,
        // 耗时是「上一回合」的量，历史里没有记录 → 保持未知，不伪造。
        lastTurnMs: null,
      }))

    /** 某个折叠项目的会话明细到了（也可能是「读不到」的空结果）。 */
    case 'project-sessions':
      return {
        ...state,
        loadingProject: state.loadingProject === action.path ? null : state.loadingProject,
        projectSessions: { ...state.projectSessions, [action.path]: action.sessions },
      }

    case 'usage':
      return withView(state, action.hostId ?? state.activeKey, (view) => ({
        ...view,
        usage: accumulate(view.usage, action.usage),
      }))

    case 'host-error':
    case 'fatal':
      return withView(state, action.hostId ?? state.activeKey, (view) => ({
        ...view,
        phase: 'error',
        error: action.message,
        busy: false,
        items: [...view.items, { id: newId(), kind: 'note', level: 'error', text: action.message }],
      }))

    case 'notice':
      // 子进程输出不可信：主进程只做了浅校验，这里补齐缺省值。
      return withView(state, action.hostId ?? state.activeKey, (view) => ({
        ...view,
        items: [...view.items, { id: newId(), kind: 'note', level: action.level ?? 'info', text: action.message }],
      }))

    case 'model-changed':
      return withView(state, action.hostId ?? state.activeKey, (view) => ({
        ...view,
        info: view.info === null ? null : { ...view.info, model: action.model },
      }))

    /** 推理强度已切换（下一次请求生效）—— 与 `model-changed` 同一条路。 */
    case 'effort-changed':
      return withView(state, action.hostId ?? state.activeKey, (view) => ({
        ...view,
        info: view.info === null ? null : { ...view.info, effort: action.effort },
      }))

    // ── 本地动作：用户点了发送 ────────────────────────────────────────
    case 'user-send':
      return withView(state, state.activeKey, (view) => ({
        ...view,
        busy: true,
        items: [
          ...view.items,
          { id: newId(), kind: 'user', text: action.text },
          // 先建好助手条目再发请求：首个流式帧可能比 invoke 的响应先到。
          { id: newId(), kind: 'assistant', turnId: null, reasoning: '', blocks: [], meta: null },
        ],
      }))

    /** 助手占位条目认领主进程返回的 turnId。 */
    case 'adopt-turn':
      return withView(state, state.activeKey, (view) => {
        const index = activeAssistant(view.items, null)
        const current = asAssistant(view.items[index])
        if (current === null || current.turnId !== null) return view
        return { ...view, items: replaceItem(view.items, index, { ...current, turnId: action.turnId }) }
      })

    // ── 流式增量（按帧上的会话键分发：后台会话的增量落在它自己那条上）──
    case 'text-delta':
      return withView(state, action.hostId ?? state.activeKey, (view) => {
        const [items, index] = ensureAssistant(view.items, action.turnId)
        const current = asAssistant(items[index])
        if (current === null) return view
        const next: AssistantItem = { ...current, blocks: appendText(current.blocks, action.text) }
        return { ...view, items: replaceItem(items, index, next) }
      })

    case 'reasoning-delta':
      return withView(state, action.hostId ?? state.activeKey, (view) => {
        const [items, index] = ensureAssistant(view.items, action.turnId)
        const current = asAssistant(items[index])
        if (current === null) return view
        /**
         * `blocks` 里按位置存（界面渲染用，见 `appendReasoning`），`reasoning` 是整回合的拼接
         * （刻度尺提示框、轨迹兜底用）：只留后者就会退回「所有思考堆在消息最上方」的样子。
         */
        const next: AssistantItem = {
          ...current,
          reasoning: current.reasoning + action.text,
          blocks: appendReasoning(current.blocks, action.text),
        }
        return { ...view, items: replaceItem(items, index, next) }
      })

    // ── 工具调用 ──────────────────────────────────────────────────────
    case 'tool-call':
      return withView(state, action.hostId ?? state.activeKey, (view) => {
        const [items, index] = ensureAssistant(view.items, action.turnId)
        const current = asAssistant(items[index])
        if (current === null) return view
        const block: ToolBlock = {
          type: 'tool',
          callId: action.callId,
          name: action.name,
          args: action.summary,
          result: null,
          output: null,
          isError: false,
        }
        return { ...view, items: replaceItem(items, index, { ...current, blocks: [...current.blocks, block] }) }
      })

    case 'tool-result':
      return withView(state, action.hostId ?? state.activeKey, (view) => {
        const [items, index] = ensureAssistant(view.items, action.turnId)
        const current = asAssistant(items[index])
        if (current === null) return view
        let matched = false
        const blocks: Block[] = current.blocks.map((block) => {
          if (block.type !== 'tool' || block.callId !== action.callId) return block
          matched = true
          // 摘要给折叠行、`output` 给展开明细：两个都收，点开就有完整内容。
          return { ...block, result: action.summary, output: action.output, isError: action.isError === true }
        })
        // 结果先于调用到达（或缺了调用帧）：补一张卡片，信息别丢。
        if (!matched) {
          blocks.push({
            type: 'tool',
            callId: action.callId,
            name: action.name,
            args: '',
            result: action.summary,
            output: action.output,
            isError: action.isError === true,
          })
        }
        return { ...view, items: replaceItem(items, index, { ...current, blocks }) }
      })

    // ── 回合收尾（后台会话的收尾也走这里，所以按帧上的会话键分发）────
    case 'turn-end':
      return withView(state, action.hostId ?? state.activeKey, (view) => {
        const next: SessionView = { ...view, busy: false }
        const index = activeAssistant(view.items, action.turnId)
        const current = asAssistant(view.items[index])
        if (current === null) return next
        // 流式增量是正文的权威来源；真丢了帧才用 turn-end 的汇总补。
        const fallbackText = action.text ?? ''
        const blocks: readonly Block[] = current.blocks.length === 0 && fallbackText !== ''
          ? [{ type: 'text', text: fallbackText }]
          : current.blocks
        const meta: TurnMeta = { outcome: action.outcome, error: action.error, toolCalls: action.toolCalls ?? 0 }
        return {
          ...next,
          items: replaceItem(view.items, index, { ...current, blocks, meta }),
          // 统计条用的「上一轮耗时 / 已完成轮次」
          lastTurnMs: action.durationMs ?? null,
          turns: view.turns + 1,
        }
      })

    case 'user-error':
      return withView(state, state.activeKey, (view) => ({
        ...view,
        busy: false,
        items: [...view.items, { id: newId(), kind: 'note', level: 'error', text: action.message }],
      }))

    // ── 本地动作：展开一个折叠的项目 ──────────────────────────────────
    /** 开始读：标记「读取中」，界面此刻显示占位而不是空列表。 */
    case 'project-sessions-loading':
      return { ...state, loadingProject: action.path }

    case 'project-sessions-error': {
      const cleared: Store = {
        ...state,
        loadingProject: state.loadingProject === action.path ? null : state.loadingProject,
      }
      return withView(cleared, state.activeKey, (view) => ({
        ...view,
        items: [...view.items, { id: newId(), kind: 'note', level: 'warn', text: action.message }],
      }))
    }

    // ── git（面包屑的分支段）：与 host 无关，主进程直接给结果 ────────────
    case 'git-loading':
      return { ...state, gitBusy: true }

    case 'git-status':
      return { ...state, gitBusy: false, git: { cwd: action.cwd, status: action.status } }

    case 'git-failed':
      // 拿不到就什么都不显示：面包屑只画路径，分支段不出现。
      return { ...state, gitBusy: false, git: null }

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
  /** 运行中切换推理强度（`low | high | max`）：下一次请求生效。 */
  readonly setEffort: (effort: string) => Promise<void> | undefined
  /** 重新探测一次当前会话工作目录的 git 情况（面包屑打开菜单时也调它）。 */
  readonly loadGit: () => Promise<void>
  /** 切分支；失败时 `message` 是 git 的原话。 */
  readonly switchBranch: (branch: string) => Promise<GitActionResult>
  /** 拉取当前分支的最新提交；成功时 `message` 是 git 的结论（「Already up to date.」/ diffstat）。 */
  readonly pullBranch: () => Promise<GitActionResult>
  /** 在当前项目里开一个新会话（别的会话照跑）。 */
  readonly newSession: () => Promise<void>
  /** 恢复一个已落盘的会话；`cwd` 省略表示当前项目。 */
  readonly resumeSession: (sessionId: string, cwd?: string) => Promise<void>
  /** 切到另一个项目：在新工作目录里开一个新会话。 */
  readonly openProject: (path: string) => Promise<void>
  /** 读一个折叠项目的会话明细（结果以 `project-sessions` 事件回来）。 */
  readonly loadProjectSessions: (path: string) => Promise<void>
  /** 用系统默认程序打开一个文件（文件卡片的「打开」按钮）。 */
  readonly openPath: (path: string) => Promise<void>
  /** 右侧预览面板读文件：按扩展名判断渲染类型，把内容（图片是 data URL）带回来。 */
  readonly previewRead: (path: string) => Promise<PreviewPayload>
  /** 用当前配置重启当前会话的内核：MCP 服务器是启动时挂的，改完 `mcp.json` 要用它生效。 */
  readonly restartKernel: () => Promise<void>
  /**
   * 中途调整目标：把这段话插给正在跑的回合。用内核的 `steer` 而不是再发一个 `prompt` —— 后者是
   * 排队（等这轮跑完才轮到它），而调整目标要立刻改方向，内核在下一个 step 边界消费它。
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
 * 把主进程的事件接进 React：先订阅再 `getState()`，两条腿走，这样无论内核在界面订阅之前还是
 * 之后就绪，都不会漏掉 `ready`。状态按会话分开存在 `Store.views`，对组件只暴露当前会话那一份。
 */
export function useAgent(): AgentController {
  const [store, dispatch] = useReducer(reducer, initialState)
  /** 组件读的那一份：当前会话的视图摊平 + 全局部分。 */
  const state = project(store)
  /** 事件回调放在 ref 里，避免订阅在每次渲染时重建。 */
  const dispatchRef = useRef<Dispatch<Action>>(dispatch)
  dispatchRef.current = dispatch

  /** 内部状态的最新快照（启动自愈要判断「这个会话的视图是不是已经有内容了」）。 */
  const storeRef = useRef<Store>(store)
  storeRef.current = store

  /**
   * 最新状态的 ref：切会话的动作要用它读现在的场景（当前在哪个会话、忙不忙、目标键有没有视图），
   * 而不是被 `useCallback` 的依赖钉在过去那一帧 —— 钉住的后果是把后台还在跑的会话当空闲切掉。
   */
  const stateRef = useRef<AgentState>(state)
  stateRef.current = state

  /**
   * 切换会话的兜底：`switching` 正常由 `history` 帧解除，万一那一帧永远不来（host 崩了 /
   * 读日志卡住），3 秒后自己放开 —— 顶多显示着旧内容，比把界面锁死在「正在切换」上要好。
   */
  useEffect(() => {
    if (!state.switching) return undefined
    const timer = setTimeout(() => { dispatch({ type: 'switch-timeout' }) }, 3000)
    return () => { clearTimeout(timer) }
  }, [state.switching])

  useEffect(() => {
    const api = globalThis.window?.Memento
    if (api === undefined) {
      dispatch({ type: 'notice', level: 'error', message: 'window.Memento 不存在：preload 没有加载。' })
      return undefined
    }

    // host 事件与主进程自产事件共用一条通道，形状由协议保证（每一帧都带 hostId）。
    const off = api.onEvent((event) => { dispatchRef.current(event) })

    // 清单主动拉一次：首帧推送被丢掉时靠它补上（host 会重新扫盘）。这是启动自愈，不对外导出 ——
    // 没有它，首帧一旦丢掉侧栏就永远是空的。
    void api.refreshSessions().catch(() => { /* 拿不到就等下一次推送 */ })

    api.getState().then(
      (current) => {
        if (current.workspace !== undefined) {
          dispatchRef.current({ type: 'workspace', ...current.workspace })
        }
        if (current.phase === 'ready' && current.info !== undefined) {
          // 界面比内核晚到（重载，或 bundle 解析得比内核启动还慢）：视图是空的，但 host 还活着。
          // 这里不重启（会杀掉还在跑的回合），挂回它并重放一次历史；挂不上就走正常的启动路径。
          const key = current.activeKey ?? sessionKey(current.info.cwd, current.info.sessionId)
          dispatchRef.current({ type: 'ready', info: current.info, hostId: key })
          void api.attach({ cwd: current.info.cwd, resume: current.info.sessionId, reuse: true }).then(
            (result) => {
              if (!result.attached) return
              dispatchRef.current({ type: 'attached', key: result.key })
              // 只在视图还是空的时候补历史：界面若比内核先到（实时帧已经在收），回放会用盘上的
              // 旧内容盖掉刚收到的流式正文。
              if ((storeRef.current.views[result.key]?.items.length ?? 0) === 0) {
                void api.replayHistory()
              }
            },
            () => { /* 挂不上就等用户点一个会话 */ },
          )
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

  const api = globalThis.window?.Memento

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

  /** 右侧预览面板读文件（`openPath` 的「读回内容」版本）。 */
  const previewRead = useCallback(async (path: string): Promise<PreviewPayload> => {
    if (api === undefined) return { ok: false, path, kind: 'binary', error: 'window.Memento 不可用' }
    return await api.previewRead(path)
  }, [api])

  const cancel = useCallback(() => api?.cancel(), [api])
  const setModel = useCallback((model: string) => api?.setModel(model), [api])
  const setEffort = useCallback((effort: string) => api?.setEffort(effort), [api])

  /**
   * 探测一次当前会话工作目录的 git 情况。目录取「内核报的 cwd」优先、退回视图上记的 cwd：前者是
   * 权威值（`--cwd` 解析后的绝对路径），后者在新会话还没就绪时是唯一的线索。
   */
  const loadGit = useCallback(async (): Promise<void> => {
    const current = stateRef.current
    const cwd = current.info?.cwd ?? current.cwd
    if (api === undefined || cwd === '') return
    dispatch({ type: 'git-loading' })
    try {
      const status = await api.gitStatus()
      dispatch({ type: 'git-status', cwd, status })
    } catch {
      // 主进程不可用 / IPC 断了：不显示分支段，也不打断用户（这是装饰性信息）。
      dispatch({ type: 'git-failed' })
    }
  }, [api])

  /**
   * 切分支。目标分支来自面包屑菜单里的列表，主进程还会再校验一遍白名单；成功时 `message` 为空，
   * 因为界面上的分支名自己就变了、不用再说一句。
   */
  const switchBranch = useCallback(async (branch: string): Promise<GitActionResult> => {
    const current = stateRef.current
    const cwd = current.info?.cwd ?? current.cwd
    if (api === undefined || cwd === '') return { ok: false, message: '还没有可用的工作目录' }
    dispatch({ type: 'git-loading' })
    try {
      const result = await api.gitSwitch(branch)
      // 无论成功失败都吃下最新状态：切换失败（工作区脏）时分支没变，
      // 但界面得知道自己还停在哪儿。
      dispatch({ type: 'git-status', cwd, status: result.status })
      return result.ok
        ? { ok: true, message: '' }
        : { ok: false, message: result.error ?? '切换分支失败' }
    } catch (error) {
      dispatch({ type: 'git-failed' })
      return { ok: false, message: String((error as Error | undefined)?.message ?? error) }
    }
  }, [api])

  /**
   * 拉取当前分支最新。与切分支的区别是成功也要说话：「Already up to date.」和「1 file changed,
   * 1 insertion(+)」是完全不同的两件事，不说用户就不知道到底有没有拉到东西。
   */
  const pullBranch = useCallback(async (): Promise<GitActionResult> => {
    const current = stateRef.current
    const cwd = current.info?.cwd ?? current.cwd
    if (api === undefined || cwd === '') return { ok: false, message: '还没有可用的工作目录' }
    dispatch({ type: 'git-loading' })
    try {
      const result = await api.gitPull()
      dispatch({ type: 'git-status', cwd, status: result.status })
      return result.ok
        ? { ok: true, message: result.message ?? '' }
        : { ok: false, message: result.error ?? '拉取失败' }
    } catch (error) {
      dispatch({ type: 'git-failed' })
      return { ok: false, message: String((error as Error | undefined)?.message ?? error) }
    }
  }, [api])

  /**
   * git 什么时候重新探测：换会话 / 换项目（`activeKey` 变，另一个项目可能是另一个仓库），以及
   * 一个回合结束（`busy` 由 true 变 false —— agent 自己可能用 bash `git checkout` 过）。
   */
  useEffect(() => {
    void loadGit()
  }, [loadGit, state.activeKey, state.busy])

  /**
   * 换前台会话的公共入口。顺序要紧：先 `activate`（换视角）再 `attach`，这样主进程回的第一帧
   * （`restarting` / `ready`）一定落在已经存在的视图上。`reuse` 取「界面见没见过这个会话」。
   */
  const switchTo = useCallback(async (
    key: string,
    cwd: string,
    resume: string | undefined,
  ): Promise<string> => {
    const current = stateRef.current
    const reuse = current.knownViews.includes(key)
    dispatch({ type: 'activate', key, cwd })
    if (api === undefined) return key
    const result = await api.attach({
      cwd,
      ...(resume === undefined ? {} : { resume }),
      reuse,
      // 「刚离开的会话还在跑」：主进程可能还没收到 prompt，先替它记上（见 ipc.ts）。
      activeBusy: current.busy,
    })
    if (result.attached) dispatch({ type: 'attached', key: result.key })
    return result.key
  }, [api])

  /**
   * 恢复会话：`--resume` 要求开启持久化，桌面端默认是开的。跨项目恢复要带上 `cwd`：会话 id 只在
   * 它自己的项目里有效，否则会得到「会话不存在」。
   */
  const resumeSession = useCallback(async (sessionId: string, cwd?: string): Promise<void> => {
    const current = stateRef.current
    const target = cwd ?? current.info?.cwd ?? current.cwd
    if (target === '') {
      dispatch({ type: 'user-error', message: '恢复会话失败：还不知道它在哪个项目里' })
      return
    }
    try {
      await switchTo(sessionKey(target, sessionId), target, sessionId)
    } catch (error) {
      dispatch({ type: 'user-error', message: `恢复会话失败：${String((error as Error | undefined)?.message ?? error)}` })
    }
  }, [switchTo])

  /** 切到另一个项目：在新工作目录里开一个新会话。 */
  const openProject = useCallback(async (path: string): Promise<void> => {
    try {
      await switchTo(sessionKey(path, undefined), path, undefined)
    } catch (error) {
      dispatch({ type: 'user-error', message: `切换项目失败：${String((error as Error | undefined)?.message ?? error)}` })
    }
  }, [switchTo])

  /** 在当前项目里开一个新会话。 */
  const newSession = useCallback(async (): Promise<void> => {
    const current = stateRef.current
    const cwd = current.info?.cwd ?? current.cwd
    if (cwd === '') return
    try {
      await switchTo(sessionKey(cwd, undefined), cwd, undefined)
    } catch (error) {
      dispatch({ type: 'user-error', message: `新建会话失败：${String((error as Error | undefined)?.message ?? error)}` })
    }
  }, [switchTo])

  /**
   * 展开一个折叠的项目：让 host 去读它的会话（读盘在 host 侧，界面只发请求并标记「读取中」）。
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
    if (typeof picked === 'string' && picked !== '') {
      try {
        await switchTo(sessionKey(picked, undefined), picked, undefined)
      } catch (error) {
        dispatch({ type: 'user-error', message: `切换工作目录失败：${String((error as Error | undefined)?.message ?? error)}` })
      }
    }
    return picked ?? null
  }, [api, switchTo])

  const openPath = useCallback(async (path: string): Promise<void> => {
    const result = await api?.openPath(path)
    // 主进程返回错误字符串（例如文件不存在），成功时空字符串。
    if (typeof result === 'string' && result !== '') {
      dispatch({ type: 'user-error', message: `打开失败：${result}` })
    }
  }, [api])

  /**
   * 重启当前会话的内核（同一个 cwd + 同一个会话 id，只换一个进程）。`reuse: false`：这是「按新
   * 配置重启」，而不是「切过去看看」，即使主进程里还留着这个会话的 host 也换掉。
   */
  const restartKernel = useCallback(async (): Promise<void> => {
    const current = stateRef.current
    const cwd = current.info?.cwd ?? current.cwd
    const resume = current.info?.sessionId
    if (cwd === '' || resume === undefined) return
    const key = sessionKey(cwd, resume)
    dispatch({ type: 'activate', key, cwd })
    if (api === undefined) return
    await api.attach({ cwd, resume, reuse: false, activeBusy: current.busy })
  }, [api])

  /**
   * 拉一次设置数据，不缓存到 state 以外的地方：每次打开设置面板都重新拉，这样「改完文件切回来」
   * 看到的一定是盘上的现状。
   */
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
      // 文件索引拿不到就是菜单空着，不值得打断输入。
    }
  }, [api])

  const readFile = useCallback(async (path: string): Promise<FileResult> => {
    if (api === undefined) return { ok: false, error: 'window.Memento 不可用' }
    return api.settingsRead(path)
  }, [api])

  const writeFile = useCallback(async (path: string, content: string): Promise<FileResult> => {
    if (api === undefined) return { ok: false, error: 'window.Memento 不可用' }
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
    setEffort,
    loadGit,
    switchBranch,
    pullBranch,
    newSession,
    resumeSession,
    openProject,
    loadProjectSessions,
    openPath,
    previewRead,
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
