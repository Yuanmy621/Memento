/**
 * 把「指令文本」渲染成带类型的片段 —— **组件部分**（纯逻辑在同名的 `.ts` 里）。
 *
 * 分开两个文件是为了让 {@link tokenizeRichText} 能在 Node 里直接 import 跑真值表
 * （`.tsx` 带 JSX，纯 Node 加载不了）。识别规则与取舍见 `rich-text-tokens.ts`。
 *
 * @module Memento/desktop/renderer/src/components/rich-text
 */

import type { ReactElement, ReactNode } from 'react'
import { tokenizeRichText, type TokenKind } from './rich-text-tokens.ts'

/** 重新导出纯逻辑，组件调用方只需要认这一个模块。 */

/** 每种类型对应的 class（样式在 app.css 的 `.tok--*`）。 */
const KIND_CLASS: Record<Exclude<TokenKind, 'text'>, string> = {
  command: 'tok tok--command',
  tool: 'tok tok--tool',
  file: 'tok tok--file',
  skill: 'tok tok--skill',
}

export interface RichTextProps {
  readonly text: string
  /** 追加在最外层的 class（可选）。 */
  readonly className?: string
}

/**
 * 按类型渲染一段纯文本。
 *
 * `text` 里的换行会被保留（用 `white-space: pre-wrap`），所以直接替换原来的
 * `{item.text}` 即可，不会改变排版。
 */
export function RichText(props: RichTextProps): ReactElement {
  const tokens = tokenizeRichText(props.text)
  return (
    <span className={props.className === undefined ? 'rt' : `rt ${props.className}`}>
      {tokens.map((token, index): ReactNode => (
        token.kind === 'text'
          // key 用下标是安全的：同一次渲染里顺序稳定，且这里没有重排
          ? <span key={index}>{token.value}</span>
          : <span key={index} className={KIND_CLASS[token.kind]}>{token.value}</span>
      ))}
    </span>
  )
}
