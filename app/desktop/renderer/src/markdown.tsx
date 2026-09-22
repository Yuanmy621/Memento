/**
 * Markdown 渲染：Streamdown 的封装层。
 *
 * 为什么单独封一层：
 *   1. `plugins` 与未来的主题/插件开关集中在这里，界面组件不用关心；
 *   2. Streamdown 输出的根节点自己带 `bg-background text-foreground`，
 *      我们在外层套一个 `.sd` 作用域，把排版收敛到项目的 Codex 色板
 *      （见 `styles/app.css` 的 `@theme` 别名与 `.sd` 规则）；
 *   3. 链接在 Streamdown 里被渲染成 `<button data-streamdown="link">`（它有
 *      link safety 机制），点击走 `window.open`，由主进程的
 *      `setWindowOpenHandler` 转到系统浏览器 —— 这里不用额外处理。
 *
 * @module Memento/desktop/renderer/markdown
 */

import { memo, type ReactElement } from 'react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'

/** 插件实例是稳定的，放在模块级避免每次渲染重建。 */
const PLUGINS = { code, cjk }

/** 组件属性。 */
export interface MarkdownProps {
  /** Markdown 源码（流式输出时每次增量都会变）。 */
  readonly children: string
}

/**
 * 渲染一段 Markdown。
 *
 * `memo` 很重要：流式输出时父组件每个增量都会重渲染，
 * 而这里只有 `children` 真的变了才需要重新解析 Markdown。
 */
export const Markdown = memo(function Markdown({ children }: MarkdownProps): ReactElement {
  return (
    <div className="sd">
      <Streamdown plugins={PLUGINS}>{children}</Streamdown>
    </div>
  )
})
