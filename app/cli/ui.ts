/**
 * 终端渲染：把内核事件流翻译成人看的输出。
 *
 * 数据来源有两处：
 *   - `agent/assistant-stream`：**过程内**的流式增量（打字机效果）；
 *   - `session/event`：**已落盘**的会话事件（工具调用、turn 结束、错误）。
 *
 * 前者是易失的、后者才是权威记录，所以正文靠前者渲染、结论靠后者判断。
 *
 * @module YuanMy/ui
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 是否给输出上色（非 TTY 或 NO_COLOR 时关闭）。 */
export function useColor(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined
}

const wrap = (code: string, text: string): string => (useColor() ? `\u001B[${code}m${text}\u001B[0m` : text)

/** 暗色（推理过程、次要信息）。 */
export const dim = (text: string): string => wrap('2', text)
/** 加粗。 */
export const bold = (text: string): string => wrap('1', text)
/** 青色（工具调用）。 */
export const cyan = (text: string): string => wrap('36', text)
/** 绿色（成功）。 */
export const green = (text: string): string => wrap('32', text)
/** 黄色（警告）。 */
export const yellow = (text: string): string => wrap('33', text)
/** 红色（失败）。 */
export const red = (text: string): string => wrap('31', text)
/** 灰色（元信息）。 */
export const gray = (text: string): string => wrap('90', text)

/** 一次 turn 的渲染结果统计。 */
export interface TurnStats {
  /** 本轮助手文本（已渲染）。 */
  text: string
  /** 本轮工具调用次数。 */
  toolCalls: number
  /** 结束原因：completed / aborted / error / max-tokens / unknown。 */
  outcome: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'unknown'
  /** 出错时的信息。 */
  error?: string
}

/** 渲染选项。 */
export interface RenderOptions {
  /** 是否显示模型推理过程（默认显示，灰色）。 */
  readonly showReasoning: boolean
  /** 是否显示工具结果摘要。 */
  readonly showToolResults: boolean
}

/** 活跃中的渲染器。 */
export interface Renderer {
  /** 卸掉所有监听。 */
  dispose(): void
  /** 取本轮（自上次 reset 以来）的统计。 */
  stats(): TurnStats
  /** 开始新一轮渲染。 */
  reset(): void
}

/**
 * 把工具参数压成一行摘要，方便在终端里扫读。
 *
 * 导出给桌面端的 host 复用（`app/desktop/host/bridge.ts`），
 * 让「工具调用怎么显示」这件事在 CLI 与 GUI 之间保持一致。
 */
export function summarizeCall(rawArguments: string): string {
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (parsed !== null && typeof parsed === 'object') args = parsed as Record<string, unknown>
  } catch {
    return truncate(rawArguments, 100)
  }
  const pick = (key: string): string | undefined => {
    const value = args[key]
    return typeof value === 'string' ? value : undefined
  }
  const detail = pick('command') ?? pick('file_path') ?? pick('pattern') ?? pick('url') ?? pick('path')
  const extra: string[] = []
  if (args['include'] !== undefined) extra.push(`include=${String(args['include'])}`)
  if (args['offset'] !== undefined || args['limit'] !== undefined) {
    extra.push(`lines=${String(args['offset'] ?? 1)}+${String(args['limit'] ?? '')}`)
  }
  if (args['depth'] !== undefined) extra.push(`depth=${String(args['depth'])}`)
  if (args['run_in_background'] === true) extra.push('background')
  const suffix = extra.length > 0 ? dim(` (${extra.join(', ')})`) : ''
  return `${truncate(detail ?? '', 110)}${suffix}`
}

/** 从工具结果消息里抽一行摘要（同样导出给桌面端 host 复用）。 */
export function summarizeResult(blocks: readonly ContentBlock[], isError: boolean): string {
  const text = blocks
    .map(block => (block.type === 'text' ? block.text : block.type === 'tool-result' ? textOf(block.content) : ''))
    .join('\n')
    .trim()
  if (text.length === 0) return isError ? 'error' : 'ok'
  const firstLine = text.split('\n').find(line => line.trim().length > 0) ?? ''
  const exit = /\[exit code: (\d+)\]/.exec(text)
  const head = truncate(firstLine, 110)
  const lines = text.split('\n').length
  const tail = lines > 1 ? dim(` (${lines} 行)`) : ''
  const code = exit !== null ? (exit[1] === '0' ? green(' exit 0') : red(` exit ${exit[1]}`)) : ''
  return `${head}${tail}${code}`
}

/** 从嵌套内容块里取纯文本。 */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** 截断字符串。 */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * 监听 agent 的事件并实时渲染。
 * @param ctx - 根上下文（事件总线）。
 * @param agent - 本次运行的 agent；其他 agent 的事件会被忽略。
 * @param options - 渲染开关。
 * @returns 渲染器句柄。
 */
export function attachRenderer(ctx: Context, agent: Agent, options: RenderOptions): Renderer {
  let stats: TurnStats = { text: '', toolCalls: 0, outcome: 'unknown' }
  /** 当前行是否已经有内容（用于决定换行时机）。 */
  let lineOpen = false
  /** 推理段落是否已经开过头（推理与正文的分隔只做一次）。 */
  let reasoningOpen = false
  const callNames = new Map<string, string>()

  const newlineIfOpen = (): void => {
    if (lineOpen) {
      process.stdout.write('\n')
      lineOpen = false
    }
  }

  const offStream = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    renderStreamFrame(frame)
  })

  /** 渲染一个流式帧。 */
  function renderStreamFrame(frame: AssistantStreamFrame): void {
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') {
      // 正文开始：先把推理段落收尾。
      if (reasoningOpen) {
        process.stdout.write('\n')
        reasoningOpen = false
      }
      process.stdout.write(chunk.text)
      stats.text += chunk.text
      lineOpen = true
      return
    }
    if (chunk.type === 'reasoning-delta') {
      if (!options.showReasoning) return
      // 推理过程：灰色，整段只打一次前缀，避免每个增量都换行。
      if (!reasoningOpen) {
        newlineIfOpen()
        process.stdout.write(dim('⋯ '))
        reasoningOpen = true
        lineOpen = true
      }
      process.stdout.write(dim(chunk.text))
    }
  }

  const offSession = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    switch (event.type) {
      case 'tool/call': {
        reasoningOpen = false
        newlineIfOpen()
        stats.toolCalls += 1
        callNames.set(event.data.callId, event.data.name)
        process.stdout.write(`${cyan('⏺')} ${bold(event.data.name)} ${summarizeCall(event.data.arguments)}\n`)
        break
      }
      case 'tool/result': {
        if (!options.showToolResults) break
        const isError = event.data.message.content[0]?.isError === true
        const detail = summarizeResult(event.data.message.content, isError)
        const name = callNames.get(event.data.message.content[0]?.toolCallId ?? '') ?? ''
        process.stdout.write(`  ${isError ? red('⎿') : dim('⎿')} ${name === '' ? '' : dim(`${name} → `)}${detail}\n`)
        break
      }
      case 'turn/end': {
        const reason = event.data.reason
        stats.outcome = reason.kind === 'completed' ? 'completed'
          : reason.kind === 'aborted' ? 'aborted'
            : reason.kind === 'max-tokens' ? 'max-tokens'
              : reason.kind === 'error' ? 'error' : 'unknown'
        if (reason.kind === 'error') {
          stats.error = reason.error.message
        }
        break
      }
      default:
        break
    }
  })

  const offError = ctx.on('agent/error', ({ agent: subject, error }) => {
    if (subject !== agent) return
    newlineIfOpen()
    const message = error instanceof Error ? error.message : String(error)
    stats.outcome = 'error'
    stats.error = message
    process.stdout.write(`${red('✖ agent 错误:')} ${message}\n`)
  })

  return {
    dispose: () => { offStream(); offSession(); offError() },
    stats: () => stats,
    reset: () => {
      newlineIfOpen()
      reasoningOpen = false
      stats = { text: '', toolCalls: 0, outcome: 'unknown' }
      callNames.clear()
    },
  }
}

/** 打印启动横幅。 */
export function printBanner(info: {
  model: string
  provider: string
  cwd: string
  sessionId: string
  tools: number
  credential: string
  persist: boolean
}): void {
  const rows = [
    `${gray('模型')}     ${bold(`${info.provider}/${info.model}`)}`,
    `${gray('工作目录')} ${info.cwd}`,
    `${gray('会话')}     ${info.sessionId}${info.persist ? '' : gray(' (未持久化)')}`,
    `${gray('工具')}     ${info.tools} 个`,
    `${gray('凭据')}     ${info.credential}`,
  ]
  process.stdout.write(`\n${bold('YuanMy')} ${gray('· 基于 DeepSeek Harness 内核的 coding agent')}\n`)
  process.stdout.write(rows.join('\n') + '\n')
  process.stdout.write(gray('输入任务开始对话；/help 查看命令，Ctrl-C 中断当前回合，再按一次退出。\n\n'))
}
