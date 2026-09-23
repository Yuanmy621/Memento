/**
 * 输入区：富文本输入框（`@tiptap/react` + ProseMirror）+ 各下拉 + 发送，下面一行会话统计。
 *
 * chip 的显示文字（`label`）与落库文字（`text`）是两份，序列化规则集中在 `editor/doc-text.ts`：
 * 不能用 `editor.getText()`（chip 是 atom，会被整个丢掉）。回合进行中输入框保持可用，
 * Enter 在空闲时发一轮，在生成中是 `steer` 纠偏。
 *
 * @module Memento/desktop/renderer/components/composer
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { useImeGuard } from '../composition.ts'
import { MentionMenu } from './mention-menu.tsx'
import { docToText } from './editor/doc-text.ts'
import { createComposerExtensions } from './editor/kit.ts'
import { SuggestController, type SuggestSource, type SuggestView } from './editor/suggestions.ts'
import { TRIGGER_TITLE } from './editor/triggers.ts'
import {
  billedInputTokens, cacheHitRate,
  type AgentState, type ModelEffortInfo, type ModelInfo, type UsageTotals,
} from '../use-agent.ts'
import { Menu, type MenuEntry } from './menu.tsx'
import { Button } from '../ui/beautifului/atoms/Button.tsx'
import { ValuePill } from '../ui/beautifului/atoms/ValuePill.tsx'
import { IconClock, IconGauge, IconPlus, IconSend, IconShield, IconToken, IconTurns } from '../icons.tsx'

/** 空输入框里的提示语。 */
const PLACEHOLDER = '说点什么开始我们的学习吧～'

/** 输入框最高长到多少像素，超过就内部滚动。 */
const MAX_INPUT_HEIGHT = 190

/**
 * 推理强度的兜底档位（适配器不申报时用），与内核的 `Effort` 同名（`off | low | high | max`）；
 * 不含 `off` —— 那是「关掉推理」而不是一种强度，放进来会被当成最低一档。
 */
const EFFORT_FALLBACK: readonly ModelEffortInfo[] = [
  { id: 'low', name: 'Low', description: '常规任务：更快、更省。' },
  { id: 'high', name: 'High', description: '默认档：大多数任务的质量 / 成本平衡点。' },
  { id: 'max', name: 'Max', description: '最难的题：质量优先，最慢也最贵。' },
]

/** 下拉里露哪三档（顺序即显示顺序）。 */
const EFFORT_IDS: readonly string[] = ['low', 'high', 'max']

/**
 * 当前模型可选的强度档位：优先用适配器对这个模型申报的档位（host 的 `modelEfforts`，
 * 见 `host/index.ts`），只挑 low / high / max；模型还没就绪或一个都没挑中时退回兜底，
 * 返回值至少一项，下拉不为空。
 */
function effortChoices(model: ModelInfo | undefined): readonly ModelEffortInfo[] {
  const declared = model?.efforts
  if (declared === undefined || declared.length === 0) return EFFORT_FALLBACK
  const picked = declared.filter((effort) => EFFORT_IDS.includes(effort.id))
  return picked.length > 0 ? picked : EFFORT_FALLBACK
}

/** 紧凑数字：1234 显示为 1.2k，1234567 显示为 1.2M。 */
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

/** 明细卡里的一行：左边标签、右边数字（可选一行小字说明）。 */
function UsageRow(props: {
  readonly label: string
  readonly value: string
  readonly note?: string
  /** 关心程度更高的一行（计费输入 / 输出）用更亮的字色。 */
  readonly strong?: boolean
  readonly title?: string
}): ReactElement {
  return (
    <span className={`usage__row${props.strong === true ? ' usage__row--strong' : ''}`} title={props.title}>
      <span className="usage__key">{props.label}</span>
      <span className="usage__val">{props.value}</span>
      {props.note !== undefined && <span className="usage__note">{props.note}</span>}
    </span>
  )
}

/**
 * 「用量 + 缓存命中」胶囊，悬停 / 聚焦时弹出明细卡。
 *
 * 卡片是 `.usage` 的子元素，指针移进卡片不会触发 `mouseleave`；卡片下沿的透明桥接区
 * 让指针跨过胶囊与卡片之间的空隙时也不会关。原生 `title` 只有一行、无法分组。
 */
function UsageDetail({ usage }: { readonly usage: UsageTotals }): ReactElement {
  const [open, setOpen] = useState(false)
  const billed = billedInputTokens(usage)
  const rate = cacheHitRate(usage)
  const last = usage.last
  /** 占「计费输入」的比例；没有输入时给 `—` 而不是假的 0%。 */
  const share = (part: number): string => (billed <= 0 ? '—' : `${((part / billed) * 100).toFixed(0)}%`)
  return (
    <span
      className="usage"
      tabIndex={0}
      aria-label="token 用量明细"
      onMouseEnter={() => { setOpen(true) }}
      onMouseLeave={() => { setOpen(false) }}
      onFocus={() => { setOpen(true) }}
      onBlur={() => { setOpen(false) }}
    >
      <ValuePill className="stats__pill">
        <IconToken size={13} />
        {formatTokens(usage.inputTokens + usage.cacheReadTokens)} in
        <span className="stats__dim">/</span>
        {formatTokens(usage.outputTokens)} out
        {rate !== null && <span className="stats__dim">· 命中 {(rate * 100).toFixed(0)}%</span>}
      </ValuePill>
      {open && (
        <span className="usage__pop" role="tooltip">
          <span className="usage__head">
            本会话累计
            <span className="usage__sub">{`${String(usage.calls)} 次模型调用`}</span>
          </span>
          <span className="usage__grid">
            <UsageRow label="输入（未命中缓存）" value={String(usage.inputTokens)} />
            <UsageRow label="缓存命中（读取）" value={String(usage.cacheReadTokens)} note={share(usage.cacheReadTokens)} />
            <UsageRow label="缓存写入" value={String(usage.cacheWriteTokens)} note={share(usage.cacheWriteTokens)} />
            <UsageRow label="计费输入合计" value={String(billed)} strong title="未命中 + 命中 + 写入：这次会话真正送进模型的提示词总量" />
            <UsageRow label="输出" value={String(usage.outputTokens)} strong note={usage.reasoningTokens > 0 ? `含推理 ${formatTokens(usage.reasoningTokens)}` : undefined} />
            <UsageRow label="命中率" value={rate === null ? '—' : `${(rate * 100).toFixed(1)}%`} title="命中缓存 ÷ 计费输入" />
          </span>
          {last !== null && (
            <>
              <span className="usage__head usage__head--sub">最近一次调用</span>
              <span className="usage__grid">
                <UsageRow label="输入（未命中）" value={String(last.inputTokens)} />
                <UsageRow label="缓存命中" value={String(last.cacheReadTokens ?? 0)} />
                <UsageRow label="缓存写入" value={String(last.cacheWriteTokens ?? 0)} />
                <UsageRow label="输出" value={String(last.outputTokens)} />
              </span>
            </>
          )}
          <span className="usage__foot">
            DSH 的计数是互斥的：未命中 / 命中 / 写入分开记，「计费输入合计」才是完整提示词量。
          </span>
        </span>
      )}
    </span>
  )
}

/** 会话统计：token 用量 / 耗时 / 轮次。 */
function StatsBar({ state }: { readonly state: AgentState }): ReactElement {
  const provider = state.info === null ? '' : state.info.provider
  const model = state.info === null ? '' : state.info.model
  return (
    <div className="stats">
      <UsageDetail usage={state.usage} />
      <ValuePill className="stats__pill" title="上一回合的墙钟耗时">
        <IconClock size={13} />
        {formatDuration(state.lastTurnMs)}
      </ValuePill>
      <ValuePill className="stats__pill" title="本会话已完成的回合数">
        <IconTurns size={13} />
        {String(state.turns)} 轮
      </ValuePill>
      <span className="stats__spacer" />
      <span className="stats__item stats__dim">{`${provider}/${model}`}</span>
    </div>
  )
}

export interface ComposerProps {
  readonly state: AgentState
  readonly onSend: (text: string) => void
  readonly onCancel: () => void
  readonly onSetModel: (model: string) => void
  /** 改推理强度（low / high / max），下一次请求生效。 */
  readonly onSetEffort: (effort: string) => void
  /** 中途调整目标（插给正在跑的回合）。 */
  readonly onSteer: (text: string) => void
  /** 要一批 `#` 候选文件。 */
  readonly onListFiles: (query: string) => void
  readonly onNewSession: () => void
  readonly onPickDirectory: () => void
  /**
   * 输入卡正上方那一行（`app.tsx` 把面包屑塞进来）。做成插槽而不是直接 import：
   * 数据都在 `App` 手里，这里只出一个行位，面包屑因此自动拿到输入卡的水平度量。
   */
  readonly above?: ReactElement
}

/** 加号菜单的两项。函数放模块级，免得每次渲染现拼数组。 */
function ACTION_ENTRIES(onNewSession: () => void, onPickDirectory: () => void): MenuEntry[] {
  return [
    { key: 'new-session', label: '新建会话', note: '清空当前上下文，开一段新对话', onSelect: onNewSession },
    { key: 'open-dir', label: '打开工作目录…', note: '换一个目录，会话按项目分开', onSelect: onPickDirectory },
  ]
}

export function Composer(props: ComposerProps): ReactElement {
  const { state, onSend, onCancel, onSteer, onListFiles, onSetModel, onSetEffort, onNewSession, onPickDirectory, above } = props
  const ime = useImeGuard()
  /** 触发符菜单当前该显示什么（由 SuggestController 推过来）。 */
  const [suggest, setSuggest] = useState<SuggestView | null>(null)
  /** 序列化后的纯文本：只用来决定「发送按钮能不能点」。 */
  const [plain, setPlain] = useState('')

  /**
   * 能不能打字只看内核好没好，不看是否正在生成：回合进行中封住输入框，用户想调整
   * 目标就得先停止再重述，代价是丢掉已经跑出来的进度。所以不能用 `state.busy` 禁用它。
   */
  const ready = state.phase === 'ready'
  const hint = state.phase !== 'ready'
    ? (state.phase === 'error' ? 'agent 不可用' : '内核启动中…')
    : state.switching
      // 切换会话 / 项目时内核在重启：输入框保持可打字（草稿不会丢），
      // 只是这一小会儿按回车不提交 —— 新内核还没就绪，发过去只会失败。
      ? '正在切换…（输入会保留）'
      : state.busy ? '正在生成…（Enter 可中途调整目标）' : '就绪'

  /**
   * 数据源与回调走 ref 交给插件：扩展只在首帧建一次（`useEditor` 的 options 只读
   * 第一遍），直接闭包会永远停在首帧那份命令 / 技能 / 工具 / 文件上。
   */
  const sourceRef = useRef<SuggestSource>({
    data: () => ({ commands: [], skills: [], tools: [], files: [] }),
    onFilesNeeded: () => {},
  })
  sourceRef.current = {
    data: () => ({
      commands: state.info?.commands ?? [],
      skills: state.info?.skills ?? [],
      tools: state.info?.tools ?? [],
      files: state.files,
    }),
    onFilesNeeded: onListFiles,
  }

  const controller = useMemo(() => new SuggestController(setSuggest), [])

  /**
   * 提交 / 中断也走 ref：`editorProps` 同样只在建 view 时用一次，
   * 里面的闭包会一直停在首帧的 `state.busy` 与回调上。
   */
  const actionsRef = useRef<{ submit: () => void; cancel: () => void }>({
    submit: () => {},
    cancel: () => {},
  })

  const extensions = useMemo(
    () => createComposerExtensions({ placeholder: PLACEHOLDER, controller, source: () => sourceRef.current }),
    [controller],
  )

  const editor = useEditor({
    extensions,
    editable: ready,
    editorProps: {
      attributes: {
        class: 'composer__input',
        // a11y：`role="textbox"` 显式写一遍 —— 编辑器不保证把它落到 DOM 上，
        // 读屏软件靠它认出这是个多行输入框。
        role: 'textbox',
        'aria-label': '输入消息',
        'aria-multiline': 'true',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocomplete: 'off',
      },
      handleKeyDown: (view, event) => {
        // 前两句是输入法守卫：组字时 Enter 是「确认候选词」，拦不住会把半成品发出去。
        // 两道闸缺一不可：`view.composing` 在 prosemirror-view 自造的合成 Enter
        // （`keyEvent(13, 'Enter')`，无 `isComposing`）上同样成立，另一半见 `composition.ts`。
        if (view.composing || ime.isImeKeyNative(event)) return false
        // 菜单开着时方向键/回车/Tab/Esc 归菜单（它自己会 preventDefault）。
        // ProseMirror 先问 view props 再问插件，所以这里就是唯一的总闸。
        if (controller.key(event)) return true
        if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          actionsRef.current.submit()
          return true
        }
        // 菜单没开时 Esc 才是「中断本回合」；菜单开着时上面已经消费掉了。
        if (event.key === 'Escape') actionsRef.current.cancel()
        return false
      },
      handleDOMEvents: {
        // 点到别处（侧栏、标签栏）时先收起菜单：编辑器选区没变，插件自己不会退出，
        // 不收会在输入框上方留一个悬空菜单。这里只收起，回来接着打字还会弹。
        blur: () => {
          controller.hide()
          return false
        },
      },
    },
    onUpdate: ({ editor: instance }) => {
      setPlain(docToText(instance.state.doc.toJSON()))
    },
  })

  /**
   * 提交：空闲时正常发一轮，生成中则中途调整目标（内核的 `steer`，下一个 step
   * 边界生效）。
   */
  const submit = (): void => {
    if (!ready) return
    // 切换内核期间不提交：留着草稿，等新会话就绪后用户再按一次。
    // 不做「排队自动发」：历史帧可能晚于 ready 到达，先发的消息会被历史覆盖掉。
    if (state.switching) return
    const text = docToText(editor.state.doc.toJSON()).trim()
    if (text === '') return
    if (state.busy) onSteer(text)
    else onSend(text)
    // `clearContent()` 默认 emitUpdate=true，发送按钮的禁用态跟着刷新。
    editor.commands.clearContent()
    editor.commands.focus()
  }
  actionsRef.current = {
    submit,
    cancel: () => { if (state.busy) onCancel() },
  }

  // 内核就绪后把焦点还给输入框，方便连续对话。
  useEffect(() => {
    if (ready) editor.commands.focus()
  }, [editor, ready])

  // 可编辑性跟着内核状态走，不跟 busy 走：回合进行中照样能打字。
  useEffect(() => {
    editor.setEditable(ready)
  }, [editor, ready])

  // `#` 的候选是异步来的（host 的 `files:list`）：列表到货后重算当前菜单，
  // 否则光打一个 `#` 会一直是空菜单 —— 候选是「先开菜单、后到货」的。
  useEffect(() => {
    controller.refresh(sourceRef.current, state.filesQuery)
  }, [controller, state.files, state.filesQuery])

  // 输入框高度跟随内容（最多 MAX_INPUT_HEIGHT，超过就内部滚动）。
  useEffect(() => {
    const node: HTMLElement | undefined = editor.view.dom
    if (node === undefined) return
    node.style.height = 'auto'
    node.style.height = `${String(Math.min(node.scrollHeight, MAX_INPUT_HEIGHT))}px`
  }, [editor, plain])

  const currentModel = state.info?.model ?? ''
  const currentName = state.models.find((model) => model.id === currentModel)?.name ?? currentModel
  /**
   * 强度档位与当前值：档位跟着当前模型走（适配器可能只给某个模型开高档位），
   * 当前值来自 `ready` / `effort-changed` 帧，取不到时按默认档显示。
   */
  const modelInfo = state.models.find((model) => model.id === currentModel)
  const efforts = effortChoices(modelInfo)
  const currentEffort = state.info?.effort ?? 'high'
  const effortLabel = efforts.find((effort) => effort.id === currentEffort)?.name ?? currentEffort

  return (
    <div className="composer">
      <div className="composer__inner">
        {/* 面包屑（工作目录 + git 分支）：贴着输入卡上沿，跟卡片同宽同中心 */}
        {above}
        {/* 组字事件从 contenteditable 冒泡到这里：输入法守卫的第三个信号靠它（见 composition.ts） */}
        <div className="composer__box" {...ime.compositionProps}>
          <EditorContent className="composer__editor" editor={editor} />

          <MentionMenu
            title={suggest === null ? '' : `${TRIGGER_TITLE[suggest.trigger]} · ↑↓ 选择 · Enter 确认`}
            mentions={suggest?.items ?? []}
            active={suggest?.index ?? 0}
            onPick={(mention) => { controller.pick(mention) }}
            onHover={(index) => { controller.hover(index) }}
          />

          <div className="composer__actions">
            <Menu
              icon={<IconPlus size={15} />}
              title="更多操作"
              caret
              entries={ACTION_ENTRIES(onNewSession, onPickDirectory)}
              width={200}
            />

            <Menu
              icon={<IconShield size={14} />}
              label="完全访问"
              title="Memento 的本地 provider 没有沙箱与审批：agent 拥有当前用户的全部读写与执行权限"
              caret
              width={300}
              entries={[{
                key: 'note',
                kind: 'block',
                label: '本地 provider 无沙箱、无审批，agent 拥有当前用户的全部权限。'
                  + '要受限形态需替换 fs / shell provider，见根 README「已知边界」。',
              }]}
            />

            <Menu
              icon={<span className="menu__mark" />}
              label={currentName === '' ? '模型' : currentName}
              title={`当前 ${state.info?.provider ?? ''}/${currentModel}`}
              caret
              width={240}
              disabled={state.phase !== 'ready' || state.models.length === 0}
              entries={state.models.map((model): MenuEntry => ({
                key: model.id,
                label: model.name,
                note: model.description,
                hint: model.description ?? model.id,
                active: model.id === currentModel,
                onSelect: () => { onSetModel(model.id) },
              }))}
            />

            {/* 推理强度：档位来自适配器对这个模型的申报（见 effortChoices） */}
            <Menu
              icon={<IconGauge size={14} />}
              label={effortLabel}
              title={`推理强度：${currentEffort}（下一次请求生效）`}
              caret
              width={260}
              disabled={state.phase !== 'ready' || state.switching}
              entries={efforts.map((effort): MenuEntry => ({
                key: effort.id,
                label: effort.name,
                note: effort.description,
                hint: effort.description ?? effort.id,
                active: effort.id === currentEffort,
                onSelect: () => { onSetEffort(effort.id) },
              }))}
            />

            <span className="composer__spacer" />

            <span className="composer__state">{hint}</span>
            {/* 停止 / 发送：`accent` 是主操作，`secondary` 是次操作 */}
            {state.busy && (
              <Button variant="secondary" size="sm" className="composer__stop" onClick={onCancel}>
                停止
              </Button>
            )}
            <Button
              variant="accent"
              size="sm"
              className="composer__send"
              disabled={!ready || state.switching || plain.trim() === ''}
              title={state.switching ? '正在切换会话…' : (state.busy ? '中途调整目标（Enter）' : '发送（Enter）')}
              onClick={submit}
            >
              <IconSend size={14} />
            </Button>
          </div>
        </div>

        <StatsBar state={state} />
      </div>
    </div>
  )
}
