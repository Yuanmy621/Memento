/**
 * 顶部条。
 *
 * 系统标题栏已经隐藏（`titleBarStyle: 'hidden'`），所以这里承担两件事：
 *   1. **窗口拖拽**：整条都是 `-webkit-app-region: drag`，里面的交互元素
 *      必须挂 `no-drag` 否则点不动；
 *   2. 放最少的运行信息与操作，把空间留给对话。
 *
 * macOS 上左侧要让开红绿灯（见 `styles/app.css` 的 `html[data-platform]`），
 * Windows 上 `titleBarOverlay` 会占住右上角，同样靠 CSS 留白。
 *
 * @module YuanMy/desktop/renderer/components/top-bar
 */

import type { ReactElement } from 'react'
import type { AgentState } from '../use-agent.ts'

export interface TopBarProps {
  readonly state: AgentState
  readonly onNewSession: () => void
}

export function TopBar({ state, onNewSession }: TopBarProps): ReactElement {
  const segments = (state.info?.cwd ?? '').split('/').filter((part) => part !== '')
  const title = segments[segments.length - 1] ?? 'YuanMy Agent'
  const subtitle = state.phase === 'ready'
    ? state.info?.sessionId ?? ''
    : state.phase === 'error' ? '内核不可用' : '正在启动内核…'

  return (
    <header className="topbar drag-region">
      <span className="topbar__title">{title}</span>
      <span className="topbar__sub">{subtitle}</span>
      <span className="topbar__spacer" />
      <button type="button" className="btn btn--ghost no-drag" onClick={onNewSession}>
        新建会话
      </button>
    </header>
  )
}
