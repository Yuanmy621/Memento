/**
 * 输入区：多行输入 + 加号 / 权限 / 模型下拉 + 发送，下面一行会话统计。
 *
 * 三个下拉里只有一个是「真的能改东西」的，另外两个刻意做成**如实反映现状**：
 *
 *   - **模型**：真下拉。选项来自内核 `ctx.llm.listModels(provider)`（`state.models`），
 *     不是界面写死的常量；选中即 `setModel`，下一次请求生效。
 *   - **权限**：YuanMy 的本地 provider **没有沙箱、没有审批**（见根 README「已知边界」），
 *     所以这里只如实显示「完全访问」，**不做成一个能选的假开关** ——
 *     一个假的安全控件比没有控件更糟：它会让人以为有沙箱。
 *   - **加号**：放真实的会话 / 工作区动作（新建会话、打开工作目录）。
 *
 * @module YuanMy/desktop/renderer/components/composer
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useImeGuard } from '../composition.ts'
import { billedInputTokens, cacheHitRate, type AgentState } from '../use-agent.ts'
import { IconChevronDown, IconClock, IconPlus, IconSend, IconShield, IconToken, IconTurns } from '../icons.tsx'

/** 紧凑数字：1234 → 1.2k，1234567 → 1.2M。 */
function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** 耗时：≥1s 用秒，否则毫秒。 */
function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 会话统计：token 用量 / 耗时 / 轮次。 */
function StatsBar({ state }: { readonly state: AgentState }): ReactElement {
  const usage = state.usage
  const rate = cacheHitRate(usage)
  const provider = state.info === null ? '' : state.info.provider
  const model = state.info === null ? '' : state.info.model
  return (
    <div className="stats">
      <span
        className="stats__item"
        title={`未命中 ${String(usage.inputTokens)} · 命中缓存 ${String(usage.cacheReadTokens)} · 计费输入 ${String(billedInputTokens(usage))}`}
      >
        <IconToken size={13} />
        {formatTokens(usage.inputTokens + usage.cacheReadTokens)} in
        <span className="stats__dim">/</span>
        {formatTokens(usage.outputTokens)} out
        {rate !== null && <span className="stats__dim">· 命中 {(rate * 100).toFixed(0)}%</span>}
      </span>
      <span className="stats__sep">|</span>
      <span className="stats__item" title="上一回合的墙钟耗时">
        <IconClock size={13} />
        {formatDuration(state.lastTurnMs)}
      </span>
      <span className="stats__sep">|</span>
      <span className="stats__item" title="本会话已完成的回合数">
        <IconTurns size={13} />
        {String(state.turns)} 轮
      </span>
      <span className="stats__spacer" />
      <span className="stats__item stats__dim">{`${provider}/${model}`}</span>
    </div>
  )
}

/** 一个自定义下拉（不用原生 select，便于统一暗色配色）。 */
function Dropdown(props: {
  readonly icon: ReactElement
  readonly label: string
  readonly title: string
  readonly disabled?: boolean
  readonly menu?: ReactElement
}): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="dd">
      <button
        type="button"
        className="dd__trigger no-drag"
        aria-expanded={open}
        disabled={props.disabled ?? false}
        title={props.title}
        onClick={() => { setOpen((value) => !value) }}
      >
        {props.icon}
        {props.label !== '' && <span className="dd__label">{props.label}</span>}
        <IconChevronDown size={12} />
      </button>
      {open && props.menu !== undefined && (
        <>
          {/* 点空白处关掉菜单 */}
          <div className="dd__scrim" onClick={() => { setOpen(false) }} />
          <div className="dd__menu" role="menu">{props.menu}</div>
        </>
      )}
    </div>
  )
}

export interface ComposerProps {
  readonly state: AgentState
  readonly onSend: (text: string) => void
  readonly onCancel: () => void
  readonly onSetModel: (model: string) => void
  readonly onNewSession: () => void
  readonly onPickDirectory: () => void
}

export function Composer(props: ComposerProps): ReactElement {
  const { state, onSend, onCancel, onSetModel, onNewSession, onPickDirectory } = props
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

  const currentModel = state.info?.model ?? ''
  const currentName = state.models.find((model) => model.id === currentModel)?.name ?? currentModel

  return (
    <div className="composer">
      <div className="composer__inner">
        <div className="composer__box">
          <textarea
            ref={inputRef}
            className="composer__input"
            rows={1}
            value={text}
            placeholder="描述任务，或粘贴报错 / 代码（Enter 发送，Shift+Enter 换行）"
            spellCheck={false}
            disabled={!usable}
            {...ime.compositionProps}
            onChange={(event) => { setText(event.target.value) }}
            onKeyDown={(event) => {
              // ⚠️ 必须是第一句：中文/日文输入法组字时 Enter 是「确认候选词」。
              // 详见 composition.ts。
              if (ime.isImeKey(event)) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
              if (event.key === 'Escape' && state.busy) onCancel()
            }}
          />

          <div className="composer__actions">
            <Dropdown
              icon={<IconPlus size={15} />}
              label=""
              title="更多操作"
              menu={(
                <>
                  <button type="button" className="dd__item" onClick={onNewSession}>新建会话</button>
                  <button type="button" className="dd__item" onClick={onPickDirectory}>打开工作目录…</button>
                </>
              )}
            />

            <Dropdown
              icon={<IconShield size={14} />}
              label="完全访问"
              title="YuanMy 的本地 provider 没有沙箱与审批：agent 拥有当前用户的全部读写与执行权限"
              menu={(
                <div className="dd__note">
                  本地 provider 无沙箱、无审批，agent 拥有当前用户的全部权限。
                  要受限形态需替换 fs / shell provider，见根 README「已知边界」。
                </div>
              )}
            />

            <Dropdown
              icon={<span className="dd__mark" />}
              label={currentName === '' ? '模型' : currentName}
              title={`当前 ${state.info?.provider ?? ''}/${currentModel}`}
              disabled={state.phase !== 'ready' || state.models.length === 0}
              menu={(
                <>
                  {state.models.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className={`dd__item${model.id === currentModel ? ' dd__item--active' : ''}`}
                      title={model.description ?? model.id}
                      onClick={() => { onSetModel(model.id) }}
                    >
                      {model.name}
                    </button>
                  ))}
                </>
              )}
            />

            <span className="composer__spacer" />

            <span className="composer__state">{hint}</span>
            <button
              type="button"
              className="btn btn--stop"
              hidden={!state.busy}
              onClick={onCancel}
            >
              停止
            </button>
            <button
              type="button"
              className="btn btn--primary btn--send"
              disabled={!usable || text.trim() === ''}
              title="发送（Enter）"
              onClick={submit}
            >
              <IconSend size={14} />
            </button>
          </div>
        </div>

        <StatsBar state={state} />
      </div>
    </div>
  )
}
