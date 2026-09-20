/**
 * 输入框里的 **chip**：一个不可编辑、整体删除的内联原子节点。
 *
 * ## 它长什么样、为什么是 atom
 *
 * 用户在输入框里用 `/` `@` `#` 选中的东西，不再是「插入一段文本」，而是插入一个
 * **chip**：
 *
 * ```
 * [用 /report 写稿]  →  ┌─────────┐
 *                       │ /report │  ← 带底色、整体选中、退格一次删掉
 *                       └─────────┘
 * ```
 *
 * `atom: true` + 不声明 `content` 是关键：ProseMirror 会因此把它整个当作一个字符
 * （`contenteditable="false"`，见 prosemirror-view 的 `NodeViewDesc.create`），
 * 光标进不去、退格删掉整个节点、方向键一次跨过去。
 *
 * ## 显示的文字 ≠ 落库的文字
 *
 * chip 上显示的是 `label`（短、能一眼认出是哪条命令/哪个文件），写进会话记录的
 * 是 `text`（完整语义，例如工具 chip 是 `用 mcp__butian__butian_rank 工具：`）。
 * 两者都在插入时由菜单决定，见 {@link ../mention-menu}。序列化规则见
 * {@link ./doc-text}。
 *
 * ## 为什么不用官方 `@tiptap/extension-mention`
 *
 * 官方的 mention 节点把「显示的文字」和「落库的文字」绑在一起（`renderLabel` /
 * `renderText`），而我们需要四种类型（命令/工具/技能/文件）各有各的样式、各有一份
 * 不同的落库文本；三个触发符还共用同一个节点（官方做法是三个 mention 实例，节点名
 * 会撞车）。所以这里自己定义节点，样式靠 class 分：`chip--command` 等。
 *
 * @module YuanMy/desktop/renderer/src/components/editor/chip
 */

import { Node, type JSONContent } from '@tiptap/core'
import { chipPlainText } from './doc-text.ts'

/** 四种 chip。顺序即文档与样式里的列举顺序。 */
export const CHIP_KINDS = ['command', 'tool', 'skill', 'file'] as const

/** chip 的类型。 */
export type ChipKind = (typeof CHIP_KINDS)[number]

/** 插进编辑器的一个 chip。 */
export interface ChipAttrs {
  /** 类型：决定样式类名与语义。 */
  readonly kind: ChipKind
  /** 界面上显示的文字（短）。 */
  readonly label: string
  /** 落到会话记录里的文字（完整语义）。 */
  readonly text: string
}

/**
 * 造一份可以喂给 `insertContent` 的 chip 内容。
 *
 * @param attrs - chip 属性。
 * @returns Tiptap 的 JSONContent。
 */
export function chipJSON(attrs: ChipAttrs): JSONContent {
  return { type: Chip.name, attrs: { kind: attrs.kind, label: attrs.label, text: attrs.text } }
}

/**
 * chip 节点本体。
 *
 * 属性都带 `parseHTML`：粘贴一段含 chip 的 HTML 回来时（同一个窗口里复制粘贴、
 * 或者以后做「引用历史消息」）能原样还原，不会退化成光秃秃的文字。
 */
export const Chip = Node.create({
  name: 'chip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: {
        default: 'file',
        parseHTML: element => element.getAttribute('data-chip') ?? 'file',
      },
      label: {
        default: '',
        parseHTML: element => element.textContent ?? '',
      },
      text: {
        default: '',
        // data-text 才是「落库文本」；缺了它（外来的 HTML）就用可见文字兜底。
        parseHTML: element => element.getAttribute('data-text') ?? element.textContent ?? '',
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-chip]' }]
  },

  renderHTML({ node }) {
    const kind = String(node.attrs.kind ?? 'file')
    // ⚠️ 不要 `mergeAttributes(HTMLAttributes)`：Tiptap 会把节点属性原样摊成 DOM 属性，
    // 于是页面上出现 `kind="command" label="/report"` 这种非标准属性（看着像坏了）。
    // chip 只需要下面这几个：`data-*` 供解析/样式/排查，class 决定长相。
    return [
      'span',
      {
        'data-chip': kind,
        'data-text': chipPlainText(node.attrs as Record<string, unknown>),
        class: `chip chip--${kind}`,
        // 显式写出来更清楚；ProseMirror 对没有 contentDOM 的节点也会这么设。
        contenteditable: 'false',
      },
      String(node.attrs.label ?? ''),
    ]
  },
})
