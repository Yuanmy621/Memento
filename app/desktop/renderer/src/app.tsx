/**
 * 界面根组件：把状态、事件与各区块拼起来。
 *
 * 布局是三行两列：左侧栏、中间对话 / 轨迹（顶部一条标签栏）、下面输入区与统计；
 * 主区右侧还能再抽出一列预览面板，对话太长时右侧出现会话刻度尺。
 * 平台与窗口材质通过 `<html>` 上的 `data-platform` / `data-vibrancy` 暴露给 CSS。
 *
 * @module Memento/desktop/renderer/app
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { railMarks, recentFiles, traceSteps, useAgent, type AppInfo } from './use-agent.ts'
import { Sidebar } from './components/sidebar.tsx'
import { Composer } from './components/composer.tsx'
import { MessageItem } from './components/message.tsx'
import { MessageRail } from './components/message-rail.tsx'
import LoadingState from './ui/beautifului/primitives/LoadingState.tsx'
import { PreviewPanel } from './components/preview-panel.tsx'
import { TraceView } from './components/trace.tsx'
import { SettingsPanel } from './components/settings-panel.tsx'
import { Breadcrumb } from './components/breadcrumb.tsx'
import { IconChat, IconPanelClose, IconPanelOpen, IconTrace } from './icons.tsx'

/** 主区顶部的两个面板。 */
type Tab = 'chat' | 'trace'

export function App(): ReactElement {
  const {
    state, send, cancel, setModel, setEffort, newSession, pickDirectory, getAppInfo,
    resumeSession, openProject, loadProjectSessions, openPath, previewRead,
    loadSettings, readFile, writeFile, restartKernel, steer, listFiles,
    loadGit, switchBranch, pullBranch,
  } = useAgent()
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  /** 设置面板是否打开。 */
  const [showSettings, setShowSettings] = useState(false)
  /** 右侧预览面板是否展开（顶栏那个按钮控制）。 */
  const [showPreview, setShowPreview] = useState(false)
  /** 预览面板正在看哪个文件；`null` = 还没选，面板显示「最近文件」列表。 */
  const [previewPath, setPreviewPath] = useState<string | null>(null)
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

  /** 右侧滑杆的刻度：一条条目一个刻度（同样是纯函数）。 */
  const marks = useMemo(() => railMarks(state.items), [state.items])

  /** 预览面板的「最近文件」：倒着捞这次会话碰过的文件，最近的在前。 */
  const recent = useMemo(() => recentFiles(state.items), [state.items])

  /**
   * 是否显示右侧会话刻度尺：只有一条消息时没什么可导航的，不占那 34px。
   * 这个判断同时决定输入框要不要跟着让位（`main-column--rail`），两处条件一致。
   */
  const showRail = tab === 'chat' && marks.length >= 2

  /**
   * 换会话 / 换项目时把预览里的文件清掉，否则面板里挂着的是上一个项目的文件，
   * 那个路径在新工作目录下多半不存在。依赖用 `state.activeKey` 而不是会话 id ——
   * 新建会话在就绪前还没有 id，那时切换也得清一次。
   */
  const activeViewKey = state.activeKey
  useEffect(() => { setPreviewPath(null) }, [activeViewKey])

  /** 在预览面板里看一个文件（对话里的文件卡片点一下就走到这里）。 */
  const openPreview = useCallback((path: string): void => {
    setPreviewPath(path)
    setShowPreview(true)
  }, [])

  /** 打开设置面板：每次都重新拉一遍数据（改完文件切回来看到的就是盘上的现状）。 */
  const openSettings = useCallback((): void => {
    setShowSettings(true)
    void loadSettings()
  }, [loadSettings])

  /**
   * 面包屑的输入：目录取内核报的 `cwd` 优先（权威值），退回视图上记的 cwd。
   * git 状态要核对探测目录，切会话之后旧仓库的分支不能挂上来。
   */
  const cwd = state.info?.cwd ?? state.cwd
  const git = state.git !== null && state.git.cwd === cwd ? state.git.status : null

  return (
    <div className="app-shell">
      <Sidebar
        state={state}
        appInfo={appInfo}
        now={now}
        runningIds={state.runningIds}
        onNewSession={() => { void newSession() }}
        onOpenSession={(sessionId, cwd) => { void resumeSession(sessionId, cwd) }}
        onOpenProject={(path) => { void openProject(path) }}
        onLoadProjectSessions={(path) => { void loadProjectSessions(path) }}
        onOpenSettings={openSettings}
      />

      <main className={`main-column${showPreview ? ' main-column--preview' : ''}${showRail ? ' main-column--rail' : ''}`}>
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
          <button
            type="button"
            className={`topbar__icon no-drag${showPreview ? ' topbar__icon--on' : ''}`}
            aria-pressed={showPreview}
            title={showPreview ? '隐藏预览面板' : '显示预览面板（报告 / 代码 / 图片）'}
            onClick={() => { setShowPreview(!showPreview) }}
          >
            {showPreview ? <IconPanelClose size={15} /> : <IconPanelOpen size={15} />}
          </button>
        </header>

        <div className="chat-area">
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
              切换会话时换 key：内容整段替换那一刻做一次淡入 + 3px 上浮，代价是内层 DOM
              重建（滚动位置由上面那个 effect 按贴底规则重算）。键取视图的键而不是
              `info.sessionId`：新建会话就绪前还没有 id，那时切过来也得换一次 key。
            */}
            <div className="messages__inner" key={state.activeKey}>
              {state.items.length === 0 && (
                state.phase === 'ready'
                  ? <div className="msg__note">描述一个任务开始对话。</div>
                  /* 内核还没就绪：`LoadingState` 是点阵加载器 + 标签 */
                  : <div className="msg__boot"><LoadingState variant="Dots" label="正在启动内核" /></div>
              )}
              {state.items.map((item) => (
                <MessageItem
                  key={item.id}
                  item={item}
                  onPreview={openPreview}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="messages">
            <div className="messages__inner">
              <TraceView steps={steps} empty={state.items.length === 0} busy={state.busy} />
            </div>
          </div>
        )}
          {/* 会话刻度尺只服务于「对话」：轨迹本身已经是紧凑的一列，不需要再导航 */}
          {showRail && (
            <MessageRail scrollRef={messagesRef} marks={marks} revision={state.items} />
          )}
        </div>

        <Composer
          state={state}
          onSteer={(value) => { void steer(value) }}
          onListFiles={(query) => { void listFiles(query) }}
          onSend={(text) => { void send(text) }}
          onCancel={() => { void cancel() }}
          onSetModel={(model) => { void setModel(model) }}
          onSetEffort={(effort) => { void setEffort(effort) }}
          onNewSession={() => { void newSession() }}
          onPickDirectory={() => { void pickDirectory() }}
          /* 面包屑（工作目录 + git 分支）走输入区那个「上方插槽」：贴着输入卡、
             跟它同宽同中心 —— 放主区网格里会多出一条自己算水平度量的规则。 */
          above={(
            <Breadcrumb
              cwd={cwd}
              home={appInfo?.home ?? ''}
              git={git}
              busy={state.gitBusy}
              onRefresh={() => { void loadGit() }}
              onSwitch={switchBranch}
              onPull={pullBranch}
            />
          )}
        />

        {showPreview && (
          <PreviewPanel
            path={previewPath}
            recent={recent}
            onSelect={setPreviewPath}
            onOpenPath={(path) => { void openPath(path) }}
            onClose={() => { setShowPreview(false) }}
            read={previewRead}
          />
        )}
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
