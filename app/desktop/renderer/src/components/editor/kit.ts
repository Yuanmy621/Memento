/**
 * 输入框的扩展集，只管打字本身需要的东西。
 *
 * 标题 / 列表 / 引用 / 代码块这类输入规则会和触发符打架：`# ` 变标题、`- ` 变列表，
 * 而 `#` 正是文件触发符，用户想引用一个 issue 却看着输入框变成大标题。所以只留打字本身
 * 需要的节点（Document / Paragraph / Text / HardBreak / UndoRedo / TrailingNode /
 * Placeholder）加上 Chip 与三个 suggestion；新增扩展时逐个确认不与 `/` `@` `#` 打架。
 *
 * @module Memento/desktop/renderer/src/components/editor/kit
 */

import { StarterKit } from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import type { Extensions } from '@tiptap/core'
import { Chip } from './chip.ts'
import { createSuggestExtensions, type SuggestController, type SuggestSource } from './suggestions.ts'

/**
 * 造出输入框要用的全部扩展。
 *
 * `placeholder` 是空输入框里的提示语，`controller` 与 `source` 供三个 suggestion 扩展使用。
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
