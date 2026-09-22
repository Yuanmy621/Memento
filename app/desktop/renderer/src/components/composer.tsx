/**
 * 输入区：**Tiptap 富文本输入框** + 加号 / 权限 / 模型下拉 + 发送，下面一行会话统计。
 *
 * ## 输入框为什么是富文本
 *
 * 用户用 `/` `@` `#` 选出来的东西要以**看得见的样子**留在输入框里：选中的命令是一个
 * 带底色的 chip（`/report`），不是一个碰巧长得像命令的字符串。于是：
 *
 * ```
 * 打字                →  ProseMirror 文档（paragraph > text | chip | hardBreak）
 * Enter / 发送按钮     →  docToText(doc).trim()  →  纯文本  →  host/内核
 * ```
 *
 * chip 的显示文字（`label`）和落库文字（`text`）是两回事，序列化规则集中在
 * `editor/doc-text.ts` —— **别用 `editor.getText()`**：chip 是 atom，没有文本，
 * `getText()` 会把它整个丢掉，命令就等于没发。
 *
 * ## 四个下拉里有两个「真的能改东西」
 *
 *   - **模型**：真下拉。选项来自内核 `ctx.llm.listModels(provider)`（`state.models`），
 *     不是界面写死的常量；选中即 `setModel`，下一次请求生效。
 *   - **强度**：真下拉（low / high / max）。档位来自适配器对**这个模型**申报的
 *     推理强度（`ModelInfo.efforts`），只挑出「强度」三档（`off` 是关掉推理，
 *     不算强度，见 `effortChoices`）；选中即 `setEffort`，同样下一次请求生效。
 *   - **权限**：YuanMy 的本地 provider **没有沙箱、没有审批**（见根 README「已知边界」），
 *     所以这里只如实显示「完全访问」，**不做成一个能选的假开关** ——
 *     一个假的安全控件比没有控件更糟：它会让人以为有沙箱。
 *   - **加号**：放真实的会话 / 工作区动作（新建会话、打开工作目录）。
 *
 * ## 三件容易被改回去的事
 *
 * 1. **不要用 `state.busy` 去禁用输入框**。回合进行中输入框必须可用：Enter 在空闲时是
 *    发一轮，在生成中是**纠偏**（`steer`，内核在下一个 step 边界消费）。
 * 2. **输入法守卫必须是键盘处理的第一句**（`ime.isImeKeyNative`）。中文/日文组字时
 *    Enter 是「确认候选词」，拦不住就会把半成品发出去 —— 详见 `composition.ts`。
 * 3. **菜单的键要排在提交之前问**（`controller.key(event)`）。ProseMirror 取
 *    `handleKeyDown` 的顺序是「view 自己的 props 先，然后才是插件」，所以这里就是
 *    唯一的总闸：先输入法、再菜单、最后才是提交/中断。
 *
 * @module YuanMy/desktop/renderer/components/composer
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

/** 空输入框里的提示语 **/
const PLACEHOLDER = '说点什么开始我们的学习吧～'

/** 输入框最高长到多少像素，超过就内部滚动。 */
const MAX_INPUT_HEIGHT = 190

/**
 * 推理强度的**兜底档位**（适配器不申报时用）。
 *
 * 名字与 DSH 的 `Effort` 对齐（`off | low | high | max`）。刻意**不带 `off`**：
 * `off` 是「关掉推理」，不是一种强度，放进这个下拉会让人以为它是最低一档。
 * 真要它，启动时给 `--effort off`（见 README 的参数表）。
 */
const EFFORT_FALLBACK: readonly ModelEffortInfo[] = [
  { id: 'low', name: 'Low', description: '常规任务：更快、更省。' },
  { id: 'high', name: 'High', description: '默认档：大多数任务的质量 / 成本平衡点。' },
  { id: 'max', name: 'Max', description: '最难的题：质量优先，最慢也最贵。' },
]

/** 下拉里露哪三档（顺序即显示顺序）。 */
const EFFORT_IDS: readonly string[] = ['low', 'high', 'max']

/**
 * 当前模型可选的「强度」档位。
 *
 * 优先用适配器对**这个模型**申报的档位（host 的 `modelEfforts` 会带上，
 * 见 `host/index.ts`），只挑出 low / high / max；申报了但一个都没挑中
 * （比如 thinking 被关掉，只剩 `off`）就退回内置兜底 —— 下拉永远不是空的。
 * @param model - 当前模型（可能还没就绪）。
 * @returns 至少一项的档位列表。
 */
function effortChoices(model: ModelInfo | undefined): readonly ModelEffortInfo[] {
  const declared = model?.efforts
  if (declared === undefined || declared.length === 0) return EFFORT_FALLBACK
  const picked = declared.filter((effort) => EFFORT_IDS.includes(effort.id))
  return picked.length > 0 ? picked : EFFORT_FALLBACK
}

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
 * 「用量 + 缓存命中」胶囊，悬停 / 聚焦时弹出**明细卡**。
 *
 * 为什么不用原生 `title`：那个只有一行、跟不了样式、也没法分组，而这里要一口气
 * 说清 7 个数（未命中 / 命中 / 写入 / 计费输入 / 输出 / 推理 / 命中率）+
 * 最近一次调用的明细。`title` 早期版本就是那么干的，读起来是一串数字。
 *
 * 交互细节：弹出的卡片是 `.usage` 的**子元素**，所以指针移进卡片不会触发
 * `mouseleave`（那会一闪就没了）；卡片下沿还有一块透明桥接区，跨过胶囊与卡片
 * 之间那几像素的空隙时也不会关。键盘用户 `Tab` 聚焦同样能看（`tabIndex`）。
 * @param props - 会话累计用量。
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
}

/** 加号菜单的两项（真实动作，不是占位）。函数放模块级，免得每次渲染现拼数组。 */
function ACTION_ENTRIES(onNewSession: () => void, onPickDirectory: () => void): MenuEntry[] {
  return [
    { key: 'new-session', label: '新建会话', note: '清空当前上下文，开一段新对话', onSelect: onNewSession },
    { key: 'open-dir', label: '打开工作目录…', note: '换一个目录，会话按项目分开', onSelect: onPickDirectory },
  ]
}

export function Composer(props: ComposerProps): ReactElement {
  const { state, onSend, onCancel, onSteer, onListFiles, onSetModel, onSetEffort, onNewSession, onPickDirectory } = props
  const ime = useImeGuard()
  /** 触发符菜单当前该显示什么（由 SuggestController 推过来）。 */
  const [suggest, setSuggest] = useState<SuggestView | null>(null)
  /** 序列化后的纯文本：只用来决定「发送按钮能不能点」。 */
  const [plain, setPlain] = useState('')

  /**
   * 「能不能打字」只看内核好没好 —— **不看是否正在生成**。
   *
   * 这是刻意的：回合进行中不该把输入框封起来。用户随时可能想调整目标，
   * 逼他先按「停止」再重发一遍是双重成本（中断了已经跑出来的进度，还得重述）。
   */
  const ready = state.phase === 'ready'
  const hint = state.phase !== 'ready'
    ? (state.phase === 'error' ? 'agent 不可用' : '内核启动中…')
    : state.switching
      // 切换会话/项目时内核在重启：输入框**保持可打字**（草稿不会丢），
      // 只是这一小会儿按回车不提交 —— 新内核还没就绪，发过去只会失败。
      ? '正在切换…（输入会保留）'
      : state.busy ? '正在生成…（Enter 可中途调整目标）' : '就绪'

  /**
   * 数据源与回调走 ref 交给插件。
   *
   * 扩展只在首帧建一次（`useEditor` 的 options 只读第一遍），直接闭包会永远停在
   * 首帧那份「命令/技能/工具/文件」上 —— 内核启动后加载出来的命令表就永远进不了菜单。
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
        // a11y：Tiptap 本该给 `role="textbox"`，但实测这一版没落到 DOM 上（属性表里没有它），
        // 所以显式写一遍 —— 读屏软件要能认出这是个多行输入框。
        role: 'textbox',
        'aria-label': '输入消息',
        'aria-multiline': 'true',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocomplete: 'off',
      },
      handleKeyDown: (view, event) => {
        // ⚠️ 前两句必须是输入法守卫：中文/日文组字时 Enter 是「确认候选词」。
        //
        // 两道闸缺一不可：
        //   ① `view.composing` —— ProseMirror 自己的组字状态。**只有它在「合成事件」上
        //      也成立**，而合成事件正是这里最阴的坑：
        //      prosemirror-view 的 `readDOMChange` 在「DOM 变化看起来像是按了 Enter」时
        //      会自己造一个 Enter 键事件（`keyEvent(13, 'Enter')` =
        //      `document.createEvent('Event')`）再走一遍 handleKeyDown 链。那个事件
        //      **没有 `isComposing`、`isTrusted === false`**，只有 `keyCode === 13`。
        //      输入法用回车确认候选词时，提交动作恰好产生一次「新增段落」的 DOM 变化，
        //      于是这个合成 Enter 打进来 —— 只信 `event.isComposing` 的守卫会放行，
        //      半成品就被当成消息发出去了（本项目实测踩到过）。
        //   ② 事件自带的信号（真事件的 `isComposing` / `keyCode 229` / 刚结束组字），
        //      见 composition.ts。组字事件挂在外层 `.composer__box` 上冒泡过来。
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
        // 点到别处（侧栏、标签栏）时先把菜单收起来：编辑器的选区没变，插件自己不会退出，
        // 不收就会在输入框上方留一个悬空菜单。这里只收起，不「忽略」——回来接着打字还会弹。
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
   * 提交。
   *
   * 空闲 → 正常发一轮；**生成中 → 中途调整目标**（内核的 `steer`，
   * 下一个 step 边界生效）。两条路都不清空输入框以外的任何东西。
   */
  const submit = (): void => {
    if (!ready) return
    // 切换内核期间不提交：留着草稿，等新会话就绪后用户再按一次即可。
    // （不做「排队自动发」是因为历史帧可能晚于 ready 到达，先发的消息会被历史覆盖掉。）
    if (state.switching) return
    const text = docToText(editor.state.doc.toJSON()).trim()
    if (text === '') return
    if (state.busy) onSteer(text)
    else onSend(text)
    // 清空输入框。`clearContent()` 默认 emitUpdate=true，发送按钮的禁用态跟着刷新。
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

  // 可编辑性跟着内核状态走。注意**不跟 busy 走**：回合进行中照样能打字（见模块注释）。
  useEffect(() => {
    editor.setEditable(ready)
  }, [editor, ready])

  // `#` 的候选是异步来的（host 的 `files:list`）：文件列表到货后重算当前菜单。
  // 不重算的话，光打一个 `#` 会一直是空菜单 —— 候选是「先开菜单、后到货」的。
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
   * 强度档位与当前值。
   *
   * 档位跟着**当前模型**走（适配器可能只给某个模型开高档位）；当前值来自
   * `ready` / `effort-changed` 帧。取不到（老 host 没有这个字段）时按默认档显示。
   */
  const modelInfo = state.models.find((model) => model.id === currentModel)
  const efforts = effortChoices(modelInfo)
  const currentEffort = state.info?.effort ?? 'high'
  const effortLabel = efforts.find((effort) => effort.id === currentEffort)?.name ?? currentEffort

  return (
    <div className="composer">
      <div className="composer__inner">
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
              title="YuanMy 的本地 provider 没有沙箱与审批：agent 拥有当前用户的全部读写与执行权限"
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
            {/* 停止 / 发送：Beautiful UI 的 Button（accent = 主操作，secondary = 次操作） */}
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
