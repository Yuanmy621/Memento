/**
 * 输入区。
 *
 * 行为约定：Enter 发送、Shift+Enter 换行、Esc 中断；回合进行中隐藏「发送」
 * 换成「停止」，并禁用输入（协议层保证回合串行）。
 *
 * @module YuanMy/desktop/renderer/components/composer
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useImeGuard } from '../composition.ts'
import { billedInputTokens, cacheHitRate, type AgentState, type UsageTotals } from '../use-agent.ts'

/** 紧凑数字：1234 → 1.2k，1234567 → 1.2M。token 数看量级就够了。 */
function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * 输入框底部的 token 统计。
 *
 * 数字来自 `assistant/message` 事件上的 `TokenUsage`，累加规则见 `use-agent.ts`
 * 的 `UsageTotals`：DSH 的计数是**互斥**的，所以
 * **计费输入 = 未命中 + 命中 + 写入**，命中率 = 命中 / 计费输入。
 */
function TokenBar({ usage }: { readonly usage: UsageTotals }): ReactElement {
  const billed = billedInputTokens(usage)
  const rate = cacheHitRate(usage)
  const last = usage.last
  const detail = last === null
    ? '本会话还没有模型调用'
    : [
      '最近一次调用：',
      `未命中输入 ${String(last.inputTokens)} · 命中缓存 ${String(last.cacheReadTokens ?? 0)} · 写入缓存 ${String(last.cacheWriteTokens ?? 0)}`,
      `输出 ${String(last.outputTokens)}（含推理 ${String(last.reasoningTokens ?? 0)}）`,
      `合计 ${String(last.totalTokens ?? '—')}`,
    ].join('\n')

  return (
    <div className="tokenbar" data-testid="token-bar" title={detail}>
      <span className="tokenbar__item" data-testid="token-input">
        输入 <b>{formatTokens(usage.inputTokens)}</b>
      </span>
      <span className="tokenbar__sep">·</span>
      <span className="tokenbar__item" data-testid="token-output">
        输出 <b>{formatTokens(usage.outputTokens)}</b>
      </span>
      <span className="tokenbar__sep">·</span>
      <span className="tokenbar__item" data-testid="token-cache">
        缓存命中 <b>{formatTokens(usage.cacheReadTokens)}</b>
      </span>
      <span className="tokenbar__sep">·</span>
      <span className="tokenbar__item" data-testid="token-rate">
        命中率 <b>{rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}</b>
      </span>
      <span className="tokenbar__spacer" />
      <span className="tokenbar__item tokenbar__item--muted" data-testid="token-calls">
        {usage.calls === 0 ? '计费输入 ' : `${String(usage.calls)} 次调用 · 计费输入 `}
        {formatTokens(billed)}
      </span>
    </div>
  )
}

export interface ComposerProps {
  readonly state: AgentState
  readonly onSend: (text: string) => void
  readonly onCancel: () => void
}

export function Composer({ state, onSend, onCancel }: ComposerProps): ReactElement {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const ime = useImeGuard()

  const usable = state.phase === 'ready' && !state.busy
  const hint = state.phase !== 'ready'
    ? (state.phase === 'error' ? 'agent 不可用' : '内核启动中…')
    : state.busy ? '正在生成…' : '就绪'

  // 回合结束后把焦点还给输入框，方便连续对话。
  useEffect(() => {
    if (usable) inputRef.current?.focus()
  }, [usable])

  // 输入框高度跟随内容（最多 190px，超过就内部滚动）。
  useEffect(() => {
    const node = inputRef.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${String(Math.min(node.scrollHeight, 190))}px`
  }, [text])

  const submit = (): void => {
    if (!usable || text.trim() === '') return
    onSend(text)
    setText('')
  }

  return (
    <div className="composer">
      <div className="composer__inner">
        <div className="composer__box">
          <textarea
            ref={inputRef}
            className="composer__input"
            data-testid="input"
            rows={1}
            value={text}
            placeholder="描述一个任务，例如：看一下 app/desktop 的结构并总结（Enter 发送，Shift+Enter 换行）"
            spellCheck={false}
            disabled={!usable}
            {...ime.compositionProps}
            onChange={(event) => { setText(event.target.value) }}
            onKeyDown={(event) => {
              // ⚠️ 必须是第一句：中文/日文输入法组字时，Enter 是「确认候选词」、
              // Escape 是「取消组字」，都不能当成发送 / 中断，否则打一个词按回车
              // 就把半成品发出去了。详见 composition.ts。
              if (ime.isImeKey(event)) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
              if (event.key === 'Escape' && state.busy) onCancel()
            }}
          />
          <div className="composer__actions">
            <span className="composer__state" data-testid="composer-state">{hint}</span>
            <button
              type="button"
              className="btn btn--stop"
              data-testid="cancel"
              hidden={!state.busy}
              onClick={onCancel}
            >
              停止
            </button>
            <button
              type="button"
              className="btn btn--primary"
              data-testid="send"
              disabled={!usable || text.trim() === ''}
              onClick={submit}
            >
              发送
            </button>
          </div>
        </div>
        <TokenBar usage={state.usage} />
      </div>
    </div>
  )
}
