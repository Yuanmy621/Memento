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

import { join, resolve } from 'node:path'
import { installApiKey, fingerprint } from '../../cli/credentials.ts'
import { parseOptions, SUPPORTED_MODELS, UsageError, type Options } from '../../cli/options.ts'
import { readSessionHistory } from './history.ts'
import { listProjectSessions, listWorkspaceSessions } from './sessions.ts'
import { PROTOCOL_VERSION, type HostEvent, type HostReadyInfo, type HostRequest, type ModelInfo } from './protocol.ts'
// 类型专用导入：只在编译期存在，不会在内核就位前求值任何 DSH 运行时模块。
import type { DesktopBridge } from './bridge.ts'
import type { Kernel } from '../../cli/kernel.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

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
  const [{ bootKernel, listTools }, { DesktopBridge }, { createUserMessage }] = await Promise.all([
    import('../../cli/kernel.ts'),
    import('./bridge.ts'),
    import('@deepseek-ai/dsh-llm'),
  ])

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

  /**
   * 跑完一个回合。
   * `whenIdle()` 不会因为模型 / 工具失败而 reject（内核在驱动边界吞掉了异常），
   * 所以真实结果要从事件里读 —— 也就是 bridge 记录的 outcome。
   */
  async function runTurn(turnId: string, text: string): Promise<void> {
    const startedAt = Date.now()
    bridge.startTurn(turnId)
    kernel.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
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
