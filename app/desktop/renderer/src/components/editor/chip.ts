/**
 * 输入框里的 chip：一个不可编辑、整体删除的内联原子节点。
 *
 * `atom: true` 且不声明 `content`，于是它被当作一个字符：光标进不去、退格删掉整个节点、
 * 方向键一次跨过去。chip 上显示 `label`，写进会话记录的是 `text`；两者在插入时由菜单
 * 决定（见 `mention-menu.tsx`），序列化见 `doc-text.ts`。
 *
 * @module Memento/desktop/renderer/src/components/editor/chip
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
 */
export function chipJSON(attrs: ChipAttrs): JSONContent {
  return { type: Chip.name, attrs: { kind: attrs.kind, label: attrs.label, text: attrs.text } }
}

/**
 * chip 节点本体。
 * 属性都带 `parseHTML`：粘贴含 chip 的 HTML 回来时能原样还原，不退化成纯文字。
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
    // 不用 `mergeAttributes(HTMLAttributes)`：它会把节点属性摊成 DOM 属性，
    // 页面上就会出现 `kind="command" label="/report"` 这种非标准属性。
    // chip 只需要下面这几个：`data-*` 供解析与排查，class 决定长相。
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
