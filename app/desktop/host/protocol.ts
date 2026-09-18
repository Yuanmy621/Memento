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

/** host 启动时可被覆盖的配置（其余字段沿用 CLI 的默认值）。 */
export interface HostLaunchConfig {
  /** agent 的工作目录；文件工具与 bash 都以它为基准。 */
  readonly cwd: string
  /** 模型 id；省略则用 `$YuanMy_MODEL` 或 CLI 默认值。 */
  readonly model?: string
  /** provider id；省略则用 CLI 默认值。 */
  readonly provider?: string
  /** 推理强度：off | low | high | max。 */
  readonly effort?: string
  /** 会话数据目录（默认 `<cwd>/.YuanMy`）。 */
  readonly stateDir?: string
  /** 是否把会话写入磁盘。 */
  readonly persist?: boolean
  /** 指定新会话 id。 */
  readonly sessionId?: string
  /** 恢复一个已落盘的会话 id。 */
  readonly resume?: string
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
  }
  /** 模型已切换。 */
  | { readonly type: 'model-changed'; readonly model: string }
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
  | { readonly type: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  /** 致命错误：host 即将退出。 */
  | { readonly type: 'fatal'; readonly message: string }

/** 判断一个来自 host 的未知值是否是合法事件（子进程输出不可信）。 */
export function isHostEvent(value: unknown): value is HostEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  switch (candidate['type']) {
    case 'ready':
      return typeof candidate['info'] === 'object' && candidate['info'] !== null
    case 'text-delta':
    case 'reasoning-delta':
      return typeof candidate['turnId'] === 'string' && typeof candidate['text'] === 'string'
    case 'tool-call':
    case 'tool-result':
      return typeof candidate['turnId'] === 'string' && typeof candidate['callId'] === 'string'
        && typeof candidate['name'] === 'string' && typeof candidate['summary'] === 'string'
    case 'turn-end':
      return typeof candidate['turnId'] === 'string' && typeof candidate['outcome'] === 'string'
    case 'model-changed':
      return typeof candidate['model'] === 'string'
    case 'usage':
      return typeof candidate['turnId'] === 'string' && typeof candidate['usage'] === 'object' && candidate['usage'] !== null
    case 'workspace':
      return Array.isArray(candidate['projects']) && Array.isArray(candidate['sessions'])
    case 'project-sessions':
      return typeof candidate['path'] === 'string' && Array.isArray(candidate['sessions'])
    case 'notice':
      return typeof candidate['message'] === 'string'
    case 'fatal':
      return typeof candidate['message'] === 'string'
    default:
      return false
  }
}
