/**
 * 把 DSH 内核的事件流翻译成桌面端 UI 帧。
 *
 * 数据来源与 CLI 的 `app/cli/ui.ts` 完全一致，只是出口不同：
 *   - `agent/assistant-stream`：**过程内**的流式增量（打字机效果）；
 *   - `session/event`：**已落盘**的会话事件（工具调用、工具结果、回合结束）；
 *   - `agent/error`：驱动层抛出的异常。
 *
 * CLI 把它们渲染成 ANSI 文本；桌面端把它们变成可 JSON 序列化的 {@link HostEvent}
 * 帧，由 Electron 主进程转发给渲染进程。工具摘要的格式化逻辑直接复用 CLI 的实现，
 * 保证两边「工具调用长什么样」不会分叉。
 *
 * @module YuanMy/desktop/host/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
// 复用 CLI 的工具摘要格式化，避免终端与 GUI 的展示逻辑各写一份。
import { summarizeCall, summarizeResult } from '../../cli/ui.ts'
import { toOutcome, type HostEvent, type TurnOutcome } from './protocol.ts'

/** 一次回合的统计结果。 */
export interface TurnStats {
  /** 本轮助手正文（流式增量的拼接结果）。 */
  readonly text: string
  /** 本轮工具调用次数。 */
  readonly toolCalls: number
  /** 结束原因。 */
  readonly outcome: TurnOutcome
  /** 出错时的信息。 */
  readonly error: string | undefined
}

/** 产生 UI 帧的回调（host 里就是 `process.send`）。 */
export type FrameSink = (event: HostEvent) => void

/** 桥接选项。 */
export interface BridgeOptions {
  /** 是否把模型的推理过程也发给界面（界面自行决定折叠或展开）。 */
  readonly showReasoning: boolean
}

/**
 * 事件桥：订阅内核事件 → 发出 UI 帧。
 *
 * 生命周期约定：`startTurn()` → （若干流式 / 工具帧）→ `finishTurn()`。
 * 帧里带的 `turnId` 由调用方在 `startTurn` 时给出，界面据此把内容归到同一条消息下。
 */
export class DesktopBridge {
  private readonly emit: FrameSink
  private readonly options: BridgeOptions
  /** 卸载监听用；`dispose()` 时全部调用。 */
  private readonly disposers: (() => void)[] = []
  /** 当前回合 id；没有回合进行时为 `undefined`。 */
  private turnId: string | undefined
  /** 本回合已调用的工具次数。 */
  private toolCalls = 0
  /** 本回合助手正文的累计值（权威值，用来校正界面上的流式拼接）。 */
  private text = ''
  /** callId → 工具名，用于在工具结果里回填「是哪个工具返回的」。 */
  private readonly callNames = new Map<string, string>()
  /** 本回合的结束原因（由 `turn/end` / `agent/error` 写入）。 */
  private outcome: TurnOutcome = 'unknown'
  /** 本回合的错误信息。 */
  private error: string | undefined

  /**
   * @param ctx - 根上下文（事件总线）。
   * @param agent - 本次运行的 agent；其他 agent 的事件会被忽略。
   * @param emit - UI 帧出口。
   * @param options - 桥接选项。
   */
  constructor(ctx: Context, agent: Agent, emit: FrameSink, options: BridgeOptions) {
    this.emit = emit
    this.options = options

    this.disposers.push(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== agent) return
      this.onStreamFrame(frame)
    }))

    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      switch (event.type) {
        case 'tool/call':
          this.toolCalls += 1
          this.callNames.set(event.data.callId, event.data.name)
          this.send({
            type: 'tool-call',
            turnId: this.currentTurn(),
            callId: event.data.callId,
            name: event.data.name,
            summary: summarizeCall(event.data.arguments),
          })
          break
        case 'tool/result': {
          const first = event.data.message.content[0]
          const isError = first?.isError === true
          const callId = first?.toolCallId ?? ''
          this.send({
            type: 'tool-result',
            turnId: this.currentTurn(),
            callId,
            name: this.callNames.get(callId) ?? '',
            summary: summarizeResult(event.data.message.content, isError),
            isError,
          })
          break
        }
        case 'turn/end':
          // `turn/end` 只记录原因，帧在 `finishTurn()` 里统一发（那里才有完整统计）。
          this.outcome = toOutcome(event.data.reason)
          if (event.data.reason.kind === 'error') this.error = event.data.reason.error.message
          break
        case 'assistant/message':
          // 每个 step 一条助手消息，`usage` 挂在这里（空内容的助手消息只为了带 usage）。
          // 计数是互斥的：inputTokens 只算未命中缓存的部分，命中部分在 cacheReadTokens。
          if (event.data.usage !== undefined) {
            this.send({ type: 'usage', turnId: this.currentTurn(), usage: event.data.usage })
          }
          break
        default:
          break
      }
    }))

    this.disposers.push(ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject !== agent) return
      const message = error instanceof Error ? error.message : String(error)
      // `agent/error` 是驱动边界的兜底：内核不会让 `whenIdle()` reject，错误只从事件里来。
      this.outcome = 'error'
      this.error = message
      this.send({ type: 'notice', level: 'warn', message: `agent 错误: ${message}` })
    }))
  }

  /**
   * 开始一个新回合：清空上一轮的累计值。
   * @param turnId - 主进程生成的回合 id。
   */
  startTurn(turnId: string): void {
    this.turnId = turnId
    this.toolCalls = 0
    this.text = ''
    this.outcome = 'unknown'
    this.error = undefined
    this.callNames.clear()
  }

  /**
   * 结束当前回合并返回统计。
   * @returns 本轮正文、工具调用次数与结束原因。
   */
  finishTurn(): TurnStats {
    const stats: TurnStats = {
      text: this.text,
      toolCalls: this.toolCalls,
      outcome: this.outcome,
      error: this.error,
    }
    this.turnId = undefined
    return stats
  }

  /** 卸载全部事件监听。 */
  dispose(): void {
    for (const off of this.disposers) off()
    this.disposers.length = 0
  }

  /** 当前回合 id；没有回合时返回空串（帧结构保持稳定，界面不必判空）。 */
  private currentTurn(): string {
    return this.turnId ?? ''
  }

  /** 安全地发出一帧：JSON 序列化失败不应拖垮内核。 */
  private send(event: HostEvent): void {
    this.emit(event)
  }

  /** 处理一个流式帧。 */
  private onStreamFrame(frame: AssistantStreamFrame): void {
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') {
      this.text += chunk.text
      this.send({ type: 'text-delta', turnId: this.currentTurn(), text: chunk.text })
      return
    }
    if (chunk.type === 'reasoning-delta') {
      if (!this.options.showReasoning) return
      this.send({ type: 'reasoning-delta', turnId: this.currentTurn(), text: chunk.text })
    }
  }
}

/** 把 DSH 的结束原因映射成本项目的枚举（与回放共用，见 `protocol.ts` 的 `toOutcome`）。 */
