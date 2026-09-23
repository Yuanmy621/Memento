/**
 * `/` `@` `#` 三个触发符的 suggestion 插件 + 菜单状态机。
 *
 * 匹配触发词、划 decoration、增量重算都交给官方 `Suggestion`，这里只提供候选从哪来、
 * 什么位置允许、选中后干什么。键盘只在 composer 里走一条路径：composer 的 `handleKeyDown`
 * 摊在 view 的 props 上，而 ProseMirror 取 `handleKeyDown` 时 view 的 props 优先于插件
 * （`EditorView.someProp`）。Esc 走 `exitSuggestion`：同一个触发词内不弹，打出空白后复位。
 *
 * @module Memento/desktop/renderer/src/components/editor/suggestions
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

/** 候选的数据来源：用函数取，插件长期存活也能读到最新值。 */
export interface SuggestSource {
  /** 当前的四类数据源。 */
  readonly data: () => MentionsData
  /** `#` 的候选是异步来的：向 host 要一批文件。 */
  readonly onFilesNeeded: (query: string) => void
}

/** 三个触发符各自的状态机名字，也是插件名，要唯一。 */
const EXTENSION_NAMES: Readonly<Record<Trigger, string>> = {
  '/': 'chipSuggestCommand',
  '@': 'chipSuggestTool',
  '#': 'chipSuggestFile',
}

/**
 * 菜单状态机：插件回调 ↔ React 渲染；改完状态再 `notify()` 重画，三个触发符共用一个实例。
 * 不 import React，所以能在真值表脚本里直接构造（最近的 onStart 赢）。
 */
export class SuggestController {
  private current: SuggestView | null = null
  private props: SuggestionProps<Mention, ChipAttrs> | null = null
  /** 当前活跃的插件（Esc/关闭时要按它发退出事务）。 */
  private activeKey: PluginKey | null = null
  /**
   * 已经为哪个查询词要过文件，避免每敲一个字都发一次同样的 IPC。
   * 初值是 `null` 而不是 `''`：空查询是合法请求，用空串当初值会让它跟「已经问过」撞车。
   */
  private askedQuery: string | null = null
  /** 状态变化时通知 React（传 `null` 表示关掉菜单）。 */
  private readonly notify: (view: SuggestView | null) => void

  constructor(notify: (view: SuggestView | null) => void) {
    // 参数属性（`constructor(private x)`）在 `erasableSyntaxOnly` 下不允许，所以显式赋值。
    this.notify = notify
  }

  /** 当前状态（给 composer 渲染用）。 */
  get view(): SuggestView | null {
    return this.current
  }

  /**
   * 生成某个插件的 render 回调；`pluginKey` 用于退出事务。
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
   */
  pick(mention: Mention): void {
    const props = this.props
    this.clear()
    props?.command(mention.chip)
  }

  /** 鼠标悬停换高亮。 */
  hover(index: number): void {
    const view = this.current
    if (view === null || view.index === index) return
    this.set({ ...view, index })
  }

  /**
   * 键盘导航；返回 `true` 表示这次按键已被菜单消费（调用方不要当提交 / 换行处理）。
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

  /** 关掉菜单：清状态 + 让插件进入「已忽略」（同一个触发词内不弹）。 */
  close(): void {
    const props = this.props
    const key = this.activeKey
    this.clear()
    // 只发 meta 的事务：不动文档，也就不会把光标弄丢。
    if (props !== null && key !== null) exitSuggestion(props.editor.view, key)
  }

  /**
   * 只把菜单收起来，不告诉插件「我忽略了」。
   * 失焦时用它：编辑器的选区没变，插件仍活跃，下次 onUpdate 会把菜单弹回来；Esc 则走 {@link close}。
   */
  hide(): void {
    if (this.current === null) return
    this.set(null)
  }

  /**
   * `#` 的候选是异步来的：文件列表到货后，把当前菜单的候选重算一遍。
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
 * 造出三个 suggestion 扩展；`source` 每次用的时候现取，避免闭包过期。
 */
export function createSuggestExtensions(options: {
  readonly controller: SuggestController
  readonly source: () => SuggestSource
}): Extensions {
  return TRIGGERS.map((trigger) => {
    const pluginKey = new PluginKey(`MementoChipSuggest${trigger}`)
    return Extension.create({
      name: EXTENSION_NAMES[trigger],
      addProseMirrorPlugins() {
        return [Suggestion<Mention, ChipAttrs>({
          editor: this.editor,
          pluginKey,
          char: trigger,
          // debounce: 300,
          allowSpaces: false,
          // 位置判据自己来（见 triggers.ts）：默认的 allowedPrefixes 只看文本节点内部，
          // 分不清「段落开头」和「chip 后面」。
          allowedPrefixes: null,
          items: ({ query }) => buildMentions(trigger, query, options.source().data()),
          allow: ({ range, state }) =>
            triggerAllowed(trigger, range.from, charBefore(state.doc, range.from)),
          /**
           * Esc 的「我不要这个菜单」只该管这一个触发词：插件默认只在打出空白或触发位移动时
           * 解除忽略，Esc 关掉、全选删掉、原地重打 `#foo` 就不弹了，所以原触发词不在文档里时也解除。
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
 * 触发符前一个字符，取不到时返回空串 —— 两种情形（段落第一个位置、紧挨着 chip）
 * 都在 {@link triggerAllowed} 里算作词边界。
 */
function charBefore(doc: PMNode, from: number): string {
  if (from <= 1) return ''
  return doc.textBetween(from - 1, from)
}

/**
 * 把候选插成 chip，并在后面留一个空格（光标落在空格后，接着就能打字）。
 * `range` 是触发词的范围，`/rep`、`@mcp` 这一整段都会被替换掉。
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
