/**
 * 从落盘的会话日志里读出「项目 / 会话」清单，供桌面端左侧栏展示。
 *
 * 数据来源就是会话持久化插件写的那份 JSONL（`<stateDir>/sessions/<项目>/<会话 id>/session.v3.jsonl`），
 * 不额外维护索引文件 —— 索引会和日志不同步，日志才是真相。
 *
 * ## 目录布局
 *
 * ```
 * .YuanMy/sessions/
 *   --Users-me-proj--/                  ← 项目目录名是 cwd 的转义形式（不可逆，所以真路径从日志头里读）
 *     YuanMy-20260918115410-jq637s/
 *       session.v3.jsonl                ← 第一行是 session 头，之后每行一个事件
 * ```
 *
 * ## 每个会话摘要从日志里取什么
 *
 * | 字段 | 来源 |
 * | --- | --- |
 * | `id` / `createdAt` / `cwd` | 第一行 `{"type":"session", id, createdAt, cwd}` |
 * | `title` | 优先最后一条 `session/title` 事件；否则第一条 `source.kind === 'user'` 的 `user/message` |
 * | `turns` | `turn/end` 事件条数 |
 * | `updatedAt` | 文件 mtime 与最后一条事件 `time` 取大 |
 *
 * `session/title` 由可选的 `@deepseek-ai/dsh-session-title` 插件写入；本项目暂时没挂它，
 * 但这里已经优先读它 —— 以后挂上（或用 DSH 自己的 CLI 建过会话）就能自动显示正式标题。
 *
 * ## 有界的读法
 *
 * 列表是**按需**跑的，不常驻。为了不因为某个巨大会话卡住界面：
 *   - 每个文件只在 `MAX_LOG_BYTES` 以内整体读；更大的文件只读头部 `HEAD_BYTES`
 *     （标题一定在开头附近），此时 `turns` 会是「头部内数到的」下界；
 *   - 只解析**每个项目里最新的一个会话**来确定该项目的真实 cwd（项目目录名不可逆）；
 *   - {@link listWorkspaceSessions} 只为**当前项目**展开会话明细（最多 `limit` 条）；
 *     其他项目由 {@link listProjectSessions} 在侧栏里被点开时才读。于是「项目很多」
 *     只让首屏多付「每个项目读一个头」的代价，而不是把所有会话都读一遍。
 *
 * @module YuanMy/desktop/host/sessions
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** 整体读取的上限；超过就只读头部。 */
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** 大文件时只读这么多字节（标题总在开头附近）。 */
const HEAD_BYTES = 256 * 1024
/** 会话日志的文件名（与持久化插件一致）。 */
const LOG_NAME = 'session.v3.jsonl'
/** 标题最长字符数（按码点截断，不会切坏 emoji / 中文）。 */
const TITLE_MAX_CHARS = 42
/** 每个项目最多列多少个会话（超出的靠「N 个会话」计数体现）。 */
const DEFAULT_SESSIONS_PER_PROJECT = 20
/** 最多展开多少个项目；当前项目永远在内。 */
const DEFAULT_MAX_PROJECTS = 12

/** 一个已落盘会话的摘要。 */
export interface SessionSummary {
  /** 会话 id，同时也是恢复时传给 `--resume` 的值。 */
  readonly id: string
  /** 展示用标题（可能为空串：还没有用户消息的会话）。 */
  readonly title: string
  /** 会话创建时间（毫秒）。 */
  readonly createdAt: number
  /** 最后活动时间（毫秒）。 */
  readonly updatedAt: number
  /** 已完成的回合数。 */
  readonly turns: number
  /** 是否是当前正在跑的这个会话。 */
  readonly current: boolean
}

/** 一个项目的摘要（**不含**会话明细；明细按需读，见 `listProjectSessions`）。 */
export interface ProjectSummary {
  /** 目录名（cwd 的 basename）。 */
  readonly name: string
  /** 项目绝对路径。 */
  readonly path: string
  /** 该项目已落盘的会话总数（可能大于 `sessions.length`，见 {@link DEFAULT_SESSIONS_PER_PROJECT}）。 */
  readonly sessionCount: number
  /** 该项目最后一次活动时间。 */
  readonly updatedAt: number
  /** 是否是当前 agent 的工作目录。 */
  readonly current: boolean
}

/** 一个项目 + 它的会话明细（`list-project-sessions` 的返回）。 */
export interface ProjectSessions {
  readonly project: ProjectSummary
  readonly sessions: readonly SessionSummary[]
}

/** 首屏清单：项目 + **当前项目**的会话明细。 */
export interface WorkspaceListing {
  /** 所有出现过的项目（当前项目一定在列表里，即使还没有任何会话）。 */
  readonly projects: readonly ProjectSummary[]
  /** 当前项目的会话，按最近活动倒序。其他项目的明细按需读。 */
  readonly sessions: readonly SessionSummary[]
}

/** 会话头（JSONL 第一行）里我们关心的字段。 */
interface SessionHeader {
  readonly id: string
  readonly createdAt: number
  readonly cwd: string
}

/** 把标题截断到可读长度。 */
function truncateTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const points = [...flat]
  return points.length <= TITLE_MAX_CHARS ? flat : `${points.slice(0, TITLE_MAX_CHARS - 1).join('')}…`
}

/** 从一个内容块数组里取出纯文本。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .join('')
}

/**
 * 读一个会话日志。大文件只读头部，避免因为个别会话过大拖慢列表。
 * @param path - JSONL 路径。
 * @param size - 文件字节数。
 * @returns 文件内容（可能被截断到 HEAD_BYTES）。
 */
async function readLog(path: string, size: number): Promise<string> {
  if (size <= MAX_LOG_BYTES) return readFile(path, 'utf8')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * 解析一份会话日志。
 * @param id - 目录名给出的会话 id（作为日志缺头时的兜底）。
 * @param text - 日志文本。
 * @param mtimeMs - 文件 mtime。
 * @returns 摘要；日志头缺失或损坏时返回 `undefined`（坏文件跳过，不影响其他会话）。
 */
function summarize(id: string, text: string, mtimeMs: number): SessionSummary | undefined {
  let header: SessionHeader | undefined
  let title = ''
  let fallbackTitle = ''
  let turns = 0
  let lastTime = 0

  for (const line of text.split('\n')) {
    if (line === '') continue
    let event: { type?: unknown; time?: unknown; data?: unknown }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      // 尾部半行（正在写入）或损坏行：跳过，不影响其余内容。
      continue
    }
    const type = typeof event.type === 'string' ? event.type : ''
    if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time

    if (type === 'session') {
      const raw = event.data !== undefined && typeof event.data === 'object' ? event.data : event
      const candidate = raw as Partial<SessionHeader>
      if (typeof candidate.id === 'string' && typeof candidate.cwd === 'string' && typeof candidate.createdAt === 'number') {
        header = { id: candidate.id, createdAt: candidate.createdAt, cwd: candidate.cwd }
      }
      continue
    }

    // `session/title` 是「最后一次生效」，所以一直覆盖。
    if (type === 'session/title') {
      const data = event.data as { title?: unknown } | undefined
      if (typeof data?.title === 'string' && data.title !== '') title = data.title
      continue
    }

    if (type === 'user/message' && fallbackTitle === '') {
      const data = event.data as { content?: unknown; source?: { kind?: unknown } } | undefined
      if (data?.source?.kind === 'user') {
        const text = textOf(data.content)
        if (text.trim() !== '') fallbackTitle = text
      }
      continue
    }

    if (type === 'turn/end') turns += 1
  }

  if (header === undefined) return undefined
  const updatedAt = Math.max(mtimeMs, lastTime, header.createdAt)
  return {
    id: header.id === '' ? id : header.id,
    title: truncateTitle(title !== '' ? title : fallbackTitle),
    createdAt: header.createdAt,
    updatedAt,
    turns,
    current: false,
  }
}

/** 目录里的会话目录（按 mtime 倒序，新的在前）。 */
async function sessionDirs(projectDir: string): Promise<{ id: string; path: string; mtimeMs: number }[]> {
  let entries
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: { id: string; path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const logPath = join(projectDir, entry.name, LOG_NAME)
    try {
      const info = await stat(logPath)
      found.push({ id: entry.name, path: logPath, mtimeMs: info.mtimeMs })
    } catch {
      // 没有日志的目录（半途中断、被手删）直接忽略。
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 持久化根目录下的全部项目目录（根目录还不存在时返回空数组）。 */
async function projectDirsOf(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

/** 一个项目目录的扫描结果。 */
interface ProjectScan {
  /** 项目真实 cwd（目录名不可逆，所以从它最新的那个会话头里读）。 */
  readonly cwd: string
  /** 项目下的会话日志目录（按 mtime 倒序）。 */
  readonly dirs: readonly { readonly id: string; readonly path: string; readonly mtimeMs: number }[]
}

/**
 * 扫一个项目目录，并确定它的真实 cwd。
 * @param projectDir - `<stateDir>/sessions` 下的一个项目目录。
 * @returns 扫描结果；目录里没有可用会话时返回 `undefined`。
 */
async function scanProject(projectDir: string): Promise<ProjectScan | undefined> {
  const dirs = await sessionDirs(projectDir)
  const newest = dirs[0]
  if (newest === undefined) return undefined
  try {
    const info = await stat(newest.path)
    const text = await readLog(newest.path, info.size)
    const firstLine = text.slice(0, text.indexOf('\n'))
    const parsed = JSON.parse(firstLine) as { cwd?: unknown }
    if (typeof parsed.cwd !== 'string' || parsed.cwd === '') return undefined
    return { cwd: parsed.cwd, dirs }
  } catch {
    // 头损坏 / 读不动：这次就当没看见这个项目，不影响其他项目。
    return undefined
  }
}

/**
 * 把一批会话目录读成摘要（只读最前面的 `limit` 个）。
 * @param dirs - 某项目下的会话目录（按 mtime 倒序）。
 * @param limit - 最多读多少个。
 * @param currentSessionId - 当前会话 id；命中的那条标记为 `current`。
 */
async function summarizeDirs(
  dirs: ProjectScan['dirs'],
  limit: number,
  currentSessionId: string,
): Promise<SessionSummary[]> {
  const summaries: SessionSummary[] = []
  for (const dir of dirs.slice(0, limit)) {
    try {
      const info = await stat(dir.path)
      const text = await readLog(dir.path, info.size)
      const summary = summarize(dir.id, text, info.mtimeMs)
      if (summary !== undefined) summaries.push({ ...summary, current: summary.id === currentSessionId })
    } catch {
      // 单个会话读失败不影响整个列表。
    }
  }
  return summaries
}
/**
 * 定位所有项目：每个项目只读「最新那个会话」的头，拿到真实 cwd。
 *
 * 项目目录名是 cwd 的转义形式且**不可逆**，所以真实路径只能从日志头里读，
 * 这里刻意不去猜转义规则。
 * @param root - 持久化根目录（`<stateDir>/sessions`）。
 * @returns 每个项目的 cwd 与它的会话目录（按 mtime 倒序）。
 */
async function locateProjects(root: string): Promise<ProjectScan[]> {
  const found: ProjectScan[] = []
  for (const projectDir of await projectDirsOf(root)) {
    const scan = await scanProject(projectDir)
    if (scan !== undefined) found.push(scan)
  }
  return found
}

/** 由一个项目扫描结果拼出摘要（不含会话明细）。 */
function projectSummary(scan: ProjectScan, currentPath: string, sessionCount = scan.dirs.length): ProjectSummary {
  return {
    name: basename(scan.cwd) || scan.cwd,
    path: scan.cwd,
    sessionCount,
    updatedAt: scan.dirs[0]?.mtimeMs ?? Date.now(),
    current: resolve(scan.cwd) === currentPath,
  }
}

/**
 * 当前会话可能还没落盘（新建后还没跑过回合），那样树里就标不出「当前」。
 * 补一条合成记录：它只在界面上占一个位置，等第一次写入后自然被真记录取代。
 */
function withCurrentSession(sessions: SessionSummary[], currentSessionId: string): SessionSummary[] {
  if (sessions.some((session) => session.id === currentSessionId)) return sessions
  const now = Date.now()
  return [
    { id: currentSessionId, title: '', createdAt: now, updatedAt: now, turns: 0, current: true },
    ...sessions,
  ]
}

/**
 * 列出项目清单 **+ 当前项目的会话明细**（侧栏首屏数据）。
 *
 * 只读当前项目的会话：项目清单随首屏一起到，其他项目的明细等被点开时再读
 * （{@link listProjectSessions}），所以项目再多也不会拖慢首屏。
 *
 * @param options - 查询参数。
 * @param options.root - 持久化根目录（`<stateDir>/sessions`）。
 * @param options.cwd - 当前 agent 的工作目录。
 * @param options.currentSessionId - 当前会话 id（用来高亮 / 补合成记录）。
 * @param options.sessionsPerProject - 当前项目最多列几个会话。
 * @param options.maxProjects - 最多返回几个项目（当前项目一定在内）。
 * @returns 项目清单与当前项目的会话。目录还不存在时是「只有当前项目、没有会话」。
 */
export async function listWorkspaceSessions(options: {
  readonly root: string
  readonly cwd: string
  readonly currentSessionId: string
  readonly sessionsPerProject?: number
  readonly maxProjects?: number
}): Promise<WorkspaceListing> {
  const perProject = options.sessionsPerProject ?? DEFAULT_SESSIONS_PER_PROJECT
  const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS
  const currentPath = resolve(options.cwd)

  const located = await locateProjects(options.root)
  const currentScan = located.find((scan) => resolve(scan.cwd) === currentPath)
  const others = located
    .filter((scan) => resolve(scan.cwd) !== currentPath)
    .sort((a, b) => (b.dirs[0]?.mtimeMs ?? 0) - (a.dirs[0]?.mtimeMs ?? 0))
  const selected = currentScan === undefined
    ? others.slice(0, maxProjects)
    : [currentScan, ...others.slice(0, maxProjects - 1)]

  let sessions: SessionSummary[] = []
  const projects: ProjectSummary[] = []
  for (const scan of selected) {
    const isCurrent = resolve(scan.cwd) === currentPath
    if (isCurrent) {
      sessions = await summarizeDirs(scan.dirs, perProject, options.currentSessionId)
      sessions = withCurrentSession(sessions, options.currentSessionId)
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    projects.push(projectSummary(scan, currentPath))
  }

  // 全新目录还没有任何会话：也要把当前项目摆出来，否则侧栏会空着。
  // 同时补上「当前会话」那条合成记录 —— 否则界面显示「0 个会话 + 空列表」，
  // 而实际上正有一个会话在跑，看起来像新建会话没生效。
  if (currentScan === undefined) {
    projects.unshift({
      name: basename(currentPath) || currentPath,
      path: currentPath,
      sessionCount: 0,
      updatedAt: Date.now(),
      current: true,
    })
    sessions = withCurrentSession([], options.currentSessionId)
  }

  projects.sort((a, b) => (a.current === b.current ? b.updatedAt - a.updatedAt : a.current ? -1 : 1))
  return { projects, sessions }
}

/**
 * 读**某一个项目**的会话明细（侧栏里折叠的项目被点开时调用）。
 *
 * @param options - 查询参数。
 * @param options.root - 持久化根目录（`<stateDir>/sessions`）。
 * @param options.path - 目标项目根目录（`ProjectSummary.path`）。
 * @param options.currentSessionId - 当前会话 id；命中的那条标记为 `current`。
 * @param options.currentCwd - agent 当前的工作目录；与 `path` 相同才补「还没落盘」的当前会话。
 * @param options.sessionsPerProject - 最多列几个会话。
 * @returns 项目摘要 + 会话明细；找不到该项目（目录被删等）时返回 `undefined`。
 */
export async function listProjectSessions(options: {
  readonly root: string
  readonly path: string
  readonly currentSessionId: string
  readonly currentCwd?: string
  readonly sessionsPerProject?: number
}): Promise<ProjectSessions | undefined> {
  const perProject = options.sessionsPerProject ?? DEFAULT_SESSIONS_PER_PROJECT
  const wanted = resolve(options.path)
  const scan = (await locateProjects(options.root)).find((entry) => resolve(entry.cwd) === wanted)
  if (scan === undefined) return undefined

  let sessions = await summarizeDirs(scan.dirs, perProject, options.currentSessionId)
  // 只有「读的正是当前项目」时才需要合成记录（当前会话可能还没落盘）。
  if (options.currentCwd !== undefined && resolve(options.currentCwd) === wanted) {
    sessions = withCurrentSession(sessions, options.currentSessionId)
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return { project: projectSummary(scan, wanted), sessions }
}
