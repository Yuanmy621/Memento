/**
 * 设置面板：看 / 改「技能、命令、MCP」这三样东西。
 *
 * ## 为什么做成「列表 + 编辑器」
 *
 * 这三样都是**磁盘上的文本文件**，而且改动方式就是改文本：
 *
 * | 标签 | 文件 | 能改什么 |
 * | --- | --- | --- |
 * | 技能 | `.agents/skills/<名字>/SKILL.md` | 正文与 frontmatter（含调用政策） |
 * | 命令 | `.agents/commands/<名字>.md` | 指令正文、`include` 内联哪些文件 |
 * | MCP | `<cwd>/.YuanMy/mcp.json` | 开关、启动参数（改完要重启内核） |
 *
 * 所以这里不做「表单化的字段编辑」，而是老老实实给一个文本框 —— 反正这些东西
 * 本来就该写 Markdown / JSON，表单反而会挡住 frontmatter 和注释。
 *
 * ## 两个刻意的设计
 *
 * 1. **技能分「全局 / 命令专用」**：这是内核 `SkillInvocationPolicy` 的可视化。
 *    全局 = 进模型目录（长期占上下文）；命令专用 = 只由 `/命令` 触发。
 *    界面上直接标出来，改政策就是改 frontmatter 里的那两行。
 * 2. **解析失败要显形**：`SKILL.md` 的 frontmatter 写坏时内核只 warn 一句就忽略，
 *    表现是「文件明明在、技能却不生效」。列表里那条 ⚠ 就是拦这个的。
 *
 * @module YuanMy/desktop/renderer/src/components/settings-panel
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { FileResult, McpEntry, SettingsData, SkillEntry } from '../use-agent.ts'
import { Button } from '../ui/beautifului/atoms/Button.tsx'

/** 三个标签页。 */
type Tab = 'skills' | 'commands' | 'mcp'

export interface SettingsPanelProps {
  readonly data: SettingsData | null
  readonly busy: boolean
  readonly onClose: () => void
  readonly onReload: () => void
  readonly onReadFile: (path: string) => Promise<FileResult>
  readonly onWriteFile: (path: string, content: string) => Promise<FileResult>
  /** 重启内核（改完 MCP 配置后用）。 */
  readonly onRestart: () => void
}

/** 把字节数显示成人能读的大小。 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** 技能类型徽章。 */
function InvocationBadge({ skill }: { skill: SkillEntry }): ReactElement {
  const text = skill.invocation === 'global' ? '全局' : skill.invocation === 'command' ? '命令专用' : '不对外'
  const title = skill.invocation === 'global'
    ? '进模型的会话目录：模型能自己按需加载（长期占目录描述）'
    : skill.invocation === 'command'
      ? '不进模型目录：只有 /命令 触发时才注入正文（短期）'
      : '模型与人工入口都不给（user-invocable: false）'
  return <span className={`settag settag--${skill.invocation}`} title={title}>{text}</span>
}

/** 列表里一行。 */
function Row(props: {
  readonly title: string
  readonly subtitle: string
  readonly active: boolean
  readonly onClick: () => void
  readonly badge?: ReactElement
  readonly warn?: string | undefined
}): ReactElement {
  return (
    <button
      type="button"
      className={`setrow${props.active ? ' setrow--active' : ''}`}
      onClick={props.onClick}
      title={props.subtitle}
    >
      <span className="setrow__head">
        <span className="setrow__title">{props.title}</span>
        {props.badge}
        {props.warn !== undefined && <span className="setrow__warn" title={props.warn}>⚠</span>}
      </span>
      <span className="setrow__sub">{props.subtitle}</span>
    </button>
  )
}

/** 编辑器：读文件 → 文本框 → 保存。 */
function Editor(props: {
  readonly path: string
  readonly onReadFile: (path: string) => Promise<FileResult>
  readonly onWriteFile: (path: string, content: string) => Promise<FileResult>
}): ReactElement {
  const [content, setContent] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)

  // 换文件就重新读；`path` 是唯一依赖。
  useEffect(() => {
    let alive = true
    setContent(null)
    setStatus('读取中…')
    props.onReadFile(props.path).then((result) => {
      if (!alive) return
      if (result.ok && typeof result.content === 'string') {
        setContent(result.content)
        setStatus('')
      } else {
        setStatus(result.error ?? '读取失败')
      }
    }).catch((error: unknown) => {
      if (alive) setStatus(String((error as Error | undefined)?.message ?? error))
    })
    return () => { alive = false }
  }, [props.path, props.onReadFile])

  /** 保存。 */
  const save = async (): Promise<void> => {
    if (content === null) return
    setBusy(true)
    const result = await props.onWriteFile(props.path, content)
    setBusy(false)
    setStatus(result.ok ? `已保存 · ${new Date().toLocaleTimeString()}` : (result.error ?? '保存失败'))
  }

  return (
    <div className="setedit">
      <div className="setedit__bar">
        <span className="setedit__path" title={props.path}>{props.path}</span>
        <span className="setedit__status">{status}</span>
        <Button type="button" variant="secondary" size="xs" disabled={busy || content === null} onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
      <textarea
        className="setedit__area no-drag"
        spellCheck={false}
        value={content ?? ''}
        placeholder={content === null ? status : ''}
        onChange={(event) => { setContent(event.target.value) }}
      />
    </div>
  )
}

export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const [tab, setTab] = useState<Tab>('skills')
  /**
   * 当前选中的文件路径。
   *
   * 用「路径」而不是「选中项对象」：写完文件后列表会重新拉，对象会换新引用，
   * 用对象会让编辑器重挂、把光标位置丢掉。路径是稳定的。
   */
  const [picked, setPicked] = useState<string>('')
  /** 开关 MCP 之类操作的结果提示。 */
  const [notice, setNotice] = useState('')

  const data = props.data
  const skills = data?.skills ?? []

  /**
   * 开关一个 MCP 服务器。
   *
   * 做法是「**改 mcp.json 里那一条的 enabled**」，而不是用界面上的字段重写整个文件：
   * 界面上拿到的是**合并后**的启动参数（含从内置定义继承来的），原样写回会把
   * `format.docx` 之类的继承值固化进配置、还会丢掉我们不认识的字段。
   * 只动 enabled，文件就一直是「用户自己写的那几行」。
   */
  const toggleMcp = async (server: McpEntry): Promise<void> => {
    if (data === null) return
    const read = await props.onReadFile(data.mcpConfigPath)
    if (!read.ok) {
      setNotice(read.error ?? '读不到 MCP 配置文件')
      return
    }
    let doc: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(read.content ?? '{}')
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>
    } catch {
      setNotice('mcp.json 不是合法 JSON，先用「编辑配置 JSON」修好它')
      return
    }
    const list = Array.isArray(doc['servers']) ? [...(doc['servers'] as unknown[])] : []
    const index = list.findIndex((item) => typeof item === 'object' && item !== null
      && (item as { name?: unknown }).name === server.name)
    if (index >= 0) {
      const entry = list[index] as Record<string, unknown>
      list[index] = { ...entry, enabled: !server.enabled }
    } else {
      list.push({ name: server.name, enabled: !server.enabled })
    }
    const result = await props.onWriteFile(data.mcpConfigPath, `${JSON.stringify({ ...doc, servers: list }, null, 2)}\n`)
    setNotice(result.ok ? `已${server.enabled ? '停用' : '启用'} ${server.name} —— 重启内核后生效` : (result.error ?? '写入失败'))
  }
  const commands = data?.commands ?? []
  const mcp = data?.mcp ?? []

  // 切换标签时清掉选中（不同标签的文件不通用）
  useEffect(() => { setPicked('') }, [tab])

  return (
    <div className="setmodal" role="dialog" aria-label="设置">
      <div className="setmodal__scrim" onClick={props.onClose} />
      <div className="setmodal__box">
        <header className="setmodal__head">
          <nav className="settabs">
            {([['skills', '技能'], ['commands', '命令'], ['mcp', 'MCP']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`settab no-drag${tab === key ? ' settab--active' : ''}`}
                onClick={() => { setTab(key) }}
              >
                {label}
                <span className="settab__count">
                  {key === 'skills' ? skills.length : key === 'commands' ? commands.length : mcp.length}
                </span>
              </button>
            ))}
          </nav>
          <span className="setmodal__spacer" />
          <Button type="button" variant="secondary" size="xs" onClick={props.onReload} disabled={props.busy}>
            {props.busy ? '刷新中…' : '刷新'}
          </Button>
          <Button type="button" variant="secondary" size="xs" onClick={props.onClose}>关闭</Button>
        </header>

        <div className="setmodal__body">
          <div className="setlist">
            {tab === 'skills' && skills.map((skill) => (
              <Row
                key={skill.name}
                title={skill.name}
                subtitle={`${humanSize(skill.bytes)} · ${skill.source}${skill.path === '' ? '' : ` · ${skill.path.split('/').slice(-2).join('/')}`}`}
                active={picked === skill.path}
                badge={<InvocationBadge skill={skill} />}
                warn={skill.warning}
                onClick={() => { if (skill.path !== '') setPicked(skill.path) }}
              />
            ))}
            {tab === 'commands' && commands.map((command) => (
              <Row
                key={command.name}
                title={`/${command.name}`}
                subtitle={`${humanSize(command.bytes)} · ${command.scope}${command.includes.length === 0 ? '' : ` · 内联 ${String(command.includes.length)} 个文件`}`}
                active={picked === command.path}
                onClick={() => { setPicked(command.path) }}
              />
            ))}
            {tab === 'mcp' && mcp.map((server) => (
              <McpRow
                key={server.name}
                server={server}
                disabled={data === null}
                onToggle={() => { void toggleMcp(server) }}
              />
            ))}
            {tab === 'skills' && skills.length === 0 && <p className="setempty">还没有技能：放进 <code>.agents/skills/&lt;名字&gt;/SKILL.md</code>。</p>}
            {tab === 'commands' && commands.length === 0 && <p className="setempty">还没有命令：放进 <code>.agents/commands/&lt;名字&gt;.md</code>。</p>}
            {tab === 'mcp' && mcp.length === 0 && <p className="setempty">没有可用的 MCP 服务器。</p>}
            {tab === 'mcp' && data !== null && (
              <div className="setmcpcfg">
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => { setPicked(data.mcpConfigPath) }}
                >
                  编辑配置 JSON
                </Button>
                {data.mcpConfigError !== undefined && (
                  <p className="setwarn">配置文件解析失败：{data.mcpConfigError}</p>
                )}
                <p className="sethint">改完 MCP 配置要<strong>重启内核</strong>才生效。</p>
                {notice !== '' && <p className="sethint">{notice}</p>}
              </div>
            )}
          </div>

          <div className="setpane">
            {picked === '' ? (
              <p className="setempty">
                {tab === 'mcp'
                  ? '左边点服务器看详情，或点「编辑配置 JSON」直接改 mcp.json。'
                  : '左边选一项来查看 / 编辑。'}
              </p>
            ) : (
              <Editor path={picked} onReadFile={props.onReadFile} onWriteFile={props.onWriteFile} />
            )}
          </div>
        </div>

        <footer className="setmodal__foot">
          <span className="sethint">
            技能放 .agents/skills/，命令放 .agents/commands/，MCP 配置在 .YuanMy/mcp.json
            —— 都是纯文本，界面里改完即写盘。
          </span>
          <Button type="button" variant="secondary" size="xs" onClick={props.onRestart}>重启内核</Button>
        </footer>
      </div>
    </div>
  )
}

/** MCP 一行：带启用开关。 */
function McpRow(props: {
  readonly server: McpEntry
  readonly disabled: boolean
  readonly onToggle: () => void
}): ReactElement {
  const { server } = props
  const detail = server.transport === 'streamable-http'
    ? server.url
    : [server.command, ...server.args].join(' ')
  return (
    <div className="setrow setrow--static">
      <span className="setrow__head">
        <span className="setrow__title">{server.name}</span>
        <span className={`settag settag--${server.enabled ? 'global' : 'user-only'}`}>
          {server.enabled ? '已启用' : '未启用'}
        </span>
        <span className="settag settag--command">{server.source}</span>
      </span>
      <span className="setrow__sub" title={detail}>
        {server.transport} · {server.reason} · {detail.length > 70 ? `${detail.slice(0, 69)}…` : detail}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        disabled={props.disabled}
        onClick={props.onToggle}
      >
        {server.enabled ? '停用' : '启用'}
      </Button>
    </div>
  )
}
