/**
 * 输入框里三个触发符的允许规则（`/` 命令 · `@` 工具 · `#` 文件）。
 *
 * `/` 只在整条消息的第一个位置（内核的 `matchCommand` 只认 `^/名字`）；`@` 与 `#` 要求词首，
 * 边界判据复用 {@link isBoundaryChar}，与消息记录的 token 染色是同一份。位置判据放在
 * `allow` 回调里用文档位置（`range.from`），不用 `allowedPrefixes` / `startOfLine` ——
 * 它们判的是文本节点内部的位置，而 chip 是 atom，插在它后面的 `@` 在文档里紧贴着上一个词。
 *
 * @module Memento/desktop/renderer/src/components/editor/triggers
 */

import { isBoundaryChar } from '../rich-text-tokens.ts'

/** 触发符。 */
export type Trigger = '/' | '@' | '#'

/** 全部触发符（顺序即扩展/菜单的列举顺序）。 */
export const TRIGGERS: readonly Trigger[] = ['/', '@', '#']

/** 菜单标题里用的中文名。 */
export const TRIGGER_TITLE: Readonly<Record<Trigger, string>> = {
  '/': '命令与技能',
  '@': 'MCP 工具',
  '#': '文件',
}

/**
 * 这个触发符在这个位置允不允许弹菜单。
 *
 * `from` 是触发符在文档里的位置（ProseMirror 位置，文档开头是 1），
 * `charBefore` 是它前一个字符，取不到字符时传空串（见下）。
 */
export function triggerAllowed(trigger: Trigger, from: number, charBefore: string): boolean {
  // 文档位置 1 = 第一个段落里的第一个位置 = 整条消息的开头。
  const atMessageStart = from === 1
  // `/命令` 只有在消息开头才有意义：内核按 `^/` 匹配，别给出点了没用的候选。
  if (trigger === '/') return atMessageStart
  if (atMessageStart) return true
  // 空串有两种来源，都算词边界：段落里的第一个位置（Shift+Enter 换行后打 `#`）、
  // 紧挨着 chip（chip 是 atom，`textBetween` 取不出字符）。
  // 能取到字符时就得是空白 / 括号这类真边界 —— 于是 `foo@bar`、`C#code`、`https://x` 都不弹菜单。
  if (charBefore === '') return true
  return isBoundaryChar(charBefore)
}
