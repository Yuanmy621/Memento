/**
 * YuanMy 内核：用 cordis 手工装配 DeepSeek Harness 的 agent 内核。
 *
 * 这里**不**使用 DSH 的 `cordis.yml` 加载器，而是显式 `await ctx.plugin(...)`
 * 每一个插件 —— 装配顺序、依赖关系、配置全部在这一个文件里可见。
 *
 * 关键事实（来自 DSH 源码）：
 *   - 根上下文就是 `new Context()`；没有 `App`、没有 `ctx.start()`。
 *   - `await ctx.plugin(X)` 在 X 的 `inject` 依赖尚未就绪时**不会报错**，而是
 *     停在 PENDING；所以必须按依赖顺序逐个 await（本文件即按此顺序书写）。
 *   - `AgentLoop.inject = ['agents','sessions','llm','tools','systemPrompt','sessionProjections']`。
 *   - 真正的抽象 seam 只有一个：LLM adapter（这里用官方 `dsh-llm-deepseek`）。
 *
 * @module YuanMy/kernel
 */

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

// —— YuanMy 自己的扩展 ——
import * as customTools from './tools.ts'
import { installPromptSections, personaText } from './prompt.ts'
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
 * 项目的技能目录。
 *
 * 约定与 DSH 一致：`<项目根>/.agents/skills/<名字>/SKILL.md`。
 * 这里**不**让 provider 自己去猜项目根（它取最近的 `.git` 祖先），
 * 而是显式给 `cwd` 下的目录，保证「agent 的工作目录 = 技能目录」，
 * 换 `--cwd` 就换技能集。
 * @param cwd - agent 的工作目录。
 * @returns 要扫描的技能根目录列表。
 */
function skillDirs(cwd: string): string[] {
  // `.dsh/skills` 是 DSH 里优先级更高的项目级目录（rank 100），一并认。
  return [join(cwd, '.agents', 'skills'), join(cwd, '.dsh', 'skills')]
}

/**
 * 允许用环境变量追加技能目录（冒号分隔），方便放个人/团队共享技能。
 * @returns 匹配 `dsh-skill-filesystem` Config 的片段。
 */
function skillDirsFromEnv(): { customSkillDirs?: string[] } {
  const extra = process.env.YuanMy_SKILL_DIRS?.trim()
  if (extra === undefined || extra === '') return {}
  const dirs = extra.split(':').map(part => part.trim()).filter(part => part !== '')
  return dirs.length === 0 ? {} : { customSkillDirs: dirs }
}

/** 生成一个新的会话 id。 */
function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  return `YuanMy-${stamp}-${rand}`
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
 * 启动内核：装配插件树 → 创建（或恢复）agent。
 * @param options - CLI 配置。
 * @returns 可用于驱动对话的内核句柄。
 */
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
  // ToolRuntime.inject = ['systemPrompt']：工具 schema 由 system prompt 组装时汇总，
  // 因此注册表必须晚于 systemPrompt 挂载。
  await mount(ctx, 'dsh-tools', ToolRuntime)
  await mount(ctx, 'dsh-agent', AgentRegistry)

  // ── 1.5 技能注册表与本地 provider ──────────────────────────────────────
  // `dsh-skill` 只提供注册表（`ctx.skills`），本身不含任何技能内容；
  // `dsh-skill-filesystem` 才是从磁盘发现 SKILL.md 的那个 provider（inject: skills）。
  await mount(ctx, 'dsh-skill', SkillRegistry)
  await mount(ctx, 'dsh-skill-filesystem', SkillFilesystem, {
    // 只认项目自己的技能目录，不扫描 ~/.dsh 与 ~/.agents —— 那是 DSH CLI 的全局技能库
    // （50+ 个飞书/记忆类技能），对编码 agent 是噪声，还会把会话目录撑得很大。
    // 想恢复 DSH 的默认行为：把 includeDefaultRoots 设成 true、去掉 customSkillDirs。
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
  // 「先读后写」观察策略：未读过就写/改会被拦截，让 agent 的行为更可预测。
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
  await mount(ctx, 'YuanMy-tools', customTools, { cwd: options.cwd })
  // 模型侧的入口：在首个请求前投递一份「可用技能目录」，并注册 `skill` 工具按需加载正文。
  await mount(ctx, 'dsh-tool-skill', ToolSkill)

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
