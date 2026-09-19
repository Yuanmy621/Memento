/**
 * 历史回放：把一个**已落盘**的会话日志读成界面能直接渲染的记录。
 *
 * ## 为什么在 host 侧做
 *
 * 官方客户端的已完成回合记录同样是 **host 提供的**（客户端只负责渲染投影）。
 * 这里沿用同一分工：渲染进程不碰磁盘，host 读日志、产出 `Item[]`，
 * 渲染进程整段替换 `items` 即可。
 *
 * ## 数据来源：会话日志就是权威
 *
 * 恢复会话时 agent 的上下文由 DSH 自己从日志重建，界面这边必须看到**同一份**内容，
 * 所以回放也只认日志，不另存一份 UI 状态：
 *
 * | 日志事件 | 变成界面上的 |
 * | --- | --- |
 * | `user/message`（`source.kind === 'user'`） | 用户气泡 |
 * | `assistant/message` 的 `reasoning` 块 | 推理行 |
 * | `assistant/message` 的 `text` 块 | 正文（Markdown） |
 * | `tool/call` | 工具行 / 文件卡片 |
 * | `tool/result` | 回填到对应 `callId` 的工具结果 |
 * | `turn/end` | 回合结论（完成 / 中断 / 失败） |
 * | `assistant/message` 的 `usage` | 累加成会话 token 统计 |
 *
 * ⚠️ 一个容易踩的点：日志里还有 `source.kind === 'skill-catalog'` 的
 * `user/message`（技能目录注入）。那是**给模型看的**，不是用户说的话，
 * 回放时必须过滤掉，否则界面上会冒出一大段「用户消息」。
 *
 * ## 有界读取
 *
 * 只回放最近 `maxTurns` 个回合（默认 50）。更早的内容不显示，但 **agent 自己仍然
 * 记得**（它的上下文来自完整日志）—— 这个差异通过 `truncatedTurns` 如实告知界面。
 *
 * @module YuanMy/desktop/host/history
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { toOutcome, type AssistantItem, type Block, type Item, type NoteItem, type SessionUsage, type ToolBlock } from './protocol.ts'

/** 单个日志最多整体读多少字节；超过只读头部（与 sessions.ts 同一策略）。 */
const MAX_LOG_BYTES = 8 * 1024 * 1024
/** 大文件时只读头部这么多。 */
const HEAD_BYTES = 1024 * 1024
/** 会话日志文件名。 */
const LOG_NAME = 'session.v3.jsonl'
/** 默认回放多少个回合（从最新的往前数）。 */
const DEFAULT_MAX_TURNS = 50

/** 一次回放的结果。 */
export interface SessionHistory {
  /** 按时间顺序排好的界面条目。 */
  readonly items: readonly Item[]
  /** 历史 token 累计。 */
  readonly usage: SessionUsage
  /** 日志里已完成的回合总数（可能大于 `items` 覆盖的回合数）。 */
  readonly turns: number
  /** 因为超出上限而没有回放的回合数。 */
  readonly truncatedTurns: number
}

/** 一个回合在回放过程中的临时结构。 */
interface TurnDraft {
  readonly turn: number
  readonly items: Item[]
  /** 当前正在写的助手条目（每次遇到 assistant/message 就补内容）。 */
  assistant: AssistantItem | undefined
  toolCalls: number
  outcome: AssistantItem['meta']
}

/** 从内容块数组里取纯文本。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .join('')
}

/** 取 assistant/message 里的某类块拼成的文本。 */
function assistantText(content: unknown, kind: 'text' | 'reasoning'): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === kind && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .join('')
}

/**
 * 取 assistant/message 里的工具调用块。
 *
 * 这是 `tool/call` 事件的**兜底来源**：正常流程两者都有（消息先落盘、随后是
 * `tool/call`），但进程若在两步之间崩掉，日志里就只剩这一份。按 callId 去重，
 * 所以两条路都走到时不会出现两张卡片。
 */
function assistantToolCalls(content: unknown): { callId: string; name: string; args: string }[] {
  if (!Array.isArray(content)) return []
  const calls: { callId: string; name: string; args: string }[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
    if (candidate.type !== 'tool-call' || typeof candidate.id !== 'string') continue
    calls.push({
      callId: candidate.id,
      name: typeof candidate.name === 'string' ? candidate.name : '?',
      args: summarizeArgs(candidate.arguments),
    })
  }
  return calls
}

/** 把工具参数压成一行摘要（与 CLI / bridge 的展示保持一致）。 */
function summarizeArgs(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return raw.slice(0, 100)
    const args = parsed as Record<string, unknown>
    const pick = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = args[key]
        if (typeof value === 'string' && value !== '') return value
      }
      return undefined
    }
    return pick('command', 'file_path', 'pattern', 'url', 'path') ?? ''
  } catch {
    return raw.slice(0, 100)
  }
}

/** 从工具结果事件里抽一行摘要（与 `app/cli/ui.ts` 的 summarizeResult 同口径）。 */
function summarizeResult(content: unknown, isError: boolean): string {
  if (!Array.isArray(content)) return isError ? 'error' : 'ok'
  const first = content[0]
  const blocks = (typeof first === 'object' && first !== null
    ? (first as { content?: unknown }).content
    : undefined) ?? content
  const text = (Array.isArray(blocks) ? blocks : [])
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const candidate = block as { type?: unknown; text?: unknown }
      return typeof candidate.text === 'string' ? candidate.text : ''
    })
    .join('\n')
    .trim()
  if (text === '') return isError ? 'error' : 'ok'
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? ''
  const lines = text.split('\n').length
  const head = firstLine.length > 110 ? `${firstLine.slice(0, 109)}…` : firstLine
  const exit = /\[exit code: (\d+)\]/.exec(text)
  return `${head}${lines > 1 ? ` (${String(lines)} 行)` : ''}${exit === null ? '' : ` exit ${exit[1]}`}`
}

/** 读一个日志文件（大文件只读头部）。 */
async function readLog(path: string): Promise<string> {
  const info = await stat(path)
  if (info.size <= MAX_LOG_BYTES) return readFile(path, 'utf8')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * 在持久化根目录下找到某个会话的日志路径。
 * @param root - `<stateDir>/sessions`。
 * @param sessionId - 会话 id。
 * @returns 日志绝对路径；找不到返回 `undefined`。
 */
export async function findSessionLog(root: string, sessionId: string): Promise<string | undefined> {
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return undefined
  }
  for (const projectDir of projects) {
    const candidate = join(projectDir, sessionId, LOG_NAME)
    try {
      await stat(candidate)
      return candidate
    } catch {
      // 不在这个项目下，继续找
    }
  }
  return undefined
}

/**
 * 回放一个会话的历史。
 * @param options - 参数。
 * @param options.root - `<stateDir>/sessions`。
 * @param options.sessionId - 会话 id。
 * @param options.maxTurns - 最多回放多少个回合（从最新往前数）。
 * @returns 历史记录；找不到日志或日志为空时返回 `undefined`。
 */
export async function readSessionHistory(options: {
  readonly root: string
  readonly sessionId: string
  readonly maxTurns?: number
}): Promise<SessionHistory | undefined> {
  const path = await findSessionLog(options.root, options.sessionId)
  if (path === undefined) return undefined
  const text = await readLog(path)

  const turns: TurnDraft[] = []
  let current: TurnDraft | undefined
  const usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    calls: number
  } = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 }

  /** 取（或建）当前回合。 */
  const ensureTurn = (turn: number): TurnDraft => {
    if (current !== undefined && current.turn === turn) return current
    const draft: TurnDraft = { turn, items: [], assistant: undefined, toolCalls: 0, outcome: null }
    turns.push(draft)
    current = draft
    return draft
  }

  /** 取（或建）当前助手条目。 */
  const ensureAssistant = (draft: TurnDraft): AssistantItem => {
    if (draft.assistant !== undefined) return draft.assistant
    const item: AssistantItem = {
      id: `${options.sessionId}-t${String(draft.turn)}`,
      kind: 'assistant',
      turnId: `history-${String(draft.turn)}`,
      reasoning: '',
      blocks: [],
      meta: null,
    }
    draft.assistant = item
    draft.items.push(item)
    return item
  }

  /** 替换助手条目（结构是只读的，改内容要换对象）。 */
  const updateAssistant = (draft: TurnDraft, next: AssistantItem): void => {
    const item = ensureAssistant(draft)
    const at = draft.items.indexOf(item)
    draft.assistant = next
    if (at >= 0) draft.items[at] = next
  }

  let index = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    index += 1
    let event: { type?: unknown; time?: unknown; data?: unknown }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      // 尾部半行（正在写入）或损坏行：跳过
      continue
    }
    const type = typeof event.type === 'string' ? event.type : ''
    const data = (event.data ?? {}) as Record<string, unknown>

    if (type === 'user/message') {
      // ⚠️ 过滤非用户来源：skill-catalog 之类的注入也是 user/message
      const source = data['source'] as { kind?: unknown } | undefined
      if (source?.kind !== 'user') continue
      const text = textOf(data['content'])
      if (text.trim() === '') continue
      const turn = typeof data['turn'] === 'number' ? data['turn'] : turns.length + 1
      const draft = ensureTurn(turn)
      draft.items.push({ id: `u${String(index)}`, kind: 'user', text })
      continue
    }

    if (type === 'assistant/message') {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : turns.length + 1
      const draft = ensureTurn(turn)
      const message = (data['message'] ?? {}) as { content?: unknown }
      const reasoning = assistantText(message.content, 'reasoning')
      const prose = assistantText(message.content, 'text')
      const item = ensureAssistant(draft)
      const blocks: Block[] = prose === '' ? [...item.blocks] : [...item.blocks, { type: 'text', text: prose }]
      // 兜底：消息里带的工具调用块先占位，`tool/call` 事件到了就地更新（不重复追加）。
      for (const call of assistantToolCalls(message.content)) {
        if (blocks.some(block => block.type === 'tool' && block.callId === call.callId)) continue
        blocks.push({ type: 'tool', callId: call.callId, name: call.name, args: call.args, result: null, isError: false })
        draft.toolCalls += 1
      }
      updateAssistant(draft, { ...item, reasoning: item.reasoning + reasoning, blocks })

      const reported = data['usage'] as Record<string, number> | undefined
      if (reported !== undefined) {
        usage.inputTokens += reported['inputTokens'] ?? 0
        usage.outputTokens += reported['outputTokens'] ?? 0
        usage.cacheReadTokens += reported['cacheReadTokens'] ?? 0
        usage.cacheWriteTokens += reported['cacheWriteTokens'] ?? 0
        usage.reasoningTokens += reported['reasoningTokens'] ?? 0
        usage.calls += 1
      }
      continue
    }

    if (type === 'tool/call') {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : turns.length + 1
      const draft = ensureTurn(turn)
      const item = ensureAssistant(draft)
      const callId = typeof data['callId'] === 'string' ? data['callId'] : ''
      const name = typeof data['name'] === 'string' ? data['name'] : '?'
      const args = summarizeArgs(data['arguments'])
      const existing = item.blocks.findIndex(block => block.type === 'tool' && block.callId === callId)
      if (existing >= 0) {
        // 已被 assistant/message 的兜底块占位：补上真实的 name / args。
        const blocks = [...item.blocks]
        blocks[existing] = { ...(blocks[existing] as ToolBlock), name, args }
        updateAssistant(draft, { ...item, blocks })
      } else {
        draft.toolCalls += 1
        const block: ToolBlock = { type: 'tool', callId, name, args, result: null, isError: false }
        updateAssistant(draft, { ...item, blocks: [...item.blocks, block] })
      }
      continue
    }

    if (type === 'tool/result') {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : turns.length + 1
      const draft = ensureTurn(turn)
      const item = ensureAssistant(draft)
      const message = (data['message'] ?? {}) as { content?: unknown }
      const first = Array.isArray(message.content) ? message.content[0] : undefined
      const isError = (typeof first === 'object' && first !== null ? (first as { isError?: unknown }).isError : false) === true
      const callId = typeof (first as { toolCallId?: unknown } | undefined)?.toolCallId === 'string'
        ? String((first as { toolCallId: string }).toolCallId)
        : ''
      const summary = summarizeResult(message.content, isError)
      let matched = false
      const blocks: Block[] = item.blocks.map((block) => {
        if (block.type !== 'tool' || block.callId !== callId) return block
        matched = true
        return { ...block, result: summary, isError }
      })
      // 结果先于调用（或调用事件缺失）：补一张卡片，信息别丢
      if (!matched) {
        blocks.push({ type: 'tool', callId, name: '', args: '', result: summary, isError })
      }
      updateAssistant(draft, { ...item, blocks })
      continue
    }

    if (type === 'turn/end') {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : turns.length + 1
      const draft = ensureTurn(turn)
      const reason = (data['reason'] ?? {}) as { kind?: unknown; error?: { message?: unknown } }
      const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
      const outcome = toOutcome({ kind })
      const error = outcome === 'error' && typeof reason.error?.message === 'string' ? reason.error.message : undefined
      if (draft.assistant === undefined) {
        // 这回合没有产生任何助手消息（被打断、或崩在第一步）。
        // 只留一条光秃秃的用户消息会让人以为界面丢了东西 —— 明说「没有输出」。
        if (draft.items.length > 0) {
          const note: NoteItem = {
            id: `e${String(index)}`,
            kind: 'note',
            level: outcome === 'error' ? 'error' : 'warn',
            text: `这一回合没有产生输出（${error ?? outcome}）`,
          }
          draft.items.push(note)
        }
        continue
      }
      updateAssistant(draft, {
        ...draft.assistant,
        meta: error === undefined
          ? { outcome, toolCalls: draft.toolCalls }
          : { outcome, toolCalls: draft.toolCalls, error },
      })
    }
  }

  // 只回放最近 maxTurns 个回合
  const limit = options.maxTurns ?? DEFAULT_MAX_TURNS
  const completed = turns.filter((draft) => draft.items.length > 0)
  const kept = completed.slice(-limit)
  const items: Item[] = kept.flatMap((draft) => draft.items)

  return {
    items,
    usage,
    turns: completed.length,
    truncatedTurns: completed.length - kept.length,
  }
}
