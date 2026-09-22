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
 * 会话 id（树里已高亮）、凭据（只在缺失时提示）。
 *
 * 顶部一段是窗口**拖拽区**：系统标题栏已隐藏，靠它拖动窗口。
 *
 * @module YuanMy/desktop/renderer/components/sidebar
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useImeGuard } from '../composition.ts'
import { IconChat, IconPlus, IconSearch } from '../icons.tsx'
import { SidebarBackdrop } from './sidebar-backdrop.tsx'
// 应用图标：`assets/logo.png`（由 ip-as-logo 出的 B1 方片，构建时内联成 data URL）
import logoUrl from '../../../assets/logo.png'
import { EntityChip, Monogram } from '../ui/beautifului/atoms/EntityChip.tsx'
import { Shimmer } from '../ui/beautifului/atoms/Shimmer.tsx'
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
  /** 正在打开的这一条（点下去到新内核就绪之间）。 */
  readonly opening?: boolean
  /**
   * 这个会话有回合在跑（**包括在后台跑的那个**）。
   *
   * 后台继续跑是本项目的既定行为，所以必须看得见 —— 否则用户会以为切走
   * 就是把任务杀了（或者反过来，以为早就停了）。
   */
  readonly running?: boolean
  readonly onOpen: () => void
}): ReactElement {
  const { session, now, subtitle, opening, running, onOpen } = props
  const classes = ['session']
  if (session.current) classes.push('session--current')
  if (opening === true) classes.push('session--opening')
  return (
    <li className="tree__leaf">
      <button
        type="button"
        className={classes.join(' ')}
        title={`${session.id}\n${String(session.turns)} 个回合 · ${new Date(session.updatedAt).toLocaleString()}${running === true ? '\n回合进行中（切走也不会中断）' : ''}`}
        onClick={() => { if (!session.current) onOpen() }}
      >
        <span className="session__icon"><IconChat size={12} /></span>
        <span className="session__body">
          <span className="session__title">
            {/* 搜索结果里带上项目名（圆牌 + 名字），与树里的项目行同一套语言 */}
            {subtitle !== undefined && (
              <EntityChip name={subtitle} color="var(--accent)" className="session__project" />
            )}
            {session.title === '' ? '（暂无消息）' : session.title}
          </span>
          <span className="session__meta">
            {running === true && <span className="session__live" aria-label="回合进行中" />}
            {relativeTime(session.updatedAt, now)}
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
  /** 有回合在跑的会话 id（含后台会话）——列表里给它们打运行标记。 */
  readonly runningIds: readonly string[]
  readonly onNewSession: () => void
  readonly onOpenSession: (sessionId: string, cwd?: string) => void
  readonly onOpenProject: (path: string) => void
  readonly onLoadProjectSessions: (path: string) => void
  /** 打开设置面板（技能 / 命令 / MCP）。 */
  readonly onOpenSettings: () => void
}

export function Sidebar(props: SidebarProps): ReactElement {
  const {
    state, appInfo, now, runningIds, onNewSession,
    onOpenSession, onOpenProject, onLoadProjectSessions, onOpenSettings,
  } = props
  const [query, setQuery] = useState('')
  /** 其他项目里「被点开过」的路径。 */
  const [expandedProjects, setExpandedProjects] = useState<readonly string[]>([])
  /** 当前项目默认展开，用户可以手动折起来。 */
  const [currentOpen, setCurrentOpen] = useState(true)
  /**
   * 正在打开的会话 id：点下去 → 内核重启 → 历史回填，中间约 300ms。
   * 拿它给那一行一点回应（见 `.session--opening`），否则点完像是没反应。
   */
  const [opening, setOpening] = useState<string | null>(null)
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

  /**
   * 打开完成（`current` 落到目标会话上）就把标记收掉。
   *
   * 用 `current` 而不是「`switching` 变 false」：后者在点击后的那次渲染里还是 false，
   * 会把标记立刻清掉（点了没有任何反馈）。`current` 由 `workspace` 帧给出，
   * 是「内核真的切过去了」的权威信号；再挂一个 3s 超时兜底，避免卡在标记上。
   */
  useEffect(() => {
    if (opening === null) return undefined
    const lists = [...state.sessions, ...Object.values(state.projectSessions).flat()]
    if (lists.some((session) => session.id === opening && session.current)) {
      setOpening(null)
      return undefined
    }
    const timer = setTimeout(() => { setOpening(null) }, 3000)
    return () => { clearTimeout(timer) }
  }, [opening, state.sessions, state.projectSessions])

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
      {/* 背景粒子层（方块切开、旋转散开、渐隐）。它是 canvas、`pointer-events: none`，
          绝对定位在侧栏里不随内容滚动 —— 所以侧栏的滚动容器是下面那个
          `.sidebar__scroll`，而不是 `<aside>` 自己（见 app.css 里的注释）。 */}
      <SidebarBackdrop />

      {/* 滚动容器：内容比侧栏高时滚的是这一层，粒子层留在原地。 */}
      <div className="sidebar__scroll">
        {/* 拖拽区：系统标题栏隐藏后，用户靠这里拖动窗口。
            macOS 上红绿灯浮在这里，所以留出高度。 */}
        <div className="sidebar__brand drag-region">
          {/* 品牌：图标 + 名字。图标做成 16px 小方片（与项目行的 Monogram 等宽、
              和 macOS 侧栏头部同档），不是裸图 —— 深色玻璃底上给一圈发丝描边
              才像是「嵌在界面里」。 */}
          <img className="sidebar__logo no-drag" src={logoUrl} alt="" width={16} height={16} />
          <span className="sidebar__title">YuanMy</span>
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
                  opening={opening === hit.session.id}
                  running={runningIds.includes(hit.session.id)}
                  onOpen={() => { setOpening(hit.session.id); onOpenSession(hit.session.id, hit.cwd) }}
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
                        {/* 首字母圆牌：Beautiful UI 的 workspace 行就是「圆牌 + 名字 + 计数」 */}
                        <Monogram className="project-node__mono">{project.name.charAt(0).toUpperCase()}</Monogram>
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
                            opening={opening === session.id}
                            running={runningIds.includes(session.id)}
                            onOpen={() => {
                              setOpening(session.id)
                              onOpenSession(session.id, isCurrent ? undefined : project.path)
                            }}
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
            {state.busy ? <Shimmer>{statusLabel}</Shimmer> : statusLabel}
          </span>
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

      </div>
    </aside>
  )
}
