/**
 * 左侧边栏：「工作区」标题 + 搜索 + 新会话 + 会话列表。
 *
 * 结构上保留上一版的**项目 → 会话**树（默认视图），并在顶部加了搜索：
 * 一旦输入关键词就切成**平铺的搜索结果**（跨项目），因为「找某个会话」
 * 时层级反而是干扰。搜索匹配会话标题与 id。
 *
 * 每条会话显示：标题 + 最后更新时间；当前会话灰色高亮 + 左侧竖标。
 *
 * 视觉上刻意不放的东西（重复或只在排查时才有用）：模型名（输入区那份）、
 * 会话 id（树里已高亮）、工具清单（底栏点一下展开）、凭据（只在缺失时提示）。
 *
 * 顶部一段是窗口**拖拽区**：系统标题栏已隐藏，靠它拖动窗口。
 *
 * @module YuanMy/desktop/renderer/components/sidebar
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useImeGuard } from '../composition.ts'
import { IconChat, IconPlus, IconSearch } from '../icons.tsx'
import type { AgentState, AppInfo, ProjectSummary, SessionSummary } from '../use-agent.ts'

/** 相对时间：列表里「多久以前」比绝对时间更有用。 */
function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} 分钟前`
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))} 小时前`
  return `${String(Math.floor(seconds / 86400))} 天前`
}

/** 一条会话。 */
function SessionRow(props: {
  readonly session: SessionSummary
  readonly now: number
  readonly subtitle?: string
  readonly onOpen: () => void
}): ReactElement {
  const { session, now, subtitle, onOpen } = props
  return (
    <li className="tree__leaf">
      <button
        type="button"
        className={`session${session.current ? ' session--current' : ''}`}
        title={`${session.id}\n${String(session.turns)} 个回合 · ${new Date(session.updatedAt).toLocaleString()}`}
        onClick={() => { if (!session.current) onOpen() }}
      >
        <span className="session__icon"><IconChat size={13} /></span>
        <span className="session__body">
          <span className="session__title">{session.title === '' ? '（暂无消息）' : session.title}</span>
          <span className="session__meta">
            {subtitle === undefined ? relativeTime(session.updatedAt, now) : `${subtitle} · ${relativeTime(session.updatedAt, now)}`}
          </span>
        </span>
      </button>
    </li>
  )
}

export interface SidebarProps {
  readonly state: AgentState
  readonly appInfo: AppInfo | null
  readonly now: number
  readonly onNewSession: () => void
  readonly onOpenSession: (sessionId: string, cwd?: string) => void
  readonly onOpenProject: (path: string) => void
  readonly onRefreshSessions: () => void
  readonly onLoadProjectSessions: (path: string) => void
  /** 打开设置面板（技能 / 命令 / MCP）。 */
  readonly onOpenSettings: () => void
}

export function Sidebar(props: SidebarProps): ReactElement {
  const {
    state, appInfo, now, onNewSession,
    onOpenSession, onOpenProject, onRefreshSessions, onLoadProjectSessions, onOpenSettings,
  } = props
  const [showTools, setShowTools] = useState(false)
  const [query, setQuery] = useState('')
  /** 其他项目里「被点开过」的路径。 */
  const [expandedProjects, setExpandedProjects] = useState<readonly string[]>([])
  /** 当前项目默认展开，用户可以手动折起来。 */
  const [currentOpen, setCurrentOpen] = useState(true)
  /**
   * 本「内核代次」里已经发起过读取的项目路径。
   *
   * 用途见下面那个 effect：重启后要把已展开项目的会话补回来，但读**失败**时
   * `projectSessions[path]` 会一直是 undefined，没有这个记账就会无限重试。
   * 内核一重启（phase 回到 booting）就清空 —— 新内核下值得再试一次。
   */
  const requestedProjects = useRef<readonly string[]>([])
  const ime = useImeGuard()
  const info = state.info
  const tools = info?.tools ?? []

  /**
   * 内核重启后，把**已展开项目**的会话补回来。
   *
   * `restarting` 会清空 `projectSessions`（那些数据属于上一个内核），但
   * `expandedProjects` 是本组件的 state，不跟着清。于是换会话 / 换项目之后，
   * 之前展开的项目会变成**空列表**，用户必须手动折叠再展开才看得到会话 ——
   * 看起来就像「切过去读不到东西」。
   */
  useEffect(() => {
    if (state.phase === 'booting') {
      requestedProjects.current = []
      return
    }
    if (state.phase !== 'ready') return
    const missing = expandedProjects.filter((path) => state.projectSessions[path] === undefined
      && state.loadingProject !== path
      && !requestedProjects.current.includes(path))
    if (missing.length === 0) return
    requestedProjects.current = [...requestedProjects.current, ...missing]
    for (const path of missing) void onLoadProjectSessions(path)
  }, [state.phase, state.projectSessions, state.loadingProject, expandedProjects, onLoadProjectSessions])

  /** 搜索结果：跨项目平铺，匹配标题或会话 id。 */
  const hits = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return null
    const rows: { session: SessionSummary; project: string; cwd?: string }[] = []
    for (const project of state.projects) {
      const list = project.current ? state.sessions : state.projectSessions[project.path]
      for (const session of list ?? []) {
        const haystack = `${session.title} ${session.id}`.toLowerCase()
        if (haystack.includes(needle)) {
          rows.push({ session, project: project.name, cwd: project.current ? undefined : project.path })
        }
      }
    }
    return rows
  }, [query, state.projects, state.sessions, state.projectSessions])

  const statusKind = state.phase === 'ready' ? (state.busy ? 'busy' : 'ready') : state.phase === 'error' ? 'error' : ''
  const statusLabel = state.phase === 'ready' ? (state.busy ? '生成中' : '就绪') : state.phase === 'error' ? '不可用' : '启动中'
  const credentialMissing = info !== null && info.credential.startsWith('未找到')

  /** 展开 / 折叠一个项目；首次展开时去读盘。 */
  const toggleProject = (project: ProjectSummary): void => {
    if (project.current) {
      setCurrentOpen((open) => !open)
      return
    }
    if (expandedProjects.includes(project.path)) {
      setExpandedProjects(expandedProjects.filter((path) => path !== project.path))
      return
    }
    setExpandedProjects([...expandedProjects, project.path])
    // 首次展开才读盘；之后折叠再展开先用缓存，新数据回来会覆盖它。
    if (state.projectSessions[project.path] === undefined) void onLoadProjectSessions(project.path)
  }

  return (
    <aside className="sidebar">
      {/* 拖拽区：系统标题栏隐藏后，用户靠这里拖动窗口。
          macOS 上红绿灯浮在这里，所以留出高度。 */}
      <div className="sidebar__brand drag-region">
        <span className="sidebar__title">工作区</span>
        <button
          type="button"
          className="sidebar__new no-drag"
          title="新建会话"
          onClick={onNewSession}
        >
          <IconPlus size={14} />
          新会话
        </button>
      </div>

      {/* 搜索：匹配标题与会话 id，命中后切成跨项目平铺结果 */}
      <div className="sidebar__search">
        <span className="sidebar__search-icon"><IconSearch size={14} /></span>
        <input
          className="sidebar__search-input"
          value={query}
          placeholder="搜索会话"
          spellCheck={false}
          aria-label="搜索会话"
          {...ime.compositionProps}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>

      {credentialMissing && (
        <div className="sidebar__warn">{info?.credential}</div>
      )}

      <div className="sidebar__section sidebar__section--grow">
        {hits !== null ? (
          <ul className="tree">
            {hits.length === 0 && <li className="session-empty">没有匹配的会话</li>}
            {hits.map((hit) => (
              <SessionRow
                key={hit.session.id}
                session={hit.session}
                now={now}
                subtitle={hit.project}
                onOpen={() => { onOpenSession(hit.session.id, hit.cwd) }}
              />
            ))}
          </ul>
        ) : (
          <ul className="tree">
            {state.projects.map((project) => {
              const isCurrent = project.current
              const open = isCurrent ? currentOpen : expandedProjects.includes(project.path)
              const sessions = (isCurrent ? state.sessions : state.projectSessions[project.path]) ?? []
              const loading = isCurrent
                ? state.phase === 'booting'
                : state.loadingProject === project.path && state.projectSessions[project.path] === undefined
              const classes = ['project-node']
              if (open) classes.push('project-node--open')
              if (isCurrent) classes.push('project-node--current')
              return (
                <li key={project.path} className={classes.join(' ')}>
                  <div className="project-node__row">
                    <button
                      type="button"
                      className="project-node__head no-drag"
                      aria-expanded={open}
                      title={project.path}
                      onClick={() => { toggleProject(project) }}
                    >
                      <span className="project-node__caret" aria-hidden>{open ? '▾' : '▸'}</span>
                      <span className="project-node__text">
                        <span className="project__name">{project.name}</span>
                      </span>
                      <span className="project-node__count">{project.sessionCount}</span>
                    </button>
                    {!isCurrent && (
                      <button
                        type="button"
                        className="project-node__switch no-drag"
                        title={`把工作目录切到 ${project.path}`}
                        onClick={() => { onOpenProject(project.path) }}
                      >
                        切换
                      </button>
                    )}
                  </div>

                  {open && (
                    <ul className="session-list session-list--child">
                      {loading && <li className="session-empty">读取中…</li>}
                      {!loading && sessions.length === 0 && <li className="session-empty">这个项目还没有会话</li>}
                      {!loading && sessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          now={now}
                          onOpen={() => { onOpenSession(session.id, isCurrent ? undefined : project.path) }}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="sidebar__footer">
        <span className="dot" title={state.error ?? undefined}>
          <span className={`dot__mark dot__mark--${statusKind === '' ? 'idle' : statusKind}`} />
          {statusLabel}
        </span>
        <button
          type="button"
          className="link no-drag"
          title="查看已注册的工具"
          onClick={() => { setShowTools((open) => !open) }}
        >
          {tools.length} 工具
        </button>
        <button type="button" className="link no-drag" title="重新扫描磁盘上的会话" onClick={onRefreshSessions}>
          刷新
        </button>
        <button
          type="button"
          className="link no-drag"
          title="设置：查看 / 编辑技能、命令与 MCP"
          onClick={onOpenSettings}
        >
          设置
        </button>
        <span className="sidebar__spacer" />
        <span className="mono" title={appInfo?.version}>
          {appInfo === null ? '' : `v${appInfo.version}`}
        </span>
      </div>

      {showTools && (
        <ul className="tool-list">
          {tools.map((tool) => (
            <li key={tool.name} title={tool.description}>{tool.name}</li>
          ))}
        </ul>
      )}

    </aside>
  )
}
