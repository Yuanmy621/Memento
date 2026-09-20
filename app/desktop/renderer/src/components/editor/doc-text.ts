/**
 * 编辑器文档 → 纯文本（**唯一**的序列化实现）。
 *
 * ## 为什么要有这个文件
 *
 * 输入框现在是富文本（Tiptap），但内核收到的只能是纯文本：命令匹配
 * （`app/cli/commands.ts` 的 `matchCommand` 认 `^/名字`）、steer、会话日志
 * 全是纯文本。所以「文档 → 文本」这一步必须**可推理、可验证**。
 *
 * ## 为什么不用 `editor.getText()`
 *
 * chip 是 inline atom（没有文本内容），Tiptap 的 `getText()` 会把整个 chip
 * **静默丢掉** —— `/report` 选完再发送，内核收到的是空字符串。所以序列化只走
 * {@link docToText}，它显式认识 chip。
 *
 * ## 层级假设（只对我们的 schema 成立）
 *
 * 我们的 schema 只有两层：`doc > paragraph+ > (text | chip | hardBreak)+`。
 * 于是规则就是一句话：**顶层子节点（段落）之间用 `\n` 连接，段内直接拼接**。
 * 这不是通用序列化器 —— 换了 schema 就得跟着改，别拿它去处理别的编辑器。
 *
 * 纯逻辑，不 import 任何东西（连 ProseMirror 类型都不 import）：这样它可以被
 * `node --experimental-strip-types` 直接跑真值表（仓库里不放测试文件）。
 *
 * @module YuanMy/desktop/renderer/src/components/editor/doc-text
 */

/** 段落之间的分隔符：内核收到的是纯文本，一个段落就是一行。 */
export const BLOCK_SEPARATOR = '\n'

/**
 * 我们会用到的节点形状 —— Tiptap `JSONContent` 的子集。
 *
 * 只声明用得到的字段，且全部可选：调用方传 `editor.state.doc.toJSON()`，
 * 手写的真值表脚本也能直接造对象。
 */
export interface DocNode {
  readonly type?: string
  readonly text?: string
  readonly attrs?: Readonly<Record<string, unknown>>
  readonly content?: readonly DocNode[]
}

/**
 * 一个 chip 落到纯文本里是什么。
 *
 * `text` 是「这段话真正的样子」（例如工具 chip 是 `用 mcp__x 工具：`），
 * `label` 只是界面上显示的短标签。两者在 {@link ../mention-menu} 里一起决定。
 *
 * @param attrs - chip 节点的属性。
 * @returns 该 chip 贡献的文本（属性缺失时返回空串，不抛异常）。
 */
export function chipPlainText(attrs: Readonly<Record<string, unknown>> | undefined): string {
  const text = attrs?.text
  if (typeof text === 'string' && text !== '') return text
  // 兜底：粘贴进来的 chip 可能只有可见文字。
  const label = attrs?.label
  return typeof label === 'string' ? label : ''
}

/**
 * 段内文本（inline 层：text / chip / hardBreak）。
 *
 * @param node - 任意节点。
 * @returns 该节点贡献的文本片段。
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
 * 文档 → 纯文本。
 *
 * @param doc - `editor.state.doc.toJSON()`（或测试里手写的等价对象）。
 * @returns 纯文本；空文档返回空串（调用方自己 `trim()`）。
 */
export function docToText(doc: DocNode | null | undefined): string {
  if (doc === null || doc === undefined) return ''
  return (doc.content ?? []).map(inlineText).join(BLOCK_SEPARATOR)
}
