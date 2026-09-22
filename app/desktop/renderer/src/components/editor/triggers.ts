/**
 * 输入框里三个触发符的**允许规则**（`/` 命令 · `@` 工具 · `#` 文件）。
 *
 * ## 规则本身
 *
 * | 触发符 | 什么时候允许 |
 * | --- | --- |
 * | `/` | **只在整条消息的第一个位置**（内核的 `matchCommand` 只认 `^/名字`，行中间的 `/` 给了也没用） |
 * | `@` | 必须是一个词的真正开头（词首 / 空白 / 左括号引号之后） |
 * | `#` | 同上 |
 *
 * ## 为什么不用 Tiptap 自带的 `allowedPrefixes` / `startOfLine`
 *
 * 它们判的是**文本节点内部**的位置（正则带 `m` 标志，`^` 是「文本节点的开头」）。
 * 而我们需要的是**文档**里的位置：chip 是 atom 节点，插在它后面的 `@` 在文本节点
 * 里看着是「行首」，在文档里其实紧贴着上一个词。所以位置判据放在 `allow` 回调里，
 * 拿到的是 ProseMirror 的**文档位置**（`range.from`），比正则可靠。
 *
 * 边界字符集合复用 {@link isBoundaryChar}（与消息记录里的 token 染色**同一份**判据）：
 * 输入框认出来的东西，落到会话记录里必须还是同一种颜色，否则两边会慢慢漂移。
 *
 * 纯逻辑（除了 import 一个纯函数），可被真值表脚本直接跑。
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
 * @param trigger - 触发符。
 * @param from - 触发符在**文档**里的位置（ProseMirror 位置，文档开头是 1）。
 * @param charBefore - 触发符前一个字符；取不到字符时传空串（见下）。
 * @returns 允许返回 `true`。
 */
export function triggerAllowed(trigger: Trigger, from: number, charBefore: string): boolean {
  // 文档位置 1 = 第一个段落里的第一个位置 = 整条消息的开头。
  const atMessageStart = from === 1
  // `/命令` 只有在消息开头才有意义：内核按 `^/` 匹配，别给出点了没用的候选。
  if (trigger === '/') return atMessageStart
  if (atMessageStart) return true
  // 空串有两种来源，都算词边界：
  //   ① 段落里的第一个位置（Shift+Enter 换行后打 `#`，前一个位置没有字符）；
  //   ② 紧挨着 chip（chip 是没有文本的 atom，`textBetween` 取不出字符）。
  // 反过来说：能取到字符时就必须是空白/括号这类真边界 —— 于是 `foo@bar`、
  // `C#code`、`https://x` 都不会弹菜单。
  if (charBefore === '') return true
  return isBoundaryChar(charBefore)
}
