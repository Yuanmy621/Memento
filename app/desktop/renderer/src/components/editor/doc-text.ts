/**
 * 编辑器文档 → 纯文本（唯一的序列化实现）。
 *
 * 内核只收纯文本（命令匹配见 `app/cli/commands.ts` 的 `matchCommand`、steer、会话日志），
 * 所以这一步要可推理；它不 import 任何东西，`node --experimental-strip-types` 能直接跑。
 * 不能用 `editor.getText()`：chip 是 inline atom、没有文本内容，会被静默丢掉，
 * `/report` 选完发送出去就是空字符串。schema 只有两层，顶层段落用 `\n` 连接、段内直接拼接。
 *
 * @module Memento/desktop/renderer/src/components/editor/doc-text
 */

/** 段落之间的分隔符：内核收到的是纯文本，一个段落就是一行。 */
export const BLOCK_SEPARATOR = '\n'

/**
 * 用得到的节点形状，即 `JSONContent` 的子集。
 * 字段全部可选：调用方传 `editor.state.doc.toJSON()`，手写的真值表脚本也能直接造对象。
 */
export interface DocNode {
  readonly type?: string
  readonly text?: string
  readonly attrs?: Readonly<Record<string, unknown>>
  readonly content?: readonly DocNode[]
}

/**
 * 一个 chip 落到纯文本里是什么：`text` 才是这段话真正的样子，`label` 只是界面短标签。
 * 两个属性都缺时返回空串，不抛异常。
 */
export function chipPlainText(attrs: Readonly<Record<string, unknown>> | undefined): string {
  const text = attrs?.text
  if (typeof text === 'string' && text !== '') return text
  // 兜底：粘贴进来的 chip 可能只有可见文字。
  const label = attrs?.label
  return typeof label === 'string' ? label : ''
}

/**
 * 段内文本（inline 层：text / chip / hardBreak）贡献的文本片段。
 */
function inlineText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'chip') return chipPlainText(node.attrs)
  // Shift+Enter 在段内换行：硬换行就是一个 `\n`。
  if (node.type === 'hardBreak') return BLOCK_SEPARATOR
  // 其它 inline 节点（理论上没有）：递归取内容，段内不加分隔。
  return (node.content ?? []).map(inlineText).join('')
}

/**
 * 文档 → 纯文本；入参是 `editor.state.doc.toJSON()`（或测试里手写的等价对象），
 * 空文档返回空串，调用方自己 `trim()`。
 */
export function docToText(doc: DocNode | null | undefined): string {
  if (doc === null || doc === undefined) return ''
  return (doc.content ?? []).map(inlineText).join(BLOCK_SEPARATOR)
}
