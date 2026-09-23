/**
 * Memento 内核：用 cordis 手工装配 agent 内核。
 *
 * 根上下文就是 `new Context()`，没有 `App`、没有 `ctx.start()`；`await ctx.plugin(X)`
 * 在 X 的 `inject` 依赖未就绪时不报错而是停在 PENDING，所以插件要按依赖顺序逐个
 * await 挂载。真正的抽象 seam 只有一个：LLM adapter（`dsh-llm-deepseek`）。
 *
 * @module Memento/kernel
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

// —— agent 内核 ——
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

// —— 模型接入 ——
import DeepSeekApiExtensions from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as DeepSeekLlm from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'

// —— 执行能力（本地 provider）——
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import SpillLocal from '@deepseek-ai/dsh-spill-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'

// —— 会话持久化 ——
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

// —— 技能（skill）：把 .agents/skills 下的可复用指令喂给模型 ——
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'

// —— 模型可见的工具 ——
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
// 外部 MCP 服务器（可选挂载）：它把 MCP 服务器的工具注册成 `mcp__<名字>__<工具>`。
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

// —— Memento 自己的扩展 ——
import * as customTools from './tools.ts'
// System One 决策原语
import * as SystemOne from '../plugins/system-one/index.ts'
import { installPromptSections, personaText } from './prompt.ts'
import { readMcpConfig, type McpConfigEntry } from './mcp-config.ts'
import type { Options } from './options.ts'

/** 内核启动结果。 */
export interface Kernel {
  /** 根上下文；`dispose()` 时被整体卸载。 */
  readonly ctx: Context
  /** 本次运行驱动的 agent。 */
  readonly agent: Agent
  /** agent/session 共用的身份 id。 */
  readonly sessionId: string
  /** 卸载整棵插件树（含 agent、会话、子进程等）。 */
  readonly dispose: () => Promise<void>
}

/** agent 循环必需的服务名。 */
const REQUIRED_SERVICES = ['llm', 'sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents', 'agentLoop', 'skills'] as const

/**
 * 项目的技能目录：显式取 `cwd` 下的 `<项目根>/.agents/skills/<名字>/SKILL.md`，不交给
 * provider 自己推断项目根（它取最近的 `.git` 祖先），于是换 `--cwd` 即换技能集。
 */
export function skillRoots(cwd: string): string[] {
  // `.dsh/skills` 是优先级更高的项目级技能目录（rank 100），一并扫描。
  return [join(cwd, '.agents', 'skills'), join(cwd, '.dsh', 'skills')]
}

/** `skillRoots()` 的别名。 */
function skillDirs(cwd: string): string[] {
  return skillRoots(cwd)
}

/** 把追加的技能目录包成 `dsh-skill-filesystem` Config 片段。 */
function skillDirsFromEnv(): { customSkillDirs?: string[] } {
  const dirs = extraSkillDirs()
  return dirs.length === 0 ? {} : { customSkillDirs: dirs }
}

/** `$Memento_SKILL_DIRS` 里追加的技能目录（设置界面扫盘也要用同一份）。 */
function extraSkillDirs(): string[] {
  const extra = process.env.Memento_SKILL_DIRS?.trim()
  if (extra === undefined || extra === '') return []
  return extra.split(':').map(part => part.trim()).filter(part => part !== '')
}

/** 生成一个新的会话 id。 */
function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  return `Memento-${stamp}-${rand}`
}

/** 按依赖顺序挂载一个插件，失败时带上可读的插件名。 */
async function mount(ctx: Context, label: string, plugin: unknown, config?: unknown): Promise<void> {
  try {
    // cordis 的 plugin() 既接受 Service 类，也接受 `{ name, inject, apply }` 形状的插件模块。
    await ctx.plugin(plugin as never, config as never)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`挂载插件 ${label} 失败: ${reason}`, { cause: error })
  }
}

/**
 * 内置的 MCP 服务器登记表：只登记本仓库自带的服务器（`app/mcp/butian/`），用当前 node
 * 配合 `--experimental-strip-types` 直接跑 TS；Electron 的二进制跑不了 Node API。
 */
export function availableMcpSpecs(cwd: string): Record<string, McpSpec> {
  // app/cli/kernel.ts → ../mcp/butian/server.ts
  const here = import.meta.dirname
  return {
    butian: {
      serverName: 'butian',
      transport: 'stdio',
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        join(here, '..', 'mcp', 'butian', 'server.ts'),
      ],
      // MCP 客户端用清洗过的父环境起子进程（KEY/PASSWORD/SECRET/TOKEN 之类的名字会被
      // 丢掉），凭据因此要在这里显式转发。`BUTIAN_COOKIE` 恰好不在清洗规则里，但依赖这个巧合太脆。
      forwardEnv: ['BUTIAN_COOKIE'],
      title: '补天 butian.net（只读）',
      origin: 'builtin',
    },
    vulbox: {
      serverName: 'vulbox',
      transport: 'stdio',
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        join(here, '..', 'mcp', 'vulbox', 'server.ts'),
      ],
      // 同 butian：MCP 客户端用清洗过的环境起子进程，凭据要显式转发。
      // `VULBOX_COOKIE_FILE` 给「凭据不放在默认路径」的场景用，冒烟测试也用它。
      forwardEnv: ['VULBOX_COOKIE', 'VULBOX_COOKIE_FILE', 'VULBOX_PORTAL'],
      title: '漏洞盒子 vulbox.com（只读）',
      origin: 'builtin',
    },
    // 工作目录里的自定义 MCP server：`<cwd>/.Memento/mcp/<名字>.ts`
    ...customMcpSpecs(cwd),
  }
}

/** 一个 MCP 服务器的启动方式（两种传输共用）。 */
export interface McpSpec {
  /** MCP 里的命名空间：工具会变成 `mcp__<serverName>__<工具>`。 */
  readonly serverName: string
  /** 传输方式；缺省按 stdio 处理（本地子进程）。 */
  readonly transport?: 'stdio' | 'streamable-http'
  /** stdio：可执行文件。 */
  readonly command?: string
  /** stdio：参数。 */
  readonly args?: readonly string[]
  /** 显式转发给子进程的环境变量名。 */
  readonly forwardEnv?: readonly string[]
  /** streamable-http：端点。 */
  readonly url?: string
  /** streamable-http：请求头。 */
  readonly headers?: Readonly<Record<string, string>>
  /** 只用于日志。 */
  readonly title: string
  /** 定义来自哪里（设置界面用来显示「内置」还是「项目目录」）。 */
  readonly origin?: 'builtin' | 'project'
}

/**
 * 工作目录里的自定义 MCP server：`<cwd>/.Memento/mcp/<名字>.ts`。
 *
 * 丢一个 TS 文件进目录、在 `$Memento_MCP` 里写上名字即可，不需要重新构建。
 */
function customMcpSpecs(cwd: string): Record<string, McpSpec> {
  const dir = join(cwd, '.Memento', 'mcp')
  if (!existsSync(dir)) return {}
  const specs: Record<string, McpSpec> = {}
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') && !entry.endsWith('.js')) continue
    const name = entry.replace(/\.(ts|js)$/, '')
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) continue
    specs[name] = {
      serverName: name,
      command: process.execPath,
      args: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(dir, entry)],
      title: `${name}（${dir}）`,
      origin: 'project',
    }
  }
  return specs
}

/**
 * 按 `$Memento_MCP` 与 `<cwd>/.Memento/mcp.json` 挂载外部 MCP 服务器；每挂一个都会起
 * 子进程并占用每次请求的上下文，故默认关闭。`enabled: false` 的条目强制关掉，盖过前两者。
 */
async function mountMcpServers(ctx: Context, options: Options): Promise<string[]> {
  const config = readMcpConfig(options.cwd)
  if (config.error !== undefined) {
    process.stderr.write(`Memento: MCP 配置文件解析失败（已忽略）：${config.path} — ${config.error}\n`)
  }
  const specs = availableMcpSpecs(options.cwd)
  const disabled = new Set(config.entries.filter(entry => !entry.enabled).map(entry => entry.name))

  // 名字 → 启动方式：配置里的内联定义优先，其次内置/项目目录
  const wanted: { name: string; spec: McpSpec }[] = []
  const fromEnv = (process.env.Memento_MCP ?? '')
    .split(':')
    .map(part => part.trim())
    .filter(part => part !== '')
  const names = [...new Set([...fromEnv, ...config.entries.filter(entry => entry.enabled).map(entry => entry.name)])]

  for (const name of names) {
    if (disabled.has(name)) continue
    const entry: McpConfigEntry | undefined = config.entries.find(item => item.name === name)
    const base = specs[name]
    const spec = mergeSpec(name, entry, base)
    if (spec === undefined) {
      process.stderr.write(
        `Memento: 未知的 MCP 服务器 "${name}"（配置文件里也没有它的启动参数），可用: ${Object.keys(specs).join(', ') || '（无）'}\n`,
      )
      continue
    }
    wanted.push({ name, spec })
  }

  const mounted: string[] = []
  for (const { name, spec } of wanted) {
    const env: Record<string, string> = {}
    for (const key of spec.forwardEnv ?? []) {
      const value = process.env[key]
      if (value !== undefined && value !== '') env[key] = value
    }
    // 桌面端打包后 host 以 `ELECTRON_RUN_AS_NODE=1` 运行，MCP 子进程用的也是同一个
    // Electron 二进制；缺这个变量时子进程会以 GUI 应用身份启动，不报错也不干活，工具连不上。
    if (process.versions.electron !== undefined && process.env.ELECTRON_RUN_AS_NODE !== undefined) {
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    if (spec.transport === 'streamable-http') {
      if (spec.url === undefined) {
        process.stderr.write(`Memento: MCP 服务器 "${name}" 声明了 streamable-http 但没有 url，跳过。\n`)
        continue
      }
      await mount(ctx, `mcp:${name}`, McpClient, {
        transport: 'streamable-http',
        serverName: spec.serverName,
        url: spec.url,
        headers: { ...(spec.headers ?? {}) },
      })
    } else {
      await mount(ctx, `mcp:${name}`, McpClient, {
        transport: 'stdio',
        serverName: spec.serverName,
        command: spec.command ?? process.execPath,
        args: [...(spec.args ?? [])],
        env,
        cwd: options.cwd,
      })
    }
    mounted.push(name)
    process.stderr.write(`Memento: 已挂载 MCP 服务器 ${spec.title}\n`)
  }
  return mounted
}

/**
 * 合并「配置文件条目」与「内置/项目目录定义」，配置里写了的字段覆盖 base ——
 * 于是只写 `{ "name": "butian", "enabled": true }` 也能用。
 */
function mergeSpec(name: string, entry: McpConfigEntry | undefined, base: McpSpec | undefined): McpSpec | undefined {
  if (entry === undefined) return base
  const transport = entry.transport ?? base?.transport ?? 'stdio'
  const command = entry.command ?? base?.command
  const url = entry.url ?? base?.url
  if (transport === 'streamable-http') {
    if (url === undefined) return undefined
    return {
      serverName: name,
      transport,
      url,
      headers: entry.headers ?? base?.headers ?? {},
      title: base?.title ?? `${name}（来自 mcp.json）`,
    }
  }
  if (command === undefined) return undefined
  return {
    serverName: name,
    transport: 'stdio',
    command,
    args: entry.args ?? base?.args ?? [],
    forwardEnv: entry.forwardEnv ?? base?.forwardEnv ?? [],
    title: base?.title ?? `${name}（来自 mcp.json）`,
  }
}

/** 启动内核：装配插件树，然后创建或恢复 agent。 */
export async function bootKernel(options: Options): Promise<Kernel> {
  const ctx = new Context()

  // ── 1. agent 内核：cordis 服务按依赖顺序就位 ─────────────────────────────
  await mount(ctx, 'dsh-llm', LlmRuntime)
  await mount(ctx, 'dsh-session', SessionStore)
  await mount(ctx, 'dsh-session-projection', SessionProjectionRegistry)
  await mount(ctx, 'dsh-system-prompt', SystemPrompt, {
    includeHarnessIdentity: true,
    includeRuntimeContext: true,
    personaPrefix: personaText(),
  })
  // ToolRuntime.inject = ['systemPrompt']：工具 schema 在组装 system prompt 时汇总，
  // 注册表要晚于 systemPrompt 挂载。
  await mount(ctx, 'dsh-tools', ToolRuntime)
  await mount(ctx, 'dsh-agent', AgentRegistry)

  // ── 1.5 技能注册表与本地 provider ──────────────────────────────────────
  // `dsh-skill` 只提供注册表（`ctx.skills`），本身不含任何技能内容；
  // `dsh-skill-filesystem` 才是从磁盘发现 SKILL.md 的那个 provider（inject: skills）。
  await mount(ctx, 'dsh-skill', SkillRegistry)
  await mount(ctx, 'dsh-skill-filesystem', SkillFilesystem, {
    // 只扫描项目自己的技能目录，不含 ~/.dsh 与 ~/.agents 的全局技能库（技能多、
    // 与项目无关，会把会话目录撑大）。要改用默认根：includeDefaultRoots 设 true。
    includeDefaultRoots: false,
    customSkillDirs: skillDirs(options.cwd),
    ...skillDirsFromEnv(),
    // 目录变化（新增/改名/删技能）要让下一次会话目录刷新，不用重启。
    watch: true,
  })

  // ── 2. 会话持久化（可关）───────────────────────────────────────────────
  if (options.persist) {
    await mount(ctx, 'dsh-session-persistence-jsonl', JsonlSessionPersistence, {
      root: join(options.stateDir, 'sessions'),
      // 明文 JSONL：便于用 `cat`/`jq` 直接读会话日志。
      compression: 'none',
    })
  }

  // ── 3. 执行能力：抽象 seam 各自挂一个「本地」provider ────────────────────
  await mount(ctx, 'dsh-subprocess-local', SubprocessLocal)
  await mount(ctx, 'dsh-shell-env', ShellEnv)
  await mount(ctx, 'dsh-bash-local', BashLocal, { cwd: options.cwd, timeoutMs: 120_000 })
  await mount(ctx, 'dsh-fs-local', FsLocal, { cwd: options.cwd })
  // 「先读后写」观察策略：未读过的文件直接写/改会被拦截。
  await mount(ctx, 'dsh-fs-observation-policy', FsObservationPolicy)
  await mount(ctx, 'dsh-jobs-local', JobsLocal)
  await mount(ctx, 'dsh-spill-local', SpillLocal, { root: join(options.stateDir, 'spill') })
  await mount(ctx, 'dsh-attachment-local', AttachmentLocal)

  // ── 4. 模型接入：官方 DeepSeek adapter ──────────────────────────────────
  await mount(ctx, 'dsh-deepseek-llm-api-extensions', DeepSeekApiExtensions)
  await mount(ctx, 'dsh-llm-deepseek', DeepSeekLlm, {
    // key 由 credentials.ts 安装到进程环境；adapter 每次请求时按变量名解析。
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    reasoningEffort: options.effort,
    defaultContextWindow: 1_000_000,
    streamIdleTimeoutMs: 172_800_000,
  })
  // 网络抖动时的请求级重试（策略由 provider 注册表决定）。
  await mount(ctx, 'dsh-llm-retry', LlmRetry)

  // ── 5. agent 循环本体 ──────────────────────────────────────────────────
  await mount(ctx, 'dsh-agent-loop', AgentLoop, { agents: [] })

  // ── 6. 模型可见的工具 ──────────────────────────────────────────────────
  await mount(ctx, 'dsh-tool-fs', ToolFs)
  await mount(ctx, 'dsh-tool-fs-search', ToolFsSearch, {
    // 该字段没有默认值，缺失会在挂载时校验失败。
    sampleOverCapGlobResults: false,
  })
  await mount(ctx, 'dsh-tool-bash', ToolBash, { enableRunInBackground: true })
  await mount(ctx, 'dsh-tool-jobs', ToolJobs)
  await mount(ctx, 'Memento-tools', customTools, { cwd: options.cwd })
  // System One：默认挂载决策模型
  await mount(ctx, 'Memento-system-one', SystemOne, {})
  // 模型侧的入口：在首个请求前投递一份「可用技能目录」，并注册 `skill` 工具按需加载正文。
  await mount(ctx, 'dsh-tool-skill', ToolSkill)

  // ── 6.5 外部 MCP 服务器（只有 `$Memento_MCP` 或配置显式 `enabled: true` 才挂）──
  await mountMcpServers(ctx, options)

  // ── 7. prompt 扩展 ─────────────────────────────────────────────────────
  installPromptSections(ctx)

  // ── 8. 自检：cordis 对未满足的 inject 只会静默 PENDING，这里显式兜底 ──────
  const missing = REQUIRED_SERVICES.filter(name => ctx.get(name as never) === undefined)
  if (missing.length > 0) {
    await ctx.fiber.dispose()
    throw new Error(`内核装配不完整，缺失服务: ${missing.join(', ')}`)
  }

  // ── 9. 创建或恢复 agent ────────────────────────────────────────────────
  const agentOptions = {
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
  }
  let agent: Agent
  let sessionId: string
  if (options.resume !== undefined) {
    // 恢复需要 sessionPersistence；未开启持久化时给出明确提示。
    if (!options.persist) {
      await ctx.fiber.dispose()
      throw new Error('--resume 需要持久化：请去掉 --no-persist')
    }
    const handle = await ctx.agents.resume({
      resumeSessionId: SessionId(options.resume),
      agentOptions,
    })
    agent = handle.agent
    sessionId = options.resume
  } else {
    sessionId = options.sessionId ?? newSessionId()
    agent = await ctx.agentLoop.create(SessionId(sessionId), agentOptions, { cwd: options.cwd })
  }

  return {
    ctx,
    agent,
    sessionId,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/** 列出当前内核已注册的工具（名字 + 描述首行），用于 `--list-tools`。 */
export function listTools(ctx: Context): { name: string; description: string }[] {
  return ctx.tools.schemas()
    .map(schema => ({ name: schema.name, description: schema.description.split('\n')[0] ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
