/**
 * 剪映草稿工作流插件：把「盘点 → 设计 → 构建 → 校验 → 导出」五个阶段固化进内核。
 *
 * 两个接缝，共用 `stages.ts` 那张表：
 *   - **工具 `draft_stage`**：读/推进/回退阶段。推进时要先看到上一阶段该产出的凭据
 *     （`<stateDir>/draft/` 下的 JSON），没有就不许过 —— 阶段是产物换来的，不是声明的。
 *   - **hook `tools/pre-execute`**：按当前阶段拦住不该跑的技能脚本。判据只看脚本名，
 *     不做命令字符串的模糊匹配。
 *   - **hook `tools/post-execute`**：把技能脚本的实际执行结果记进历史，
 *     状态文件里因此有真实轨迹，而不只是阶段名。
 *
 * 只在**技能存在**时才挂载工具与 hook（见 {@link SKILL_NAME}）：没装这个技能的
 * 项目不会多出一个工具，hook 也不会被注册。
 *
 * @module Memento/plugins/draft-workflow
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  nextStage, prevStage, renderChain, scriptRequirement, stageIndex, stageSpec,
  STAGES, type Stage,
} from './stages.ts'

/** 插件名。 */
export const name = 'Memento-draft-workflow'
/** 需要工具注册表。 */
export const inject = ['tools']

/** 本插件服务的技能目录名。 */
const SKILL_NAME = 'jianying-draft'

/** 产物与状态文件所在的子目录（相对 `<stateDir>`）。 */
const WORK_DIR = 'draft'

/** 状态文件名（相对 `<stateDir>`）。 */
const STATE_FILE = 'draft-workflow.json'

/** 插件配置。 */
export interface Config {
  /** agent 的工作目录，用来定位技能。 */
  readonly cwd: string
  /** 会话与运行数据目录（`--state-dir`，默认 `<cwd>/.Memento`）。 */
  readonly stateDir: string
  /** 要扫描的技能根目录，由内核传入（`skillRoots(cwd)`）。 */
  readonly skillRoots: string[]
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  cwd: z.string().required(),
  stateDir: z.string().required(),
  skillRoots: z.array(z.string()).required(),
})

/** 一条历史记录。 */
interface HistoryEntry {
  /** ISO 时间戳。 */
  readonly at: string
  /** 记录时的阶段。 */
  readonly stage: string
  /** 事件类型：`advance` / `back` / `reset` / `run`。 */
  readonly event: string
  /** 人可读的说明。 */
  readonly note: string
}

/** 工作流状态。 */
interface WorkflowState {
  /** 当前阶段；空串表示还没开始。 */
  readonly stage: Stage | ''
  /** 目标草稿名。 */
  readonly draft: string
  /** 剪映草稿目录（绝对路径）。 */
  readonly draftStore: string
  /** 最后更新时间。 */
  readonly updatedAt: string
  /** 轨迹，按时间正序。 */
  readonly history: readonly HistoryEntry[]
}

/** 工具执行上下文里本插件用得到的字段。`arguments` 对无参工具是缺省的。 */
interface ToolExecution {
  readonly name: string
  readonly arguments?: Record<string, unknown> | undefined
}

/**
 * 取工具调用的命令文本。
 *
 * `arguments` 可能整个缺省（无参工具），字段名也不是 `args`，所以两步都要判。
 * @param exec - 工具执行上下文。
 * @returns 命令文本；不是 bash 类调用时是空串。
 */
function commandOf(exec: ToolExecution): string {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return ''
  const command = args['command']
  return typeof command === 'string' ? command : ''
}

/** 空状态。 */
function emptyState(): WorkflowState {
  return { stage: '', draft: '', draftStore: '', updatedAt: new Date().toISOString(), history: [] }
}

/** 读状态；文件不存在或读坏了都返回空状态。 */
async function readState(stateDir: string): Promise<WorkflowState> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(stateDir, STATE_FILE), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return emptyState()
    const value = raw as Partial<WorkflowState>
    return {
      stage: typeof value.stage === 'string' ? (value.stage as Stage | '') : '',
      draft: typeof value.draft === 'string' ? value.draft : '',
      draftStore: typeof value.draftStore === 'string' ? value.draftStore : '',
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      history: Array.isArray(value.history) ? value.history as HistoryEntry[] : [],
    }
  } catch {
    return emptyState()
  }
}

/** 写状态（追加一条历史）。 */
async function writeState(
  stateDir: string,
  state: WorkflowState,
  event: string,
  note: string,
): Promise<WorkflowState> {
  const next: WorkflowState = {
    ...state,
    updatedAt: new Date().toISOString(),
    history: [...state.history, { at: new Date().toISOString(), stage: state.stage, event, note }].slice(-50),
  }
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, STATE_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** 读一个 JSON 产物；不存在或不是对象时返回 `undefined`。 */
async function readArtifact(stateDir: string, file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(stateDir, WORK_DIR, file), 'utf8'))
    return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * 检查「离开当前阶段」的凭据是否齐备。
 *
 * 每个阶段要看的产物在 `stages.ts` 的 `gate` 里，这里只做判定，不写文件。
 * @param stateDir - 数据目录。
 * @param state - 当前状态。
 * @returns 不满足时的原因；满足时返回 `undefined`。
 */
async function gateReason(stateDir: string, state: WorkflowState): Promise<string | undefined> {
  if (state.stage === '') return undefined
  const spec = stageSpec(state.stage)
  if (spec === undefined || spec.gate === '') return undefined

  if (spec.gate === 'draft') {
    if (state.draft === '') return `还没登记草稿名（先设置 draft 参数）`
    if (state.draftStore !== '' && !existsSync(join(state.draftStore, state.draft))) {
      return `草稿目录里没有「${state.draft}」：${join(state.draftStore, state.draft)}`
    }
    return undefined
  }

  const artifact = await readArtifact(stateDir, spec.gate)
  if (artifact === undefined) return `缺少 ${spec.gate}（${spec.gateHint}）`
  if (spec.id === 'survey' && !(Array.isArray(artifact['assets']) && artifact['assets'].length > 0)) {
    return `survey.json 的 assets 为空`
  }
  if (spec.id === 'plan' && artifact['approved'] !== true) {
    return `plan.json 的 approved 不是 true —— 分镜需要人确认后才算数`
  }
  if (spec.id === 'review' && artifact['passed'] !== true) {
    return `review.json 的 passed 不是 true`
  }
  return undefined
}

/** 从 bash 命令里认出本技能的脚本名。 */
function skillScriptIn(command: string): string | undefined {
  for (const token of command.split(/[\s'"();|&]+/)) {
    const base = token.split('/').pop() ?? ''
    if (scriptRequirement(base) !== undefined) return base
  }
  return undefined
}

/**
 * 挂载剪映草稿工作流。
 *
 * 技能不在当前项目的技能目录里时直接返回：工具与 hook 都不注册。
 */
export function apply(ctx: Context, config: Config): void {
  const stateDir = config.stateDir
  const enabled = config.skillRoots.some(root => existsSync(join(root, SKILL_NAME)))
  if (!enabled) return

  ctx.tools.register(defineTool({
    name: 'draft_stage',
    description: [
      'Read or move the JianYing draft workflow stage (survey → plan → build → review → export).',
      'Call it with action="status" before starting draft work to see the current stage and what the next one needs,',
      'and with action="advance" only after the current stage\'s artifact exists — advancing without it is refused.',
      'Pass draft and draftStore to register which draft this workflow is building.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'advance', 'back', 'reset'], description: 'status: read; advance/back: move one stage; reset: clear the workflow.' },
      note: { type: 'string', description: 'Why you are moving; recorded in the history.' },
      draft: { type: 'string', description: 'Draft folder name to build (recorded on the workflow).' },
      draftStore: { type: 'string', description: 'Absolute path of the JianYing drafts folder.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stage: { type: 'string', required: true },
          chain: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 只读写一个小状态文件，可以与其他只读调用并行。
    isConcurrencySafe: () => true,
    async execute(args) {
      const requested = typeof args.action === 'string' ? args.action : 'status'
      let state = await readState(stateDir)

      if (typeof args.draft === 'string' && args.draft !== '') state = { ...state, draft: args.draft }
      if (typeof args.draftStore === 'string' && args.draftStore !== '') state = { ...state, draftStore: args.draftStore }

      if (requested === 'reset') {
        await rm(join(stateDir, STATE_FILE), { force: true })
        return { stage: '', chain: renderChain('survey'), text: '工作流已重置。下一步：action="advance" 从素材盘点开始。' }
      }

      if (requested === 'back') {
        const target = state.stage === '' ? undefined : prevStage(state.stage)
        if (target === undefined) throw new Error('已经在第一个阶段，退不回去了')
        state = await writeState(stateDir, { ...state, stage: target }, 'back', typeof args.note === 'string' ? args.note : '')
        return render(stateDir, state, `已回退到「${stageSpec(target)?.label ?? target}」。`)
      }

      if (requested === 'advance') {
        if (state.stage === '') {
          state = await writeState(stateDir, { ...state, stage: STAGES[0] }, 'advance', typeof args.note === 'string' ? args.note : '')
          return render(stateDir, state, '工作流已开始。')
        }
        const target = nextStage(state.stage)
        if (target === undefined) throw new Error('已经在最后一个阶段（导出交付）')
        const blocked = await gateReason(stateDir, state)
        if (blocked !== undefined) {
          throw new Error(`不能从「${stageSpec(state.stage)?.label ?? state.stage}」推进：${blocked}`)
        }
        state = await writeState(stateDir, { ...state, stage: target }, 'advance', typeof args.note === 'string' ? args.note : '')
        return render(stateDir, state, `已推进到「${stageSpec(target)?.label ?? target}」。`)
      }

      return render(stateDir, state, '')
    },
  }))

  /**
   * 闸门：按当前阶段拦住不该跑的技能脚本。
   *
   * hook 里**绝不能抛异常** —— 抛出去会让这次工具调用失败，而且异常发生在
   * 工具管线里，会把后续每一次调用一起带崩。所以整体包一层 try/catch：
   * 自己出问题时放行并打日志，而不是让用户什么都干不了。
   */
  ctx.on('tools/pre-execute', (async (exec: ToolExecution, next: () => Promise<unknown>) => {
    try {
      const state = await readState(stateDir)
      if (state.stage === '') return await next()
      if (exec.name !== 'bash' && exec.name !== 'job_output') return await next()
      const script = skillScriptIn(commandOf(exec))
      if (script === undefined) return await next()
      const required = scriptRequirement(script)
      if (required === undefined) return await next()
      if (stageIndex(state.stage) >= stageIndex(required)) return await next()
      return {
        kind: 'deny',
        reason: `现在在「${stageSpec(state.stage)?.label ?? state.stage}」阶段，${script} 要求先到「${stageSpec(required)?.label ?? required}」阶段。`
          + `当前：${renderChain(state.stage)}。`,
      }
    } catch (error) {
      console.error(`[draft-workflow] pre-execute 出错，已放行：${String(error)}`)
      return await next()
    }
  }) as never)

  /** 记录：技能脚本的实际执行结果进历史，状态文件因此有真实轨迹而不只是阶段名。 */
  ctx.on('tools/post-execute', (async (exec: ToolExecution, result: unknown, next: () => Promise<unknown>) => {
    const decision = await next()
    try {
      if (exec.name !== 'bash' && exec.name !== 'job_output') return decision
      const state = await readState(stateDir)
      if (state.stage === '') return decision
      const script = skillScriptIn(commandOf(exec))
      if (script === undefined) return decision
      const failed = typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true
      await writeState(stateDir, state, 'run', `${script} ${failed ? '失败' : '完成'}`)
    } catch (error) {
      console.error(`[draft-workflow] post-execute 出错：${String(error)}`)
    }
    return decision
  }) as never)

  console.error(`[draft-workflow] 已挂载 · 工具 draft_stage · 工作流状态在 ${join(stateDir, STATE_FILE)}`)
}

/** 把状态渲染成给模型看的文本。 */
function render(stateDir: string, state: WorkflowState, headline: string): { stage: string; chain: string; text: string } {
  const spec = stageSpec(state.stage)
  const upcoming = state.stage === '' ? STAGES[0] : nextStage(state.stage)
  const lines = [
    headline,
    `当前阶段：${spec === undefined ? '（未开始）' : spec.label}`,
    `阶段链：${renderChain(state.stage === '' ? 'survey' : state.stage)}`,
    state.draft === '' ? '' : `草稿：${state.draft}`,
    upcoming === undefined
      ? '已是最后一个阶段。'
      : `下一步「${stageSpec(upcoming)?.label ?? upcoming}」需要：${spec === undefined ? '（直接推进即可）' : spec.gateHint}`,
    `工作目录：${join(stateDir, WORK_DIR)}`,
  ]
  return { stage: state.stage, chain: renderChain(state.stage === '' ? 'survey' : state.stage), text: lines.filter(l => l !== '').join('\n') }
}
