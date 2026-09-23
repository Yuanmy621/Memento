/**
 * Markdown 渲染：`streamdown` 的封装层。
 *
 * `plugins` 集中在这里，界面组件不用关心；外层套一个 `.sd` 作用域，把排版收敛到项目色板
 * （见 `styles/app.css` 的 `@theme` 与 `.sd` 规则）。链接被渲染成
 * `<button data-streamdown="link">`，点击走 `window.open`，由主进程的
 * `setWindowOpenHandler` 转到系统浏览器，这里不用额外处理。
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
 * `memo` 拦掉父组件每个增量的重渲染，只有 `children` 真的变了才重新解析。
 */
export const Markdown = memo(function Markdown({ children }: MarkdownProps): ReactElement {
  return (
    <div className="sd">
      <Streamdown plugins={PLUGINS}>{children}</Streamdown>
    </div>
  )
})
