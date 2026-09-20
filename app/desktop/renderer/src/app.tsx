/**
 * 界面根组件：把状态、事件与各区块拼起来。
 *
 * 布局是三行两列，主区顶部多一条**标签栏**：
 *
 *   ┌──────────┬──────────────────────────────┐
 *   │ 工作区    │ 对话 / 轨迹                    │ ← 标签栏
 *   │ 搜索      ├──────────────────────────────┤
 *   │ 会话树    │ 对话面板 或 轨迹面板            │
 *   │          ├──────────────────────────────┤
 *   │          │ 输入框 + 会话统计               │
 *   └──────────┴──────────────────────────────┘
 *
 * 平台与窗口材质通过 `<html>` 上的 data 属性暴露给 CSS：
 *   - `data-platform`：darwin 要给红绿灯留位，win32 要给窗口控件留位；
 *   - `data-vibrancy`：native 表示窗口已启用原生磨砂玻璃，侧栏要让出背景
 *     （**不是**用 CSS backdrop-filter 自己糊）。
 *
 * @module YuanMy/desktop/renderer/app
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { traceSteps, useAgent, type AppInfo } from './use-agent.ts'
import { Sidebar } from './components/sidebar.tsx'
import { Composer } from './components/composer.tsx'
import { MessageItem } from './components/message.tsx'
import { TraceView } from './components/trace.tsx'
import { SettingsPanel } from './components/settings-panel.tsx'
import { IconChat, IconTrace } from './icons.tsx'

/** 主区顶部的两个面板。 */
type Tab = 'chat' | 'trace'

export function App(): ReactElement {
  const {
    state, send, cancel, setModel, newSession, pickDirectory, getAppInfo,
    resumeSession, openProject, refreshSessions, loadProjectSessions, openPath,
    loadSettings, readFile, writeFile, restartKernel, steer, listFiles,
  } = useAgent()
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  /** 设置面板是否打开。 */
  const [showSettings, setShowSettings] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  /** 是否贴在底部：用户滚上去看历史时不要把视图拽回来。 */
  const pinnedRef = useRef(true)
  /** 会话列表要显示「几分钟前」，用一个每分钟走一格的时钟。 */
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
      document.documentElement.dataset['vibrancy'] = 'none'
    })
  }, [getAppInfo])

  // 新内容到达时自动滚到底（仅当用户本来就在底部）。
  useEffect(() => {
    const node = messagesRef.current
    if (node === null) return
    if (pinnedRef.current) node.scrollTop = node.scrollHeight
  }, [state.items])

  /** 轨迹：把会话摊平成「agent 做过的每一步」（纯函数，见 use-agent.ts）。 */
  const steps = useMemo(() => traceSteps(state.items), [state.items])

  /** 打开设置面板：每次都重新拉一遍数据（改完文件切回来看到的就是盘上的现状）。 */
  const openSettings = useCallback((): void => {
    setShowSettings(true)
    void loadSettings()
  }, [loadSettings])

  return (
    <div className="app-shell">
      <Sidebar
        state={state}
        appInfo={appInfo}
        now={now}
        onNewSession={() => { void newSession() }}
        onOpenSession={(sessionId, cwd) => { void resumeSession(sessionId, cwd) }}
        onOpenProject={(path) => { void openProject(path) }}
        onRefreshSessions={() => { void refreshSessions() }}
        onLoadProjectSessions={(path) => { void loadProjectSessions(path) }}
        onOpenSettings={openSettings}
      />

      <main className="main-column">
        <header className="topbar drag-region">
          <nav className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`tabs__tab no-drag${tab === 'chat' ? ' tabs__tab--active' : ''}`}
              aria-selected={tab === 'chat'}
              onClick={() => { setTab('chat') }}
            >
              <IconChat size={14} />
              对话
            </button>
            <button
              type="button"
              role="tab"
              className={`tabs__tab no-drag${tab === 'trace' ? ' tabs__tab--active' : ''}`}
              aria-selected={tab === 'trace'}
              title="按顺序列出 agent 的每一步：推理、工具调用、结果"
              onClick={() => { setTab('trace') }}
            >
              <IconTrace size={14} />
              轨迹
              {state.items.length > 0 && <span className="tabs__badge">{String(state.items.length)}</span>}
            </button>
          </nav>
          <span className="topbar__spacer" />
          <span className="topbar__sub" title={state.info?.cwd ?? ''}>
            {state.phase === 'ready' ? state.info?.cwd : ''}
          </span>
        </header>

        {tab === 'chat' ? (
          <div
            className="messages"
            ref={messagesRef}
            onScroll={(event) => {
              const node = event.currentTarget
              pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
            }}
          >
            {/*
              切换会话时换 key：内容整段替换的那一刻做一次很轻的淡入 + 3px 上浮，
              让「换了一批消息」看起来是一次过渡而不是一次闪变。
              代价是内层 DOM 重建 —— 滚动位置由上面那个 effect 按「贴底」规则重算。
            */}
            <div className="messages__inner" key={state.info?.sessionId ?? 'cold'}>
              {state.items.length === 0 && (
                <div className="msg__note">
                  {state.phase === 'ready' ? '描述一个任务开始对话。' : '正在启动内核…'}
                </div>
              )}
              {state.items.map((item) => (
                <MessageItem key={item.id} item={item} onOpenPath={(path) => { void openPath(path) }} />
              ))}
            </div>
          </div>
        ) : (
          <div className="messages">
            <div className="messages__inner">
              <TraceView steps={steps} empty={state.items.length === 0} />
            </div>
          </div>
        )}

        <Composer
          state={state}
          onSteer={(value) => { void steer(value) }}
          onListFiles={(query) => { void listFiles(query) }}
          onSend={(text) => { void send(text) }}
          onCancel={() => { void cancel() }}
          onSetModel={(model) => { void setModel(model) }}
          onNewSession={() => { void newSession() }}
          onPickDirectory={() => { void pickDirectory() }}
        />
      </main>
      {showSettings && (
        <SettingsPanel
          data={state.settings}
          busy={state.settingsBusy}
          onClose={() => { setShowSettings(false) }}
          onReload={() => { void loadSettings() }}
          onReadFile={readFile}
          onWriteFile={writeFile}
          onRestart={() => { void restartKernel() }}
        />
      )}
      </div>
  )
}
