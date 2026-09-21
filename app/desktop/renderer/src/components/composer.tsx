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
 * ## 三个下拉里只有一个「真的能改东西」
 *
 *   - **模型**：真下拉。选项来自内核 `ctx.llm.listModels(provider)`（`state.models`），
 *     不是界面写死的常量；选中即 `setModel`，下一次请求生效。
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
import { billedInputTokens, cacheHitRate, type AgentState } from '../use-agent.ts'
import { Menu, type MenuEntry } from './menu.tsx'
import { Button } from '../ui/beautifului/atoms/Button.tsx'
import { ValuePill } from '../ui/beautifului/atoms/ValuePill.tsx'
import { IconClock, IconPlus, IconSend, IconShield, IconToken, IconTurns } from '../icons.tsx'

/** 空输入框里的提示语 **/
const PLACEHOLDER = '说点什么开始我们的学习吧～'

/** 输入框最高长到多少像素，超过就内部滚动。 */
const MAX_INPUT_HEIGHT = 190

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
      <ValuePill
        className="stats__pill"
        title={`未命中 ${String(usage.inputTokens)} · 命中缓存 ${String(usage.cacheReadTokens)} · 计费输入 ${String(billedInputTokens(usage))}`}
      >
        <IconToken size={13} />
        {formatTokens(usage.inputTokens + usage.cacheReadTokens)} in
        <span className="stats__dim">/</span>
        {formatTokens(usage.outputTokens)} out
        {rate !== null && <span className="stats__dim">· 命中 {(rate * 100).toFixed(0)}%</span>}
      </ValuePill>
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
  const { state, onSend, onCancel, onSteer, onListFiles, onSetModel, onNewSession, onPickDirectory } = props
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
