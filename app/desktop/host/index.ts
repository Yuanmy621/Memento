#!/usr/bin/env node
/**
 * YuanMy 桌面端 —— **agent host** 子进程入口。
 *
 * 这个进程由 Electron 主进程用**系统 node** 拉起（不是 Electron 自带的 Node，
 * 原因见 `./protocol.ts` 的模块注释：原生模块 ABI 不同），通过 child_process 的
 * IPC 通道收发消息：
 *
 *   Electron 主进程 ──(HostRequest)──▶ 本进程 ──▶ DSH 内核
 *   Electron 主进程 ◀──(HostEvent)──── 本进程 ◀── agent 事件
 *
 * 它做的事情和 CLI 的 `app/cli/main.ts` 本质相同（装凭据 → 起内核 → 驱动回合），
 * 只是把「终端渲染」换成了「结构化事件」。参数解析**直接复用 CLI 的 `parseOptions`**，
 * 所以 `--cwd` / `--model` / `--resume` 这些开关在桌面端也完全一样。
 *
 * 注意 import 顺序：`./credentials` 必须在 `@deepseek-ai/dsh-llm-deepseek` 之前
 * 把 key 写进 `process.env`，所以内核与事件桥都用动态 `import()` 延迟载入。
 *
 * @module YuanMy/desktop/host
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installApiKey, fingerprint } from '../../cli/credentials.ts'
import { parseOptions, SUPPORTED_MODELS, UsageError, type Options } from '../../cli/options.ts'
import { readSessionHistory } from './history.ts'
import { expandCommand, listCommands, matchCommand } from '../../cli/commands.ts'
import { skillRoots } from '../../cli/kernel.ts'
import { readMcpConfig } from '../../cli/mcp-config.ts'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { listProjectSessions, listWorkspaceSessions } from './sessions.ts'
import {
  PROTOCOL_VERSION,
  type CommandBrief,
  type CommandEntry,
  type FileBrief,
  type SkillBrief,
  type HostEvent,
  type HostReadyInfo,
  type HostRequest,
  type McpEntry,
  type ModelInfo,
  type SkillEntry,
} from './protocol.ts'
// 类型专用导入：只在编译期存在，不会在内核就位前求值任何 DSH 运行时模块。
import type { DesktopBridge } from './bridge.ts'
import type { Kernel } from '../../cli/kernel.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** `#` 文件索引的上限与缓存时长（见 `fileIndex()`）。 */
const FILE_INDEX_MAX = 4000
const FILE_INDEX_TTL_MS = 30_000
/** 索引时跳过的目录名（依赖、版本库、构建产物）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.cache', '.YuanMy'])

/** host 致命退出时的退出码。 */
const EXIT_FATAL = 1

/** 发出一个 UI 帧。 */
function send(event: HostEvent): void {
  if (typeof process.send === 'function') {
    process.send(event)
    return
  }
  // 没有 IPC 通道时退回 NDJSON：便于 `npm run desktop:host -- --cwd . | jq` 单独调试。
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/** 报告致命错误并退出。 */
function fatal(error: unknown): never {
  const message = error instanceof Error ? (error.message ?? String(error)) : String(error)
  send({ type: 'fatal', message })
  process.exit(EXIT_FATAL)
}

/**
 * 启动流程。
 */
/**
 * 读 provider 申报的模型目录，并**按 {@link SUPPORTED_MODELS} 过滤**。
 *
 * 适配器申报的目录更长（含 `deepseek-flash` V4.1 旧版、`…-vision-exp` 实验模型），
 * 但对用户只暴露两款主力。过滤时以本地清单的**顺序**为准（顺序即产品意图：
 * Flash 在前、Pro 在后），名称与描述优先取适配器给的（它才是权威），缺失才用兜底名。
 *
 * 拿不到目录（适配器不申报、网络异常）就退化成整份本地清单 ——
 * 下拉框依然可用，而不是只剩一个当前值。
 * @param ctx - 已装配的内核上下文。
 * @param provider - provider id。
 * @returns 可选模型列表。
 */
async function listModels(ctx: Kernel['ctx'], provider: string): Promise<ModelInfo[]> {
  const fallback: ModelInfo[] = SUPPORTED_MODELS.map(model => ({ id: model.id, name: model.name }))
  let catalog: readonly ModelInfo[]
  try {
    catalog = await ctx.llm.listModels(provider)
  } catch (error) {
    process.stderr.write(`YuanMy host: 读模型目录失败（回退到内置清单）: ${String(error)}\n`)
    return fallback
  }
  if (catalog.length === 0) return fallback
  // 以本地清单为准排序 / 过滤；描述里 provider 的说明比我们写的更准，原样带上。
  const offered: ModelInfo[] = []
  for (const wanted of SUPPORTED_MODELS) {
    const found = catalog.find(model => model.id === wanted.id)
    if (found === undefined) continue
    offered.push({
      id: wanted.id,
      name: found.name === '' ? wanted.name : found.name,
      ...(found.description === undefined || found.description === '' ? {} : { description: found.description }),
    })
  }
  // 一款都没匹配上（适配器换了模型族）时宁可露出真实目录，也别给空下拉框。
  return offered.length > 0 ? offered : [...catalog]
}

async function main(): Promise<void> {
  // ── 1. 参数：完全复用 CLI 的解析器与默认值 ──────────────────────────────
  let options: Options
  try {
    options = parseOptions(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) fatal(`参数错误: ${error.message}`)
    throw error
  }

  // ── 2. 先装凭据：DeepSeek adapter 从启动环境快照里按变量名取 key ────────
  const credential = installApiKey()

  // ── 3. 再延迟载入内核（此时环境已就绪）─────────────────────────────────
  const [kernelModule, { DesktopBridge }, { createUserMessage }] = await Promise.all([
    import('../../cli/kernel.ts'),
    import('./bridge.ts'),
    import('@deepseek-ai/dsh-llm'),
  ])
  const { bootKernel, listTools, availableMcpSpecs } = kernelModule

  // 所有工具的相对路径都以 --cwd 为基准。
  process.chdir(options.cwd)

  const kernel: Kernel = await bootKernel(options)
  const bridge: DesktopBridge = new DesktopBridge(kernel.ctx, kernel.agent, send, {
    // 桌面端总是把推理过程发给界面，由界面决定折叠还是展开。
    showReasoning: !options.noReasoning,
  })

  /** `/model` 对应的落点：由 `agent/request` waterfall 在每次请求前读取。 */
  const route: { model: string } = { model: options.model }

  // DSH 的 `agent/request` 是一次 waterfall：每个监听者都能改写即将发出的请求配置。
  // 这里用它实现「运行中切换模型」——不必重建 agent 或会话。
  const offRoute = kernel.ctx.on('agent/request', async ({ agent: subject }, next) => {
    const config: LlmCallConfig = await next()
    if (subject !== kernel.agent || config.model === route.model) return config
    return { ...config, model: route.model }
  })

  let shuttingDown = false
  /** 卸载内核：先摘监听、再收敛整棵插件树（agent、会话、子进程、文件句柄）。 */
  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    try {
      offRoute()
      bridge.dispose()
      await kernel.dispose()
    } catch (error) {
      process.stderr.write(`YuanMy host: 卸载内核失败: ${String(error)}\n`)
    } finally {
      process.exit(0)
    }
  }

  /**
   * 用户命令（`.agents/commands/*.md`）。
   *
   * 启动时读一次并缓存：改命令文件后重开应用生效 —— 命令表很小，但没必要每回合扫盘。
   */
  let commands = await listCommands(options.cwd)

  /** 落盘会话的根目录（`<stateDir>/sessions`）。 */
  const sessionsRoot = join(options.stateDir, 'sessions')

  /**
   * 「最近打开过的其他项目」——由 Electron 主进程通过环境变量传来（冒号分隔）。
   *
   * 为什么需要它：内核的 `stateDir` 默认是 `<cwd>/.YuanMy`，**每个项目一份会话库**，
   * 而这里只扫当前项目那一个根。不带上这份清单，侧栏的「项目 → 会话」树里
   * 就永远只有一个项目（换项目后上一个直接消失）。
   *
   * 只当线索用：目录存不存在、里面有什么，都由 `sessions.ts` 自己去读，
   * 读不到就跳过 —— 传进来的路径可能早就被删了。
   */
  const recentProjects = (process.env.YuanMy_PROJECT_ROOTS ?? '')
    .split(':')
    .map(path => path.trim())
    .filter(path => path !== '' && resolve(path) !== options.cwd)

  /**
   * 重新扫描落盘会话并发一个 `workspace` 帧。
   *
   * 每次回合结束后也调用它：会话的标题（第一条用户消息）与文件 mtime 都会变，
   * 侧栏列表要跟着更新。扫描是纯读盘，开销很小。
   *
   * 帧里**只有当前项目**的会话明细；其他项目的明细按需读取，见
   * {@link sendProjectSessions}。
   */
  async function sendWorkspace(): Promise<void> {
    try {
      const listing = await listWorkspaceSessions({
        root: sessionsRoot,
        cwd: options.cwd,
        currentSessionId: kernel.sessionId,
        extraProjectPaths: recentProjects,
      })
      send({ type: 'workspace', projects: listing.projects, sessions: listing.sessions })
    } catch (error) {
      // 列会话失败不该影响对话：只提示一下。
      send({
        type: 'notice',
        level: 'warn',
        message: `会话列表读取失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /**
   * 读某个项目的会话明细并发一个 `project-sessions` 帧。
   *
   * 侧栏里折叠的项目被点开时才走这条路，所以即使项目很多也不会拖慢首屏。
   * @param path - 目标项目根目录（`ProjectSummary.path`）。
   */
  async function sendProjectSessions(path: string): Promise<void> {
    try {
      const listing = await listProjectSessions({
        root: sessionsRoot,
        path,
        currentSessionId: kernel.sessionId,
        // 传当前 cwd：只有点开的正是当前项目时，才补「还没落盘」的当前会话。
        currentCwd: options.cwd,
        // 项目清单可能来自别的库，这里必须扫同样的根，否则点开会是「读不到」。
        extraProjectPaths: recentProjects,
      })
      send({
        type: 'project-sessions',
        path,
        sessions: listing?.sessions ?? [],
        // 读不到（目录被删、日志损坏）也要回一帧：界面据此结束「读取中」。
        missing: listing === undefined,
      })
    } catch (error) {
      send({ type: 'project-sessions', path, sessions: [], missing: true })
      send({
        type: 'notice',
        level: 'warn',
        message: `项目会话读取失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /**
   * 回放当前会话的历史并发一个 `history` 帧。
   *
   * 只在 `--resume <id>` 启动时走这条路：此时内核已经从日志里恢复了上下文，
   * 但界面还是空的（实时帧只会描述**之后**发生的事）。所以这里把日志读成同一套
   * `Item[]` 补上，界面整段替换 `items` 即可 —— 与官方客户端「host 提供已完成回合」
   * 的分工一致。
   *
   * 读不到日志（新建会话、日志被清理）时**什么都不发**：界面保持空白就是正确结果。
   * @param sessionId - 要回放的会话 id。
   */
  async function sendHistory(sessionId: string): Promise<void> {
    try {
      const history = await readSessionHistory({ root: sessionsRoot, sessionId })
      if (history === undefined) return
      send({
        type: 'history',
        items: history.items,
        usage: history.usage,
        turns: history.turns,
        truncatedTurns: history.truncatedTurns,
      })
      if (history.truncatedTurns > 0) {
        send({
          type: 'notice',
          level: 'info',
          message: `历史较长：只显示了最近 ${String(history.turns - history.truncatedTurns)} 个回合`
            + `（共 ${String(history.turns)} 个），更早的内容 agent 仍然记得。`,
        })
      }
    } catch (error) {
      // 回放失败只影响「看得见的历史」，对话本身照常 —— 提示一下即可。
      send({
        type: 'notice',
        level: 'warn',
        message: `历史会话读取失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /** 读文件字节数；读不到返回 0（界面上显示 0 比崩掉强）。 */
  async function fileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size
    } catch {
      return 0
    }
  }

  /**
   * 要扫的**技能目录**（设置界面用来看「盘上有什么」）。
   *
   * 直接复用 CLI 的技能目录规则（项目 `.agents/skills` + `.dsh/skills` +
   * `$YuanMy_SKILL_DIRS`），别在界面侧另写一份 —— 否则两边会漂。
   * @returns 绝对路径列表。
   */
  function skillScanDirs(cwd: string): string[] {
    return [...skillRoots(cwd), ...(process.env.YuanMy_SKILL_DIRS ?? '')
      .split(':').map(part => part.trim()).filter(part => part !== '')]
  }

  /**
   * 输入框菜单要的技能与命令（就绪时随 `ready` 一次性发过去）。
   *
   * 刻意做得轻：技能只取 `ctx.skills.list()` 的现成字段（不读正文），
   * 命令复用已经读好的命令表。菜单随时可能被敲出来，不能让首屏为它读一堆文件。
   */
  async function inputBriefs(): Promise<{ skills: SkillBrief[]; commands: CommandBrief[] }> {
    let skills: SkillBrief[] = []
    try {
      skills = (await kernel.ctx.skills.list()).map(summary => ({
        name: summary.name,
        description: summary.description,
        invocation: summary.invocation.modelInvocable
          ? 'global'
          : summary.invocation.userInvocable ? 'command' : 'user-only',
      }))
    } catch {
      // 技能表读不到不该拦住启动：菜单少一组而已
    }
    return {
      skills,
      commands: commands.map(def => ({
        name: def.name,
        description: def.description,
        argsHint: def.argsHint,
      })),
    }
  }

  /**
   * 工作目录下的**可引用文件**索引（`#` 菜单）。
   *
   * 三条约束，都是为了「按一次键不能卡住」：
   *   - **有界**：最多 {@link FILE_INDEX_MAX} 个，超过就停；
   *   - **跳过噪声**：`node_modules` / `.git` / 构建产物 / 点目录；
   *   - **缓存**：{@link FILE_INDEX_TTL_MS} 内复用，避免每敲一个字就重走一遍目录树。
   */
  let fileIndexCache: { at: number; files: string[] } | undefined

  /** 走一遍工作目录，产出相对路径清单（带缓存与上限）。 */
  async function fileIndex(): Promise<string[]> {
    const now = Date.now()
    if (fileIndexCache !== undefined && now - fileIndexCache.at < FILE_INDEX_TTL_MS) return fileIndexCache.files
    const files: string[] = []
    const queue: string[] = ['']
    while (queue.length > 0 && files.length < FILE_INDEX_MAX) {
      const rel = queue.shift() ?? ''
      const abs = rel === '' ? options.cwd : join(options.cwd, rel)
      let entries
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (files.length >= FILE_INDEX_MAX) break
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          // 点目录与依赖/产物目录不进索引：`#` 菜单里它们只会淹没有用结果
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
          queue.push(child)
          continue
        }
        if (!entry.isFile()) continue
        files.push(child)
      }
    }
    fileIndexCache = { at: now, files }
    return files
  }

  /**
   * 按关键字挑文件。
   *
   * 排序规则：**匹配位置越靠前越优先**，同位置按路径短的优先 ——
   * 敲 `#comp` 时 `app/desktop/.../composer.tsx` 应该排在
   * `docs/old/components-composer.md` 前面。点文件（`.DS_Store`、`.gitignore`）
   * 在同位置里再往后压一档：它们路径最短，不压的话「刚打出一个 `#`、还没说要找什么」
   * 时前几条全是点文件，看着像坏了。
   *
   * 分数就是「(匹配位置, 是否点文件, 路径长度) 三元组」压成一个整数（依次比较）。
   */
  async function filesMatching(query: string, limit: number): Promise<FileBrief[]> {
    const needle = query.toLowerCase()
    const files = await fileIndex()
    const scored: { path: string; score: number }[] = []
    for (const path of files) {
      const at = path.toLowerCase().indexOf(needle)
      if (at === -1) continue
      const name = path.slice(path.lastIndexOf('/') + 1)
      const dot = name.startsWith('.') ? 1 : 0
      scored.push({ path, score: (at * 2 + dot) * 10_000 + path.length })
    }
    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, limit).map(item => ({ path: item.path, kind: 'file' as const }))
  }

  /**
   * 收集设置界面的数据并发一帧 `settings`。
   *
   * 三样东西来源不同，但界面要一起看：
   *   - **skill**：问内核的注册表（`ctx.skills`）。注意 `list()` 返回的是
   *     「调用方式中立」的全集 —— 命令专用（`disable-model-invocation`）的 skill
   *     也在里面，靠 `invocation` 政策区分，这正是界面要显示的东西；
   *   - **命令**：复用 CLI 的命令层（`.agents/commands/*.md`），顺便刷新缓存；
   *   - **MCP**：内置定义 + 项目目录定义 + `<cwd>/.YuanMy/mcp.json` 的开关。
   *
   * 单个 skill 读失败（文件被删等）只跳过它，不让整张表消失。
   */
  async function sendSettings(): Promise<void> {
    const skills: SkillEntry[] = []
    try {
      const summaries: readonly SkillSummary[] = await kernel.ctx.skills.list()
      for (const summary of summaries) {
        let path = ''
        let bytes = 0
        try {
          const full = await kernel.ctx.skills.get(summary.name)
          path = full?.path ?? ''
          // 统一按「文件字节数」展示：兜底那条（下面扫盘加的）也是这么量的，
          // 两条路径的数字要能互相比较，否则界面上一个 3928 一个 4196 看着像两个人写的。
          bytes = path === '' ? (full?.content.length ?? 0) : await fileSize(path)
        } catch {
          // 读不到正文不影响列表：名字与政策已经够界面用了
        }
        const invocation: SkillEntry['invocation'] = summary.invocation.modelInvocable
          ? 'global'
          : summary.invocation.userInvocable ? 'command' : 'user-only'
        skills.push({
          name: summary.name,
          description: summary.description,
          invocation,
          modelInvocable: summary.invocation.modelInvocable,
          userInvocable: summary.invocation.userInvocable,
          source: String(summary.source),
          path,
          bytes,
        })
      }
    } catch (error) {
      send({
        type: 'notice',
        level: 'warn',
        message: `读技能表失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }

    // 盘上有、内核却没加载的 skill：多半是 frontmatter 坏了（provider 只 warn 一句就忽略）。
    // 从界面上看这是「文件在、技能不生效」，最需要被指出来。
    const loaded = new Set(skills.map(skill => skill.name))
    for (const dir of skillScanDirs(options.cwd)) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || loaded.has(entry.name)) continue
        const file = join(dir, entry.name, 'SKILL.md')
        const bytes = await fileSize(file)
        try {
          await readFile(file, 'utf8')
        } catch {
          continue // 没有 SKILL.md 的目录不是技能
        }
        skills.push({
          name: entry.name,
          description: '',
          invocation: 'global',
          modelInvocable: false,
          userInvocable: false,
          source: 'disk',
          path: file,
          bytes,
          warning: '内核没有加载这个技能：frontmatter 不合法或缺少 name / description（改完保存即可重试）。',
        })
      }
    }

    // 顺手刷新命令表：打开设置界面往往就是「刚改完命令想看看」。
    commands = await listCommands(options.cwd)
    const commandEntries: CommandEntry[] = await Promise.all(commands.map(async def => ({
      name: def.name,
      description: def.description,
      argsHint: def.argsHint,
      scope: def.scope,
      path: def.path,
      includes: [...def.includes],
      bytes: await fileSize(def.path),
    })))

    const config = readMcpConfig(options.cwd)
    const specs = availableMcpSpecs(options.cwd)
    const fromEnv = new Set(
      (process.env.YuanMy_MCP ?? '').split(':').map(part => part.trim()).filter(part => part !== ''),
    )
    const mcp: McpEntry[] = []
    const names = [...new Set([...Object.keys(specs), ...config.entries.map(entry => entry.name)])]
    for (const name of names) {
      const entry = config.entries.find(item => item.name === name)
      const spec = specs[name]
      const enabled = entry !== undefined ? entry.enabled : fromEnv.has(name)
      const reason: McpEntry['reason'] = entry !== undefined ? (entry.enabled ? 'config' : 'off') : fromEnv.has(name) ? 'env' : 'off'
      const transport = entry?.transport ?? spec?.transport ?? 'stdio'
      mcp.push({
        name,
        enabled,
        reason,
        transport,
        command: entry?.command ?? spec?.command ?? '',
        args: [...(entry?.args ?? spec?.args ?? [])],
        url: entry?.url ?? spec?.url ?? '',
        forwardEnv: [...(entry?.forwardEnv ?? spec?.forwardEnv ?? [])],
        source: entry !== undefined && spec === undefined ? 'config' : (spec?.origin ?? 'config'),
      })
    }

    send({
      type: 'settings',
      skills,
      commands: commandEntries,
      mcp,
      mcpConfigPath: config.path,
      ...(config.error === undefined ? {} : { mcpConfigError: config.error }),
    })
  }

  /**
   * 跑完一个回合。
   * `whenIdle()` 不会因为模型 / 工具失败而 reject（内核在驱动边界吞掉了异常），
   * 所以真实结果要从事件里读 —— 也就是 bridge 记录的 outcome。
   */
  async function runTurn(turnId: string, text: string): Promise<void> {
    const startedAt = Date.now()
    bridge.startTurn(turnId)
    // `/命令`：把命令正文（以及它内联的文件）作为**这一回合**的用户消息发出去。
    // 命令表为空时（没写过命令）这里完全不介入，行为与以前一致。
    let outgoing = text
    const hit = matchCommand(text, commands)
    if (hit !== undefined) {
      const expanded = await expandCommand(hit.def, hit.args)
      outgoing = expanded.text
      for (const path of expanded.missing) {
        send({ type: 'notice', level: 'warn', message: `命令 /${hit.def.name} 引用的文件读不到：${path}` })
      }
    }
    kernel.agent.followup(createUserMessage({
      content: [{ type: 'text', text: outgoing }],
      // `source` 是 DSH 的必填来源标记：`kind: 'user'` 表示真人输入。
      source: { kind: 'user' },
    }))
    await kernel.agent.whenIdle()
    const stats = bridge.finishTurn()
    send({
      type: 'turn-end',
      turnId,
      outcome: stats.outcome,
      error: stats.error,
      text: stats.text,
      toolCalls: stats.toolCalls,
      durationMs: Date.now() - startedAt,
    })
    // 本轮让会话日志变了：刷新侧栏的会话清单。
    await sendWorkspace()
  }

  // ── 4. 串行队列：界面禁用了并发输入，但协议层仍然保证回合不交叉 ────────
  let queue: Promise<void> = Promise.resolve()

  function handleRequest(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const request = raw as HostRequest
    switch (request.type) {
      case 'prompt': {
        const { turnId, text } = request
        queue = queue.then(
          () => runTurn(turnId, text),
          () => runTurn(turnId, text),
        ).catch((error: unknown) => {
          // 单轮失败不影响后续回合：把错误作为提示发给界面。
          const message = error instanceof Error ? error.message : String(error)
          send({ type: 'turn-end', turnId, outcome: 'error', error: message, text: '', toolCalls: 0, durationMs: 0 })
        })
        break
      }
      case 'cancel':
        kernel.agent.cancel({ kind: 'user' })
        break
      case 'steer': {
        // 中途调整目标：交给内核的 steer —— 运行中的回合会在下一个 step 边界消费它。
        // 这里**不排队**（不走 queue）：排队就变成「等这轮跑完再说」，正是要改掉的行为。
        const message = createUserMessage({
          content: [{ type: 'text', text: request.text }],
          source: { kind: 'user' },
        })
        try {
          kernel.agent.steer(message)
        } catch (error) {
          send({
            type: 'notice',
            level: 'warn',
            message: `没能把这条目标调整交给内核：${error instanceof Error ? error.message : String(error)}`,
          })
        }
        break
      }
      case 'files:list': {
        const query = request.query
        void filesMatching(query, Math.min(request.limit ?? 20, 50)).then(
          items => { send({ type: 'files', query, items }) },
          () => { send({ type: 'files', query, items: [] }) },
        )
        break
      }
      case 'settings:list':
        void sendSettings()
        break
      case 'list-sessions':
        void sendWorkspace()
        break
      case 'list-project-sessions':
        void sendProjectSessions(request.path)
        break
      case 'set-model':
        route.model = request.model
        send({ type: 'model-changed', model: request.model })
        break
      case 'shutdown':
        void shutdown()
        break
      default:
        break
    }
  }

  process.on('message', handleRequest)
  // 父进程（Electron）退出时 IPC 通道断开：这是最后一道「不留孤儿进程」的保险。
  process.on('disconnect', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })

  // ── 5. 就绪：把渲染侧栏所需的一切一次性发过去 ──────────────────────────
  const info: HostReadyInfo = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: kernel.sessionId,
    provider: options.provider,
    model: route.model,
    cwd: options.cwd,
    persist: options.persist,
    credential: credential === undefined
      ? '未找到（首次请求会失败）'
      : `${credential.origin} ${fingerprint(credential.key)}`,
    tools: listTools(kernel.ctx),
    models: await listModels(kernel.ctx, options.provider),
    ...await inputBriefs(),
    nodeVersion: process.version,
  }
  send({ type: 'ready', info })
  if (credential === undefined) {
    send({
      type: 'notice',
      level: 'warn',
      message: '未找到 DeepSeek API key：可直接在界面里使用，但第一次请求会失败。'
        + ' 任选一种方式提供：export DEEPSEEK_API_KEY=… / export YuanMy_API_KEY=… / 使用 ~/.dsh/.credentials.yaml。',
    })
  }
  // 就绪后立刻把项目 / 会话清单推给侧栏。
  await sendWorkspace()
  // 恢复会话时再把历史记录补上（顺序在 workspace 之后：侧栏先出来，历史随后填充）。
  if (options.resume !== undefined) await sendHistory(options.resume)
}

try {
  await main()
} catch (error) {
  fatal(error)
}
