/**
 * 界面根组件：把状态、事件与三个区块拼起来。
 *
 * 布局是三行两列：
 *
 *   ┌──────────┬──────────────────────────────┐
 *   │          │ 顶栏（拖拽区）                │
 *   │  侧栏     ├──────────────────────────────┤
 *   │ (磨砂)    │ 消息流（可滚动）              │
 *   │          ├──────────────────────────────┤
 *   │          │ 输入区                        │
 *   └──────────┴──────────────────────────────┘
 *
 * 平台与窗口材质通过 `<html>` 上的 data 属性暴露给 CSS：
 *   - `data-platform`：darwin 要给红绿灯留位，win32 要给窗口控件留位；
 *   - `data-vibrancy`：native 表示窗口已启用原生磨砂玻璃，
 *     侧栏要让出背景（**不是**用 CSS backdrop-filter 自己糊）。
 *
 * @module YuanMy/desktop/renderer/app
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useAgent, type AppInfo } from './use-agent.ts'
import { Sidebar } from './components/sidebar.tsx'
import { TopBar } from './components/top-bar.tsx'
import { Composer } from './components/composer.tsx'
import { MessageItem } from './components/message.tsx'

export function App(): ReactElement {
  const {
    state, send, cancel, setModel, newSession, pickDirectory, getAppInfo,
    resumeSession, openProject, refreshSessions, loadProjectSessions,
  } = useAgent()
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  /** 是否贴在底部：用户滚上去看历史时不要把视图拽回来。 */
  const pinnedRef = useRef(true)
  /** 会话列表要显示「几分钟前」，用一个每分钟走一格的时钟，别每帧都取 Date.now()。 */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])

  // 版本信息与平台标记：CSS 靠 html[data-platform] / html[data-vibrancy] 分支。
  useEffect(() => {
    getAppInfo()?.then((info) => {
      setAppInfo(info)
      document.documentElement.dataset['platform'] = info.platform
      document.documentElement.dataset['vibrancy'] = info.nativeMaterial === true ? 'native' : 'none'
    }).catch(() => {
      // 拿不到版本信息不影响使用，CSS 会走不透明兜底。
      document.documentElement.dataset['vibrancy'] = 'none'
    })
  }, [getAppInfo])

  // 新内容到达时自动滚到底（仅当用户本来就在底部）。
  useEffect(() => {
    const node = messagesRef.current
    if (node === null) return
    if (pinnedRef.current) node.scrollTop = node.scrollHeight
  }, [state.items])

  return (
    <div className="app-shell">
      <Sidebar
        state={state}
        appInfo={appInfo}
        now={now}
        onNewSession={() => { void newSession() }}
        onPickDirectory={() => { void pickDirectory() }}
        onSetModel={(model) => { void setModel(model) }}
        onOpenSession={(sessionId, projectPath) => { void resumeSession(sessionId, projectPath) }}
        onOpenProject={(path) => { void openProject(path) }}
        onRefreshSessions={() => { void refreshSessions() }}
        onLoadProjectSessions={(path) => { void loadProjectSessions(path) }}
      />

      <main className="main-column">
        <TopBar state={state} onNewSession={() => { void newSession() }} />

        <div
          className="messages"
          data-testid="messages"
          ref={messagesRef}
          onScroll={(event) => {
            const node = event.currentTarget
            pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
          }}
        >
          <div className="messages__inner">
            {state.items.length === 0 && (
              <div className="msg__note" data-testid="empty-state">
                {state.phase === 'ready' ? '描述一个任务开始对话。' : '正在启动内核…'}
              </div>
            )}
            {state.items.map((item) => <MessageItem key={item.id} item={item} />)}
          </div>
        </div>

        <Composer
          state={state}
          onSend={(text) => { void send(text) }}
          onCancel={() => { void cancel() }}
        />
      </main>
    </div>
  )
}
