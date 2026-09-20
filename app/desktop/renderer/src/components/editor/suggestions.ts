/**
 * `/` `@` `#` 三个触发符的 Tiptap suggestion 插件 + 菜单状态机。
 *
 * ## 为什么用官方 `Suggestion`（而不是自己写 ProseMirror 插件）
 *
 * 匹配触发词、划 decoration、维护「插件是否活跃」、在光标处打字时增量重算 ——
 * 这些每一条都是坑（尤其 decoration 的映射），官方工具已经处理好了。
 * 我们只提供三件事：**候选从哪来**（`items`）、**什么位置允许**（`allow`）、
 * **选中后干什么**（`command` + chip 插入）。
 *
 * ## 键盘为什么在 composer 里处理，而不在 `render().onKeyDown`
 *
 * ProseMirror 取 `handleKeyDown` 的顺序是「**view 自己的 props 优先，然后才是各插件**」
 * （`EditorView.someProp` 先查 `_props`，再遍历 plugins）。Tiptap 把 `editorProps`
 * 直接摊进 view 的 props，所以 composer 的 `handleKeyDown` 一定先跑。既然顺序确定，
 * 键盘就只留**一条**路径：composer 里按「输入法 → 菜单 → 提交/中断」的顺序问一遍。
 * 于是 `render()` 里不再给 `onKeyDown`，免得两处各处理半截键。
 *
 * ## Esc 的语义
 *
 * Esc 走 suggestion 的 `exitSuggestion`（发一个只带 meta 的事务），插件进入
 * 「已忽略」状态：**同一个触发词内不再弹**（继续打字也不弹），打出空白后自动复位。
 * 这样 Esc 是「这次我不要菜单」，而不是「关了立刻又弹出来」。
 *
 * @module YuanMy/desktop/renderer/src/components/editor/suggestions
 */

import { Extension, type Editor, type Extensions } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Suggestion, exitSuggestion, type SuggestionProps } from '@tiptap/suggestion'
import { chipJSON, type ChipAttrs } from './chip.ts'
import { TRIGGERS, triggerAllowed, type Trigger } from './triggers.ts'
import { buildMentions, type Mention, type MentionsData } from '../mention-menu.tsx'

/** 菜单当前该显示什么（React 只读这个）。 */
export interface SuggestView {
  readonly trigger: Trigger
  readonly items: readonly Mention[]
  /** 高亮的候选下标。 */
  readonly index: number
}

/** 候选的数据来源：用**函数**取，好让插件长期存活也能读到最新值。 */
export interface SuggestSource {
  /** 当前的四类数据源。 */
  readonly data: () => MentionsData
  /** `#` 的候选是异步来的：向 host 要一批文件。 */
  readonly onFilesNeeded: (query: string) => void
}

/** 三个触发符各自的状态机名字（也是插件名，必须唯一）。 */
const EXTENSION_NAMES: Readonly<Record<Trigger, string>> = {
  '/': 'chipSuggestCommand',
  '@': 'chipSuggestTool',
  '#': 'chipSuggestFile',
}

/**
 * 菜单状态机：Tiptap 的插件回调 ↔ React 渲染。
 *
 * 插件回调是命令式的（onStart/onUpdate/onExit/键盘），React 需要的是「当前要不要
 * 显示、显示什么、高亮第几条」。这个类就是两者之间的桥：插件调它，它改完状态再
 * `notify()` 让 React 重画。**不 import React**，所以它能在真值表脚本里直接构造。
 *
 * 三个触发符**共用一个实例**：同一时刻只可能有一个菜单在显示（最近的 onStart 赢）。
 */
export class SuggestController {
  private current: SuggestView | null = null
  private props: SuggestionProps<Mention, ChipAttrs> | null = null
  /** 当前活跃的插件（Esc/关闭时要按它发退出事务）。 */
  private activeKey: PluginKey | null = null
  /**
   * 已经为哪个查询词要过文件，避免每敲一个字都发一次同样的 IPC。
   *
   * 初值必须是 `null` 而不是 `''`：空查询（刚打出 `#`）是**合法**的一次请求，
   * 用空串当初值会让它跟「已经问过」撞车，于是光打一个 `#` 永远没有候选。
   */
  private askedQuery: string | null = null
  /** 状态变化时通知 React（传 `null` 表示关掉菜单）。 */
  private readonly notify: (view: SuggestView | null) => void

  /**
   * @param notify - 状态变化时通知 React。
   */
  constructor(notify: (view: SuggestView | null) => void) {
    // 参数属性（`constructor(private x)`）在 `erasableSyntaxOnly` 下不允许，所以显式赋值。
    this.notify = notify
  }

  /** 当前状态（给 composer 渲染用）。 */
  get view(): SuggestView | null {
    return this.current
  }

  /**
   * 生成某个插件的 render 回调。
   *
   * @param trigger - 这个插件认的触发符。
   * @param pluginKey - 这个插件的 key（退出事务要用）。
   * @param source - 数据来源。
   * @returns Tiptap `render()` 需要的回调集合。
   */
  handlers(trigger: Trigger, pluginKey: PluginKey, source: SuggestSource): {
    onStart: (props: SuggestionProps<Mention, ChipAttrs>) => void
    onUpdate: (props: SuggestionProps<Mention, ChipAttrs>) => void
    onExit: () => void
  } {
    return {
      onStart: (props) => { this.open(trigger, pluginKey, props, source) },
      onUpdate: (props) => { this.open(trigger, pluginKey, props, source) },
      onExit: () => { this.exit(pluginKey) },
    }
  }

  /**
   * 选中一条候选：交给插件的 `command`（它会替换掉触发词并插入 chip）。
   *
   * @param mention - 选中的候选。
   */
  pick(mention: Mention): void {
    const props = this.props
    this.clear()
    props?.command(mention.chip)
  }

  /**
   * 鼠标悬停换高亮。
   *
   * @param index - 候选下标。
   */
  hover(index: number): void {
    const view = this.current
    if (view === null || view.index === index) return
    this.set({ ...view, index })
  }

  /**
   * 键盘导航。
   *
   * @param event - 原生键盘事件。
   * @returns `true` 表示这次按键已被菜单消费（调用方不要当提交/换行处理）。
   */
  key(event: KeyboardEvent): boolean {
    const view = this.current
    if (view === null || view.items.length === 0) return false
    const count = view.items.length
    if (event.key === 'ArrowDown') {
      this.set({ ...view, index: (view.index + 1) % count })
      return true
    }
    if (event.key === 'ArrowUp') {
      this.set({ ...view, index: (view.index - 1 + count) % count })
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      // Shift+Enter 是换行，不抢
      if (event.key === 'Enter' && event.shiftKey) return false
      const mention = view.items[view.index]
      if (mention !== undefined) this.pick(mention)
      return true
    }
    if (event.key === 'Escape') {
      this.close()
      return true
    }
    return false
  }

  /** 关掉菜单：清状态 + 让插件进入「已忽略」（同一个触发词内不再弹）。 */
  close(): void {
    const props = this.props
    const key = this.activeKey
    this.clear()
    // 只发 meta 的事务：不动文档，也就不会把光标弄丢。
    if (props !== null && key !== null) exitSuggestion(props.editor.view, key)
  }

  /**
   * 只把菜单收起来，**不**告诉插件「我忽略了」。
   *
   * 失焦（点到侧栏/标签栏）时用这个：编辑器的选区没变，插件仍然认为自己是活跃的，
   * 所以下次 onUpdate 还会把菜单弹回来 —— 这正是「点回来接着打字，菜单还在」。
   * 与 {@link close} 的区别：Esc 是「我不要这个菜单了」，失焦只是「先收起来」。
   */
  hide(): void {
    if (this.current === null) return
    this.set(null)
  }

  /**
   * `#` 的候选是异步来的：文件列表到货后，把当前菜单的候选重算一遍。
   *
   * @param source - 数据来源（会读到最新的文件列表）。
   * @param filesQuery - 这批文件对应哪个查询词（响应里带回来的）。
   */
  refresh(source: SuggestSource, filesQuery: string): void {
    const view = this.current
    const props = this.props
    if (view === null || props === null || view.trigger !== '#') return
    // 丢弃过期结果：晚到的旧查询结果不能覆盖当前菜单（use-agent 的 filesQuery 就是为此留的）。
    if (filesQuery !== props.query) return
    this.set({ ...view, items: buildMentions('#', props.query, source.data()) })
  }

  /** 插件报告「我这边匹配上了」。 */
  private open(trigger: Trigger, pluginKey: PluginKey, props: SuggestionProps<Mention, ChipAttrs>, source: SuggestSource): void {
    this.props = props
    this.activeKey = pluginKey
    if (trigger === '#' && props.query !== this.askedQuery) {
      this.askedQuery = props.query
      source.onFilesNeeded(props.query)
    }
    // 换触发词（或首次）从第一条开始；同一个菜单刷新时保留高亮位置。
    const keep = this.current !== null && this.current.trigger === trigger ? this.current.index : 0
    const index = props.items.length === 0 ? 0 : Math.min(keep, props.items.length - 1)
    this.set({ trigger, items: props.items, index })
  }

  /** 插件报告「我退出了」（触发词被删掉/打出空格/被忽略）。 */
  private exit(pluginKey: PluginKey): void {
    // 另一个触发符可能刚好接手了菜单：只有自己还活跃时才清。
    if (this.activeKey !== pluginKey) return
    this.clear()
  }

  private clear(): void {
    this.props = null
    this.activeKey = null
    this.set(null)
  }

  private set(view: SuggestView | null): void {
    this.current = view
    this.notify(view)
  }
}

/**
 * 造出三个 suggestion 扩展。
 *
 * @param options.controller - 菜单状态机。
 * @param options.source - 读最新数据源与回调（每次用的时候现取，避免闭包过期）。
 * @returns Tiptap 扩展数组。
 */
export function createSuggestExtensions(options: {
  readonly controller: SuggestController
  readonly source: () => SuggestSource
}): Extensions {
  return TRIGGERS.map((trigger) => {
    const pluginKey = new PluginKey(`YuanMyChipSuggest${trigger}`)
    return Extension.create({
      name: EXTENSION_NAMES[trigger],
      addProseMirrorPlugins() {
        return [Suggestion<Mention, ChipAttrs>({
          editor: this.editor,
          pluginKey,
          char: trigger,
          allowSpaces: false,
          // 位置判据自己来（见 triggers.ts）：默认的 allowedPrefixes 只看文本节点内部，
          // 分不清「段落开头」和「chip 后面」。
          allowedPrefixes: null,
          items: ({ query }) => buildMentions(trigger, query, options.source().data()),
          allow: ({ range, state }) =>
            triggerAllowed(trigger, range.from, charBefore(state.doc, range.from)),
          /**
           * Esc 的「我不要这个菜单」只该管**这一个触发词**。
           *
           * 插件默认只在「打出空白」或「触发位移动」时解除忽略，于是有个死角：
           * Esc 关掉菜单 → 全选删掉 → 在同一位置重新打 `#foo`，菜单仍然不弹
           * （用户会以为坏了）。所以补一条：原触发词已经不在文档里了，就解除忽略。
           */
          shouldResetDismissed: ({ state, range }) =>
            state.doc.textBetween(range.from, range.to, '\n', '\n').trim() === '',
          command: ({ editor, range, props }) => { insertChip(editor, range, props) },
          render: () => options.controller.handlers(trigger, pluginKey, options.source()),
        })]
      },
    })
  })
}

/**
 * 触发符前一个字符。
 *
 * 取不到字符时返回空串 —— 两种情形（段落第一个位置、紧挨着 chip）都在
 * {@link triggerAllowed} 里算作词边界。
 *
 * @param doc - 当前文档。
 * @param from - 触发符位置。
 * @returns 前一个字符，或空串。
 */
function charBefore(doc: PMNode, from: number): string {
  if (from <= 1) return ''
  return doc.textBetween(from - 1, from)
}

/**
 * 把候选插成 chip，并在后面留一个空格（光标落在空格后，接着就能打字）。
 *
 * @param editor - 编辑器。
 * @param range - 触发词的范围（`/rep`、`@mcp` 这一整段都会被替换掉）。
 * @param chip - 选中的候选（候选本身就是「还没插进去的 chip」）。
 */
function insertChip(editor: Editor, range: { from: number; to: number }, chip: ChipAttrs): void {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      chipJSON(chip),
      { type: 'text', text: ' ' },
    ])
    .run()
}
