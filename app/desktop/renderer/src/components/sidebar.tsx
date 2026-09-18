/**
 * 左侧信息栏（Apple 风格布局 + Codex 配色）。
 *
 * 结构自下而上只有三块：
 *   1. **品牌行**：`YuanMy` + 一个状态点（就绪 / 生成中 / 不可用）；
 *   2. **项目树**：会话挂在它所属的项目下面。当前项目默认展开，其他项目折叠，
 *      **点开时才向 host 要数据**（见 `use-agent.ts` 的 `loadProjectSessions`）；
 *   3. 模型 / 工具 / 版本这些操作项。
 *
 * 刻意**不放**「运行状态」参数清单（模型 id、会话 id、凭据、工具数）：那些信息
 * 要么顶栏已经有，要么只在排查时才有用，不该常驻占地方。
 *
 * 关键点：**侧栏自己不做模糊**。原生磨砂玻璃由窗口材质提供
 * （macOS `vibrancy: 'sidebar'` / Windows `backgroundMaterial: 'acrylic'`），
 * CSS 里只留一层极淡的纯色染色保证文字对比度 —— 见 `styles/app.css` 的
 * `html[data-vibrancy="native"] .sidebar`。刻意不用 `backdrop-filter`。
 *
 * 顶部一段是窗口**拖拽区**：系统标题栏已隐藏，靠它拖动窗口。
 *
 * @module YuanMy/desktop/renderer/components/sidebar
 */

import { useState, type ReactElement } from 'react'
import { useImeGuard } from '../composition.ts'
import type { AgentState, AppInfo, ProjectSummary, SessionSummary } from '../use-agent.ts'

/** 相对时间：会话列表里「多久以前」比绝对时间更有用。 */
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
  readonly onOpen: (sessionId: string) => void
}): ReactElement {
  const { session, now, onOpen } = props
  const label = session.title === '' ? '（暂无消息）' : session.title
  return (
    <li>
      <button
        type="button"
        className={`session${session.current ? ' session--current' : ''}`}
        data-testid="session-item"
        data-session-id={session.id}
        data-current={session.current ? 'true' : 'false'}
        title={`${session.id}\n${String(session.turns)} 个回合 · ${new Date(session.updatedAt).toLocaleString()}`}
        onClick={() => { if (!session.current) onOpen(session.id) }}
      >
        <span className="session__title">{label}</span>
        <span className="session__meta">
          {session.current ? '当前' : relativeTime(session.updatedAt, now)}
          {session.turns > 0 && ` · ${String(session.turns)} 轮`}
        </span>
      </button>
    </li>
  )
}

/**
 * 一个项目节点：项目行 + （展开时）挂在它下面的会话列表。
 *
 * 项目行**主体**点击 = 展开 / 折叠；「切换」是行右侧的独立按钮 ——
 * 否则「看看这个项目里有什么」和「把工作目录换过去」会抢同一个手势。
 */
function ProjectNode(props: {
  readonly project: ProjectSummary
  readonly open: boolean
  readonly sessions: readonly SessionSummary[]
  readonly loading: boolean
  readonly now: number
  readonly onToggle: () => void
  readonly onSwitch: (path: string) => void
  readonly onOpenSession: (sessionId: string, projectPath?: string) => void
}): ReactElement {
  const { project, open, sessions, loading, now, onToggle, onSwitch, onOpenSession } = props
  const isCurrent = project.current
  const classes = ['project-node']
  if (open) classes.push('project-node--open')
  if (isCurrent) classes.push('project-node--current')

  return (
    <li className={classes.join(' ')}>
      <div className="project-node__row">
        <button
          type="button"
          className="project-node__head no-drag"
          data-testid={isCurrent ? 'current-project' : 'project-item'}
          data-project-path={project.path}
          data-current={isCurrent ? 'true' : 'false'}
          aria-expanded={open}
          title={project.path}
          onClick={onToggle}
        >
          <span className="project-node__caret" aria-hidden>{open ? '▾' : '▸'}</span>
          <span className="project-node__text">
            <span className="project__name" data-testid="project-name">{project.name}</span>
            {/* 只有当前项目多挂一行路径：它只有一个，不会把列表撑长 */}
            {isCurrent && <span className="project__path mono">{project.path}</span>}
          </span>
          <span className="project-node__count">{project.sessionCount} 个会话</span>
        </button>
        {!isCurrent && (
          <button
            type="button"
            className="project-node__switch no-drag"
            data-testid="switch-project"
            title={`把工作目录切到 ${project.path}`}
            onClick={() => { onSwitch(project.path) }}
          >
            切换
          </button>
        )}
      </div>

      {open && (
        <ul className="session-list session-list--child" data-testid="session-list">
          {loading && <li className="session-empty">读取中…</li>}
          {!loading && sessions.length === 0 && <li className="session-empty">这个项目还没有会话</li>}
          {!loading && sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              now={now}
              onOpen={(sessionId) => { onOpenSession(sessionId, isCurrent ? undefined : project.path) }}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export interface SidebarProps {
  readonly state: AgentState
  readonly appInfo: AppInfo | null
  readonly now: number
  readonly onNewSession: () => void
  readonly onPickDirectory: () => void
  readonly onSetModel: (model: string) => void
  /**
   * 恢复一个会话。
   * @param sessionId - 会话 id。
   * @param projectPath - 该会话所属项目；省略表示当前项目。
   */
  readonly onOpenSession: (sessionId: string, projectPath?: string) => void
  readonly onOpenProject: (path: string) => void
  readonly onRefreshSessions: () => void
  /** 展开一个折叠的项目时，去读它的会话明细。 */
  readonly onLoadProjectSessions: (path: string) => void
}

export function Sidebar(props: SidebarProps): ReactElement {
  const {
    state, appInfo, now, onNewSession, onPickDirectory, onSetModel,
    onOpenSession, onOpenProject, onRefreshSessions, onLoadProjectSessions,
  } = props
  const [showTools, setShowTools] = useState(false)
  const [model, setModel] = useState('')
  /** 其他项目里「被点开过」的路径。 */
  const [expandedProjects, setExpandedProjects] = useState<readonly string[]>([])
  /** 当前项目默认展开，用户可以手动折起来。 */
  const [currentOpen, setCurrentOpen] = useState(true)
  const ime = useImeGuard()
  const info = state.info
  const tools = info?.tools ?? []
  const current = state.projects.find((project) => project.current)
  const others = state.projects.filter((project) => !project.current)

  const statusKind = state.phase === 'ready' ? (state.busy ? 'busy' : 'ready') : state.phase === 'error' ? 'error' : ''
  const statusLabel = state.phase === 'ready' ? (state.busy ? '生成中' : '就绪') : state.phase === 'error' ? '不可用' : '启动中'

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
      {/* 拖拽区：系统标题栏隐藏后，用户靠这里拖动窗口 */}
      <div className="sidebar__section sidebar__brand drag-region">
        <div className="sidebar__label">YuanMy</div>
        <div className="sidebar__sub">
          <span className={`dot${statusKind === '' ? '' : ` dot--${statusKind}`}`} />
          <span data-testid="status-text">{statusLabel}</span>
        </div>
      </div>

      {/* ── 项目树：会话挂在它所属的项目下面 ─────────────────────────── */}
      <div className="sidebar__section sidebar__section--grow">
        <div className="sidebar__label">
          项目
          <span className="sidebar__label-actions">
            <button type="button" className="link no-drag" data-testid="refresh-sessions" onClick={onRefreshSessions}>
              刷新
            </button>
            <button type="button" className="link no-drag" data-testid="new-session" onClick={onNewSession}>
              新建
            </button>
          </span>
        </div>
        <ul className="project-tree" data-testid="project-tree">
          {current === undefined && <li className="session-empty">（未就绪）</li>}
          {current !== undefined && (
            <ProjectNode
              project={current}
              open={currentOpen}
              sessions={state.sessions}
              loading={false}
              now={now}
              onToggle={() => { toggleProject(current) }}
              onSwitch={onOpenProject}
              onOpenSession={onOpenSession}
            />
          )}
          {others.map((project) => (
            <ProjectNode
              key={project.path}
              project={project}
              open={expandedProjects.includes(project.path)}
              sessions={state.projectSessions[project.path] ?? []}
              loading={state.loadingProject === project.path}
              now={now}
              onToggle={() => { toggleProject(project) }}
              onSwitch={onOpenProject}
              onOpenSession={onOpenSession}
            />
          ))}
        </ul>
      </div>

      <div className="sidebar__section">
        <div className="sidebar__label">模型</div>
        <form
          className="row no-drag"
          onSubmit={(event) => {
            event.preventDefault()
            const value = model.trim()
            if (value !== '') onSetModel(value)
          }}
        >
          <input
            className="input"
            data-testid="model-input"
            value={model}
            placeholder={info?.model ?? 'deepseek-flash'}
            spellCheck={false}
            aria-label="模型 id"
            {...ime.compositionProps}
            onChange={(event) => { setModel(event.target.value) }}
            onKeyDown={(event) => {
              // 组字时的回车是「确认候选词」。不拦住它，浏览器会顺手提交这个
              // <form>，等于用半截输入去切模型（和输入框那个 bug 同源）。
              if (ime.isImeKey(event)) event.preventDefault()
            }}
          />
          <button type="submit" className="btn btn--ghost" data-testid="model-apply">切换</button>
        </form>
        <button
          type="button"
          className="btn btn--ghost no-drag"
          data-testid="pick-directory"
          onClick={onPickDirectory}
        >
          更换工作目录…
        </button>
      </div>

      <div className="sidebar__section">
        <button
          type="button"
          className="btn btn--ghost no-drag"
          data-testid="toggle-tools"
          onClick={() => { setShowTools((open) => !open) }}
        >
          {showTools ? '收起工具列表' : `查看工具列表（${String(tools.length)}）`}
        </button>
        {showTools && (
          <ul className="tool-list" data-testid="tool-list">
            {tools.map((tool) => (
              <li key={tool.name} title={tool.description}>{tool.name}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar__footer">
        <span className="mono" data-testid="app-version">
          {appInfo === null ? 'YuanMy Agent' : `${appInfo.name} ${appInfo.version}`}
        </span>
      </div>
    </aside>
  )
}
