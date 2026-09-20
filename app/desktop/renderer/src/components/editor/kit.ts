/**
 * 输入框的扩展集：**刻意做小**。
 *
 * ## 为什么不用整个 StarterKit
 *
 * 这是一个聊天输入框，不是文档编辑器。StarterKit 里的输入规则会在用户正常打字时
 * 生效：`# ` 变标题、`- ` 变列表、`1. ` 变有序列表、`> ` 变引用 —— 而 `#` 正是我们的
 * 文件触发符。用户想引用一个 issue（`#123 `）却看着输入框变成大标题，是**功能变成了
 * bug**。所以这里只留「打字本身」需要的东西：
 *
 * | 保留 | 为什么 |
 * | --- | --- |
 * | Document / Paragraph / Text | 基本盘 |
 * | HardBreak | Shift+Enter 换行 |
 * | UndoRedo | Cmd+Z 撤销（插错 chip 要能撤） |
 * | TrailingNode | 保证末尾永远有可点的地方 |
 * | Placeholder | 空输入框的提示语 |
 * | Chip + 三个 suggestion | 本项目的核心 |
 *
 * 其余（标题/列表/引用/代码块/加粗/斜体/链接/下滑线/删除线/光标间隙/拖放光标）全部
 * `false`。要加功能时请**逐个**打开并想清楚它的输入规则会不会和 `/` `@` `#` 打架。
 *
 * @module YuanMy/desktop/renderer/src/components/editor/kit
 */

import { StarterKit } from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import type { Extensions } from '@tiptap/core'
import { Chip } from './chip.ts'
import { createSuggestExtensions, type SuggestController, type SuggestSource } from './suggestions.ts'

/**
 * 造出输入框要用的全部扩展。
 *
 * @param options.placeholder - 空输入框里的提示语。
 * @param options.controller - 触发符菜单的状态机。
 * @param options.source - 读最新数据源与回调。
 * @returns Tiptap 扩展数组。
 */
export function createComposerExtensions(options: {
  readonly placeholder: string
  readonly controller: SuggestController
  readonly source: () => SuggestSource
}): Extensions {
  return [
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      link: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      strike: false,
      underline: false,
      dropcursor: false,
      gapcursor: false,
    }),
    Placeholder.configure({ placeholder: options.placeholder }),
    Chip,
    ...createSuggestExtensions(options),
  ]
}
