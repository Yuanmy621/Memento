#!/usr/bin/env node
/**
 * Memento 桌面端 —— **agent host** 子进程入口。
 *
 * 由 Electron 主进程用**系统 node** 拉起（原生模块 ABI 的原因见 `./protocol.ts`），通过 child_process 的 IPC
 * 通道收发 `HostRequest` / `HostEvent`；职责与 CLI 的 `app/cli/main.ts` 相同（装凭据 → 起内核 → 驱动回合），参数
 * 解析复用 CLI 的 `parseOptions`；import 顺序有约束：`./credentials` 要先于
 * `@deepseek-ai/dsh-llm-deepseek` 写 key 进 `process.env`，内核与事件桥因此用动态 `import()` 延迟载入。
 *
 * @module Memento/desktop/host
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installApiKey, installCredentials, PLUGIN_CREDENTIAL_REFS, fingerprint } from '../../cli/credentials.ts'
import { parseOptions, EFFORTS, SUPPORTED_MODELS, UsageError, type Effort, type Options } from '../../cli/options.ts'
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
  type ModelEffortInfo,
  type ModelInfo,
  type SessionUsage,
  type SkillEntry,
} from './protocol.ts'
// 类型专用导入：只在编译期存在，不会在内核就位前求值运行时模块。
import type { DesktopBridge } from './bridge.ts'
import type { Kernel } from '../../cli/kernel.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** 空的历史统计：新建会话 / 读不到日志时用它发一帧空历史。 */
const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  calls: 0,
}

/** `#` 文件索引的上限与缓存时长（见 `fileIndex()`）。 */
const FILE_INDEX_MAX = 4000
const FILE_INDEX_TTL_MS = 30_000
/** 索引时跳过的目录名（依赖、版本库、构建产物）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.cache', '.Memento'])

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
 * 读 provider 申报的模型目录，并按 {@link SUPPORTED_MODELS} 过滤。
 *
 * 适配器申报的目录更长（含旧版与实验模型），这里只暴露本地清单里的两款主力；顺序以本地
 * 清单为准（Flash 在前、Pro 在后），名称与描述优先取适配器给的（它才是权威），缺失才用兜底名。
 * 拿不到目录（适配器不申报、网络异常）就退回整份本地清单，下拉框仍然可用。
 */
async function listModels(ctx: Kernel['ctx'], provider: string): Promise<ModelInfo[]> {
  const fallback: ModelInfo[] = SUPPORTED_MODELS.map(model => ({ id: model.id, name: model.name }))
  let catalog: readonly ModelInfo[]
  try {
    catalog = await ctx.llm.listModels(provider)
  } catch (error) {
    process.stderr.write(`Memento host: 读模型目录失败（回退到内置清单）: ${String(error)}\n`)
    return fallback
  }
  if (catalog.length === 0) return fallback
  // 以本地清单为准排序 / 过滤；描述优先用 provider 给的，它比本地兜底名准确。
  const offered: ModelInfo[] = []
  for (const wanted of SUPPORTED_MODELS) {
    const found = catalog.find(model => model.id === wanted.id)
    if (found === undefined) continue
    offered.push({
      id: wanted.id,
      name: found.name === '' ? wanted.name : found.name,
      ...(found.description === undefined || found.description === '' ? {} : { description: found.description }),
      ...await modelEfforts(ctx, provider, wanted.id),
    })
  }
  // 一款都没匹配上（适配器换了模型族）时宁可露出真实目录，也别给空下拉框。
  return offered.length > 0 ? offered : [...catalog]
}

/**
 * 问适配器要一个模型的可选推理强度。
 *
 * 强度是模型能力（`resolveModelInfo` 才会给出 `reasoning.efforts`），`listModels` 的目录里
 * 没有这一项，所以逐个 exact-route 解析一次；解析失败就不带这一项（返回空对象），界面会退回
 * 内置兜底，而不是显示一个空的下拉框。
 */
async function modelEfforts(
  ctx: Kernel['ctx'],
  provider: string,
  model: string,
): Promise<{ efforts?: readonly ModelEffortInfo[] }> {
  try {
    const resolved = await ctx.llm.resolveModelInfo(provider, model)
    const efforts = resolved.reasoning?.efforts
    if (efforts === undefined || efforts.length === 0) return {}
    return {
      efforts: efforts.map(effort => ({
        id: effort.id,
        name: effort.name,
        ...(effort.description === undefined || effort.description === '' ? {} : { description: effort.description }),
      })),
    }
  } catch (error) {
    process.stderr.write(`Memento host: 读模型 ${model} 的推理强度失败（界面用内置兜底）: ${String(error)}\n`)
    return {}
  }
}

async function main(): Promise<void> {
  // 参数：复用 CLI 的解析器与默认值。
  let options: Options
  try {
    options = parseOptions(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) fatal(`参数错误: ${error.message}`)
    throw error
  }

  // 先装凭据：DeepSeek adapter 从启动环境快照里按变量名取 key。
  const credential = installApiKey()

  // 插件要的额外 key（system-one 的 TYPESAFE_API_KEY）。
  // 桌面端从 Finder/Dock 启动时拿不到 shell 的 export，这一步让
  // `~/.dsh/.credentials.yaml` 成为打包形态下唯一还能生效的配置来源。
  // 缺了不算错误：插件挂载时会自己打警告，工具被调用时才报错。
  installCredentials(PLUGIN_CREDENTIAL_REFS)

  // 环境就绪后再延迟载入内核。
  const [kernelModule, { DesktopBridge }, { createUserMessage, ReasoningEffortId }] = await Promise.all([
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

  /**
   * 「下一次请求用什么模型 / 什么推理强度」的落点。
   *
   * 由 `agent/request` waterfall 在每次请求前读取 —— 界面改这两个值只改这里，
   * **不重建 agent、也不打断正在跑的回合**（已经飞出去的那次请求带着旧值）。
   */
  const route: { model: string; effort: Effort } = { model: options.model, effort: options.effort }

  // `agent/request` 是一次 waterfall：每个监听者都能改写即将发出的请求配置。
  // 用它实现运行中切换模型 / 推理强度，不需要重建 agent 或会话。
  const offRoute = kernel.ctx.on('agent/request', async ({ agent: subject }, next) => {
    const config: LlmCallConfig = await next()
    if (subject !== kernel.agent) return config
    const model = config.model === route.model ? undefined : route.model
    // 强度用 `ReasoningEffortId`（品牌字符串）；route 里存的是 CLI 的 `Effort`，取值同一套。
    const effort = config.reasoningEffort === route.effort
      ? undefined
      : ReasoningEffortId(route.effort)
    if (model === undefined && effort === undefined) return config
    return {
      ...config,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
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
      process.stderr.write(`Memento host: 卸载内核失败: ${String(error)}\n`)
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
   * 内核的 `stateDir` 默认是 `<cwd>/.Memento`，每个项目一份会话库，而这里只扫当前项目
   * 那一个根；不带上这份清单，侧栏的「项目 → 会话」树里就永远只有一个项目。
   * 只当线索用：目录存不存在、里面有什么由 `sessions.ts` 自己去读，读不到就跳过 ——
   * 传进来的路径可能已经被删了。
   */
  const recentProjects = (process.env.Memento_PROJECT_ROOTS ?? '')
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
   * 读某个项目的会话明细并发一个 `project-sessions` 帧（`path` 是 `ProjectSummary.path`）。
   *
   * 侧栏里折叠的项目被点开时才走这条路，所以即使项目很多也不会拖慢首屏。
   */
  async function sendProjectSessions(path: string): Promise<void> {
    try {
      const listing = await listProjectSessions({
        root: sessionsRoot,
        path,
        currentSessionId: kernel.sessionId,
        // 传当前 cwd：只有点开的正是当前项目时，才补「还没落盘」的当前会话。
        currentCwd: options.cwd,
        // 项目清单可能来自别的库，这里要扫同样的根，否则点开会是「读不到」。
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
   * 只在 `--resume <id>` 启动时走这条路：此时内核已经从日志里恢复了上下文，但界面还是空的
   * （实时帧只描述之后发生的事），所以这里把日志读成同一套 `Item[]` 补上。
   *
   * 读不到日志（新建会话、日志被清理）时照发一帧空历史，见下面那段注释；没有 resume 的新会话
   * 传 `undefined`。
   */
  async function sendHistory(sessionId: string | undefined): Promise<void> {
    try {
      const history = sessionId === undefined
        ? undefined
        : await readSessionHistory({ root: sessionsRoot, sessionId })
      /**
       * 不管有没有日志都要发这一帧：界面把 `history` 当作「内容现在是这些」的唯一信号，
       * 收到才整段替换 `items`。新建会话没有日志，缺了这一帧，界面只能靠 `restarting`
       * 清空内容，而 `restarting` 在发出请求时就到 —— 切换会话会先白一下、占位文案闪一下、
       * 统计与模型下拉归零，再等内容回填。
       */
      send({
        type: 'history',
        items: history?.items ?? [],
        usage: history?.usage ?? EMPTY_USAGE,
        turns: history?.turns ?? 0,
        truncatedTurns: history?.truncatedTurns ?? 0,
      })
      if (history !== undefined && history.truncatedTurns > 0) {
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
   * 要扫的技能目录（设置界面用来看「盘上有什么」）。
   *
   * 复用 CLI 的技能目录规则（项目 `.agents/skills` + `.dsh/skills` + `$Memento_SKILL_DIRS`），
   * 界面侧另写一份会与它漂移；返回绝对路径列表。
   */
  function skillScanDirs(cwd: string): string[] {
    return [...skillRoots(cwd), ...(process.env.Memento_SKILL_DIRS ?? '')
      .split(':').map(part => part.trim()).filter(part => part !== '')]
  }

  /**
   * 输入框菜单要的技能与命令（就绪时随 `ready` 一次性发过去）。
   *
   * 保持轻量：技能只取 `ctx.skills.list()` 的现成字段（不读正文），命令复用已经读好的
   * 命令表。菜单随时可能被敲出来，首屏不该为它读一堆文件。
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
   * 三条约束都为了保证按一次键不卡住：最多 {@link FILE_INDEX_MAX} 个；跳过噪声目录
   * （`node_modules` / `.git` / 构建产物 / 点目录）；{@link FILE_INDEX_TTL_MS} 内复用缓存。
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
   * 排序按「匹配位置 → 是否点文件 → 路径长度」依次比较：位置越靠前越优先，同位置路径短的
   * 优先；点文件再往后压一档，否则刚打出一个 `#`、还没说要找什么时，前几条全是点文件。
   * 三者压进一个整数比较。
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
   * 三样东西来源不同：skill 问内核注册表（`ctx.skills`，`list()` 返回调用方式中立的全集，
   * 命令专用的也在里面，靠 `invocation` 区分）；命令复用 CLI 的命令层
   * （`.agents/commands/*.md`）并顺便刷新缓存；MCP 是内置定义 + 项目目录定义 +
   * `<cwd>/.Memento/mcp.json` 的开关。单个 skill 读失败只跳过它，不让整张表消失。
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
          // 统一按文件字节数展示：下面扫盘兜底的那条也是这么量的，
          // 两条路径给出的数字要能互相比较。
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

    // 盘上有、内核却没加载的 skill：多半是 frontmatter 坏了（provider 只 warn 一句就忽略），
    // 界面上表现为「文件在、技能不生效」，最需要被指出来。
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
      (process.env.Memento_MCP ?? '').split(':').map(part => part.trim()).filter(part => part !== ''),
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
    // 命令表为空时（没写过命令）这里不介入，直接发原文。
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
      // `source` 的 `kind: 'user'` 表示真人输入。
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

  // 串行队列：界面已禁用并发输入，协议层仍保证回合不交叉。
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
        // 这里不走 queue：排队会变成「等这轮跑完再说」，与 steer 的语义相反。
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
      /**
       * 重放当前会话的历史（界面重载后补内容用）。
       *
       * 用 `kernel.sessionId` 而不是 `options.resume`：新建会话（没给 `--resume`）
       * 也有自己的 id，重放它才是「当前这个会话」。
       */
      case 'history:replay':
        void sendHistory(kernel.sessionId)
        break
      case 'set-model':
        route.model = request.model
        send({ type: 'model-changed', model: request.model })
        break
      case 'set-effort':
        // 取值由 CLI 的 `EFFORTS` 兜底校验（界面只可能给出适配器申报过的值）。
        route.effort = (EFFORTS as readonly string[]).includes(request.effort)
          ? request.effort as Effort
          : route.effort
        send({ type: 'effort-changed', effort: route.effort })
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

  // 就绪：把渲染侧栏所需的信息一次性发过去。
  const info: HostReadyInfo = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: kernel.sessionId,
    provider: options.provider,
    model: route.model,
    effort: route.effort,
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
        + ' 任选一种方式提供：export DEEPSEEK_API_KEY=… / export Memento_API_KEY=… / 使用 ~/.dsh/.credentials.yaml。',
    })
  }
  // 就绪后立刻把项目 / 会话清单推给侧栏。
  await sendWorkspace()
  // 历史记录最后补上（顺序在 workspace 之后：侧栏先出来，历史随后填充）。
  // 新会话（没有 resume）也会得到一帧空历史，界面靠它把内容清空，
  // 所以这一步不能省（见 `sendHistory` 的注释）。
  await sendHistory(options.resume)
}

try {
  await main()
} catch (error) {
  fatal(error)
}
