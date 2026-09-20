/**
 * 桌面端「主进程 ⇄ agent host 子进程」之间的消息协议。
 *
 * 这个文件不依赖 electron，也不依赖 DSH —— 它只是**类型契约**，
 * 被三处同时引用：
 *   1. `host/index.ts`   —— agent host（跑在独立的 Node 进程里）产生事件；
 *   2. `main.js`        —— Electron 主进程转发事件到渲染进程；
 *   3. `preload.js`     —— 渲染进程通过 `window.YuanMy` 收到同一批事件。
 *
 * 为什么 agent 要跑在**子进程**而不是 Electron 主进程里：
 *   DSH 的执行能力 provider（`dsh-fs-local` → koffi、`dsh-subprocess-local` → node-pty）
 *   都是**原生模块**，是按系统 Node 的 ABI 编译的；Electron 自带 Node 的 ABI 不同，
 *   直接在主进程里 `import` 会在加载 .node 时失败。把内核放进一个用系统 `node`
 *   启动的子进程，既绕开了 ABI 问题，也让「渲染进程崩溃 / 窗口关闭」不会带走内核状态。
 *
 * @module YuanMy/desktop/host/protocol
 */

/** 协议版本：主进程与 host 对不上时直接报错，避免静默错位。 */
export const PROTOCOL_VERSION = 1


// ─────────────────────────────────────────────────────────────────────────────
// 会话记录（transcript）的词表
//
// 这一组类型描述「界面上一条会话长什么样」，由三处共用：
//   - 实时路径：`bridge.ts` 发出的增量帧 → 渲染进程归约成这些结构；
//   - 回放路径：`history.ts` 读落盘日志，直接产出同样的结构；
//   - 渲染：组件只认这些结构。
// 放在协议里（而不是渲染进程内部）是因为**回放是 host 的职责** ——
// 官方客户端同样由 host 提供已完成回合的 transcript，客户端只负责渲染。
// ─────────────────────────────────────────────────────────────────────────────

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

/** 用户消息。 */
export interface UserItem {
  readonly id: string
  readonly kind: 'user'
  readonly text: string
}

/** 系统提示（居中显示）。 */
export interface NoteItem {
  readonly id: string
  readonly kind: 'note'
  readonly level: 'info' | 'warn' | 'error'
  readonly text: string
}

/** 一条助手消息（一个回合一条，内部按顺序排 blocks）。 */
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

/**
 * 中途的目标调整（用户在回合进行中插的话）。
 *
 * 与 {@link UserItem} 分开记：它不是「一轮的开始」，而是**对正在跑的那一轮的纠偏**
 * （内核 `agent.steer()` 会在下一个 step 边界消费它）。界面上也要长得不一样，
 * 否则事后回看会以为那是新一轮提问。
 */
export interface SteerItem {
  readonly id: string
  readonly kind: 'steer'
  readonly text: string
}

export type Item = UserItem | NoteItem | AssistantItem | SteerItem

/**
 * 会话级 token 累计（回放历史时由日志里的 usage 求和得到）。
 *
 * 注意与渲染进程自己那份 `UsageTotals` 的区别：那份多一个 `last`（最近一次调用
 * 的明细，给 tooltip 用），是**累加过程**里的状态；这里只描述「历史总和」。
 */
export interface SessionUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly calls: number
}

/** 一次模型调用的 token 计量。 */
export interface LlmUsage {
  /**
   * **未命中缓存**的输入 token。
   *
   * ⚠️ DSH 的计数是**互斥**的：`inputTokens` 只算未缓存的那部分，命中缓存的输入
   * 单独记在 {@link cacheReadTokens}。所以「计费输入」是三者之和，命中率的分母也是它。
   */
  readonly inputTokens: number
  /** 输出 token（含推理）。 */
  readonly outputTokens: number
  /** 本次调用总 token（provider 提供或推导得出）。 */
  readonly totalTokens?: number
  /** 命中缓存而直接复用的输入 token。 */
  readonly cacheReadTokens?: number
  /** 写入缓存的输入 token。 */
  readonly cacheWriteTokens?: number
  /** 其中用于推理的 token（`outputTokens` 的子集）。 */
  readonly reasoningTokens?: number
}

/** 一个已落盘会话的摘要（侧栏列表用）。 */
export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly turns: number
  readonly current: boolean
}

/** 一个项目的摘要。 */
export interface ProjectSummary {
  readonly name: string
  readonly path: string
  readonly sessionCount: number
  readonly updatedAt: number
  readonly current: boolean
}

/**
 * 一个可选模型的概览。
 *
 * 来自内核的 `ctx.llm.listModels(provider)`（适配器自己申报的目录），
 * 不是界面里写死的常量 —— 换 provider / 适配器升级后下拉框自动跟着变。
 */
export interface ModelInfo {
  /** 传给请求的模型 id。 */
  readonly id: string
  /** 给人看的名字。 */
  readonly name: string
  /** 可选的补充说明（同一 provider 下相似模型的区分）。 */
  readonly description?: string
}

/**
 * 输入框 `/` 菜单要的**精简**技能信息。
 *
 * 与 {@link SkillEntry}（设置界面用）的区别：这里不要路径、不要大小 ——
 * 菜单只需要「名字 + 一句话 + 属于哪一类」，而它要在**每次启动**就绪时发给界面，
 * 所以刻意做得轻（`ctx.skills.list()` 直接就有这些字段，不用逐个读正文）。
 */
export interface SkillBrief {
  readonly name: string
  readonly description: string
  /** `global` 进模型目录；`command` 只由 `/命令` 加载。 */
  readonly invocation: 'global' | 'command' | 'user-only'
}

/** 输入框 `/` 菜单要的命令信息。 */
export interface CommandBrief {
  readonly name: string
  readonly description: string
  readonly argsHint: string
}

/** `#` 引用菜单要的一个路径。 */
export interface FileBrief {
  /** 相对工作目录的路径。 */
  readonly path: string
  readonly kind: 'file' | 'dir'
}

/**
 * 设置界面要的一条 skill 记录。
 *
 * `invocation` 是这次重构的核心区分（内核的 `SkillInvocationPolicy`）：
 *   - `global`：进模型的会话目录，模型能自己按需加载（**长期**）；
 *   - `command`：`disable-model-invocation: true`，不进目录，只由 `/命令` 触发（**短期**）；
 *   - `user-only`：连人工入口都不给（`user-invocable: false`）。
 */
export interface SkillEntry {
  readonly name: string
  readonly description: string
  readonly invocation: 'global' | 'command' | 'user-only'
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** 来源（`project-agents` / `custom` / …，来自内核的 SkillSource）。 */
  readonly source: string
  /** SKILL.md 绝对路径；内核没给路径时为空串。 */
  readonly path: string
  /** 正文大小（字符数）。 */
  readonly bytes: number
  /**
   * 盘上有、内核却没加载时的原因。
   *
   * 为什么要有这个字段：磁盘上的 `SKILL.md` 一旦 frontmatter 不合法（缺 name/description、
   * YAML 写坏），provider 只写一条 `logger.warn` 就**静默忽略**整个 skill ——
   * 从界面上看就是「文件明明在，技能却不生效」。真踩过：上游 `report` skill 的
   * description 里有 `EN: ` 这种「冒号+空格」，YAML 判定成嵌套映射直接抛错。
   */
  readonly warning?: string
}

/** 设置界面要的一条命令记录（`.agents/commands/<名字>.md`）。 */
export interface CommandEntry {
  readonly name: string
  readonly description: string
  readonly argsHint: string
  /** `project` / `user` / `extra`。 */
  readonly scope: string
  readonly path: string
  /** 会被内联进这一回合的文件（绝对路径）。 */
  readonly includes: readonly string[]
  readonly bytes: number
}

/** 设置界面要的一条 MCP 服务器记录。 */
export interface McpEntry {
  readonly name: string
  /** 是否会被挂载。 */
  readonly enabled: boolean
  /** 为什么是这个状态：配置文件 / 环境变量 / 关着。 */
  readonly reason: 'config' | 'env' | 'off'
  readonly transport: 'stdio' | 'streamable-http'
  readonly command: string
  readonly args: readonly string[]
  /** streamable-http 的端点。 */
  readonly url: string
  /** 显式转发的环境变量名。 */
  readonly forwardEnv: readonly string[]
  /** 定义来自哪里。 */
  readonly source: 'builtin' | 'project' | 'config'
}

/** `ready` 帧里携带的、足以渲染整个界面侧栏的信息。 */
export interface HostReadyInfo {
  /** 协议版本，渲染进程用来判断自己是否太旧。 */
  readonly protocolVersion: number
  /** 本次运行的会话 id。 */
  readonly sessionId: string
  /** provider id。 */
  readonly provider: string
  /** 模型 id。 */
  readonly model: string
  /** 工作目录（绝对路径）。 */
  readonly cwd: string
  /** 会话是否落盘。 */
  readonly persist: boolean
  /** 凭据来源的可读描述；没有 key 时是提示文案。 */
  readonly credential: string
  /** 已注册的工具（名字 + 描述首行）。 */
  readonly tools: readonly HostToolInfo[]
  /** 该 provider 申报的可选模型（界面下拉用）。 */
  readonly models: readonly ModelInfo[]
  /**
   * 输入框菜单用的技能与命令（就绪时一次性发过去）。
   *
   * 为什么不复用设置界面的 `settings:list`：那个要读盘、要逐个读正文、还带路径与大小，
   * 只在打开面板时才值得付；而输入框的菜单**随时可能被触发**，所以走 ready。
   */
  readonly skills?: readonly SkillBrief[]
  readonly commands?: readonly CommandBrief[]
  /** host 进程的 Node 版本，便于排查环境问题。 */
  readonly nodeVersion: string
}

/** 一个工具的概览信息。 */
export interface HostToolInfo {
  readonly name: string
  readonly description: string
}

/** 一次回合的结束原因（与 DSH `turn/end` 的 `reason.kind` 对齐）。 */
export type TurnOutcome = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'unknown'

/**
 * 把 DSH 的回合结束原因映射成本项目的 {@link TurnOutcome}。
 *
 * 放在协议里（而不是桥或回放里）是因为**两条路径必须给出同一个结论**：
 * 实时路径由 `bridge.ts` 的 `turn/end` 事件调用它，回放路径由 `history.ts`
 * 读日志里的 `turn/end` 时调用它。任何一边单独改都会让「同一回合刷新前后不一样」。
 *
 * ⚠️ 内核的 `TurnEndReason` 比这里的枚举长：`blocked`（被插件拦下）与
 * `interrupted`（崩溃后补写的收尾）都归到 `unknown` —— 它们对用户都是
 * 「这回合没跑完」，界面不必区分。
 * @param reason - 日志 / 事件里的结束原因（只用到 `kind`）。
 * @returns 界面枚举值。
 */
export function toOutcome(reason: { readonly kind: string }): TurnOutcome {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'max-tokens':
      return 'max-tokens'
    case 'error':
      return 'error'
    default:
      return 'unknown'
  }
}

/** 主进程 → host 的请求。 */
export type HostRequest =
  | {
    /** 发起一次用户回合。 */
    readonly type: 'prompt'
    /** 由主进程生成的回合 id，后续事件都用它回填。 */
    readonly turnId: string
    /** 用户输入的自然语言任务。 */
    readonly text: string
  }
  /**
   * **中途调整目标**：把这段话作为「纠偏」交给正在跑的回合。
   *
   * 对应内核的 `agent.steer()` —— 语义是「在最近的 step 边界消费」：
   * 已经在跑就在下一个 step 生效（不打断已发出的请求），空闲时则直接开一个新回合。
   * 与 `prompt` 的区别：`prompt` 是**排队**（当前回合跑完才轮到它），
   * `steer` 是**插进去改方向**。
   */
  | { readonly type: 'steer'; readonly text: string }
  /** 要一份可引用的文件清单（`#` 菜单）。 */
  | { readonly type: 'files:list'; readonly query: string; readonly limit?: number }
  /**
   * 要一次设置数据（skill / 命令 / MCP），回一个 `settings` 帧。
   *
   * 与之配套的文件读写**不在这里** —— 那是主进程的活（它有 fs，也是安全边界），
   * 见 `main.js` 的 `YuanMy:settings-read` / `YuanMy:settings-write`。
   */
  | { readonly type: 'settings:list' }
  | {
    /** 重新扫描落盘会话，回一个 `workspace` 帧（侧栏刷新用）。 */
    readonly type: 'list-sessions'
  }
  | {
    /**
     * 读**指定项目**的会话明细（侧栏里点开一个折叠的项目时用）。
     *
     * 刻意与 `list-sessions` 分开：项目清单随首屏一起到，但每个项目的会话明细
     * 只在真被点开时才读盘 —— 项目再多，首屏也只付「每个项目读一个日志头」的代价。
     */
    readonly type: 'list-project-sessions'
    /** 目标项目根目录（`ProjectSummary.path`）。 */
    readonly path: string
  }
  | {
    /** 中断当前回合（等价于 CLI 里的 Ctrl-C）。 */
    readonly type: 'cancel'
  }
  | {
    /** 运行中切换模型：下一次请求生效。 */
    readonly type: 'set-model'
    readonly model: string
  }
  | {
    /** 卸载内核并退出；主进程在窗口关闭时发送。 */
    readonly type: 'shutdown'
  }

/** host → 主进程的事件。 */
export type HostEvent =
  /** 内核装配完成，可以开始对话。 */
  | { readonly type: 'ready'; readonly info: HostReadyInfo }
  /** 助手正文的流式增量（打字机效果）。 */
  | { readonly type: 'text-delta'; readonly turnId: string; readonly text: string }
  /** 模型推理过程的流式增量；渲染进程默认折叠显示。 */
  | { readonly type: 'reasoning-delta'; readonly turnId: string; readonly text: string }
  /** 发生了一次工具调用。 */
  | {
    readonly type: 'tool-call'
    readonly turnId: string
    readonly callId: string
    readonly name: string
    readonly summary: string
  }
  /** 一次工具调用返回了结果。 */
  | {
    readonly type: 'tool-result'
    readonly turnId: string
    readonly callId: string
    readonly name: string
    readonly summary: string
    readonly isError: boolean
  }
  /** 回合结束；`text` 是流式增量的权威汇总，界面可用它校正正文。 */
  | {
    readonly type: 'turn-end'
    readonly turnId: string
    readonly outcome: TurnOutcome
    readonly error?: string
    readonly text: string
    readonly toolCalls: number
    /** 本回合墙钟耗时（毫秒）。由 host 在回合前后量，界面直接显示。 */
    readonly durationMs: number
  }
  /** 模型已切换。 */
  | { readonly type: 'model-changed'; readonly model: string }
  /**
   * 历史回放：恢复一个已落盘的会话时，host 读日志产出的完整记录。
   *
   * 渲染进程收到后用**整段替换** `items`（而不是增量追加）——
   * 回放与实时是两条不同的路径，混在一起会重复。
   */
  | {
    readonly type: 'history'
    readonly items: readonly Item[]
    /** 该会话的历史 token 累计，用来恢复统计条。 */
    readonly usage: SessionUsage
    /** 历史里已完成的回合数（`items` 可能因为截断而少于它）。 */
    readonly turns: number
    /** 因为太长被截掉了多少回合（0 表示完整）。 */
    readonly truncatedTurns: number
  }
  /** 项目与会话清单（就绪后、每轮结束、以及收到 `list-sessions` 时发出）。 */
  | {
    readonly type: 'workspace'
    readonly projects: readonly ProjectSummary[]
    readonly sessions: readonly SessionSummary[]
  }
  /** **某个项目**的会话明细（响应 `list-project-sessions`）。 */
  | {
    readonly type: 'project-sessions'
    /** 与请求里的 `path` 逐字对应，界面据此把结果挂到对应项目上。 */
    readonly path: string
    /** 该项目的会话，按最近活动倒序；读不到时是空数组。 */
    readonly sessions: readonly SessionSummary[]
    /** 项目目录已消失 / 读不动时为 true，界面据此结束「读取中」。 */
    readonly missing?: boolean
  }
  /** 一次模型调用的 token 计量（每步一次，界面累加成会话总量）。 */
  | { readonly type: 'usage'; readonly turnId: string; readonly usage: LlmUsage }
  /**
   * 非致命提示（例如凭据缺失），界面以系统消息展示。
   * `error` 目前只由渲染进程自己使用（例如 preload 没注入），host 只发 info / warn。
   */
  /**
   * 设置界面的数据：把「现有 skill / 命令 / MCP」一次性发过去。
   *
   * 只在界面打开设置面板时请求（`settings:list`），不放在 `ready` 里 ——
   * 它要读盘、要问内核，没必要让每次启动都付这个成本。
   */
  | {
    readonly type: 'settings'
    readonly skills: readonly SkillEntry[]
    readonly commands: readonly CommandEntry[]
    readonly mcp: readonly McpEntry[]
    /** MCP 配置文件路径（界面「编辑配置」用）。 */
    readonly mcpConfigPath: string
    /** 配置文件存在但解析失败时的原因。 */
    readonly mcpConfigError?: string
  }
  /**
   * `#` 引用菜单要的路径清单（响应 `files:list`）。
   *
   * `query` 原样回传：输入是异步的，界面据此丢弃过期结果（用户又打了一个字）。
   */
  | { readonly type: 'files'; readonly query: string; readonly items: readonly FileBrief[] }
  | { readonly type: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  /** 致命错误：host 即将退出。 */
  | { readonly type: 'fatal'; readonly message: string }

/** 全部 host 事件类型（`isHostEvent` 用它做形状校验）。 */
const HOST_EVENT_TYPES: ReadonlySet<string> = new Set([
  'ready', 'history', 'text-delta', 'reasoning-delta', 'tool-call', 'tool-result',
  'usage', 'turn-end', 'notice', 'fatal', 'workspace', 'project-sessions',
  'settings', 'files', 'model-changed',
])

/**
 * 这个值是不是一个 host 事件。
 *
 * 为什么要它：主进程拿到的是**子进程**的输出，按不可信处理 —— 转发给渲染进程之前
 * 至少得确认「它是个我们认识的事件」。只认 `type` 在名单里这一条，字段内容由
 * 渲染进程自己的归约器兜（它本来就有 default 分支）。
 *
 * @param value - 任意值（通常是 child_process 的 message）。
 * @returns 是 host 事件时为 `true`（类型收窄成 {@link HostEvent}）。
 */
export function isHostEvent(value: unknown): value is HostEvent {
  if (typeof value !== 'object' || value === null) return false
  const { type } = value as { type?: unknown }
  return typeof type === 'string' && HOST_EVENT_TYPES.has(type)
}

