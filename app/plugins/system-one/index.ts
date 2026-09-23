/**
 * System One 插件：把 TypeSafe/Jev 的决策原语接进 Memento，注册 `sysone_ask` 与
 * `sysone_compose` 两个工具。
 *
 * 分工是「模型生成文本、代码负责决策」：拆解、加权、归一化与阈值判定都在
 * `primitives.ts` 的确定性纯函数里，不花 token。后端只有 TypeSafe 官方 Jev，
 * 缺 `TYPESAFE_API_KEY` 或鉴权失败时直接报错，不退回概率未标定的本地采样。
 *
 * @module Memento/plugins/system-one
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { askTypeSafe, TypeSafeError, type TypeSafeResult } from './typesafe.ts'
import {
  composeWeighted, normalizeScore, parseQuestions, QuestionError, routeByConfidence,
  type Answer, type ChoiceAnswer, type ComposeItem, type Question,
} from './primitives.ts'

/**
 * 本文件内部用的 JSON 值类型：内核的 `JsonValue` 来自 `@deepseek-ai/dsh-util-values`，
 * 而它不是本仓库的顶层依赖（pnpm 严格布局下 import 不到），故按同一形状自己标一个。
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** 插件名。 */
export const name = 'Memento-system-one'
/** 需要工具注册表；官方后端直接走 HTTP，不需要 LLM 运行时。 */
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** TypeSafe 网关；不填读 `TYPESAFE_BASE_URL`，默认官方地址。 */
  readonly baseUrl?: string
  /** TypeSafe 模型名；不填读 `TYPESAFE_MODEL`，默认 `jev-latest`。 */
  readonly typesafeModel?: string
  /** 读 API key 的环境变量名，默认 `TYPESAFE_API_KEY`。 */
  readonly apiKeyEnv?: string
}

/** 配置 schema：三个字段都可选（都能由环境变量兜底）。 */
export const Config: z<Config> = z.object({
  baseUrl: z.string(),
  typesafeModel: z.string(),
  apiKeyEnv: z.string(),
})

/** 默认值集中在这里，方便 README 与测试引用。 */
const DEFAULTS = {
  baseUrl: 'https://api.typesafe.ai',
  typesafeModel: 'jev-latest',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  /** 路由默认阈值：低于 0.4 升级、0.4~0.7 复核、≥0.7 直接执行；0.25 以上概率的其它分支抄送。 */
  minConfidence: 0.4,
  actAt: 0.7,
  notifyAt: 0.25,
} as const

/** 把一个答案渲染成一行给人/模型看的文本。 */
function renderAnswer(answer: Answer): string {
  const head = answer.type === 'choice'
    ? `${answer.id}: choice=${answer.choice}`
    : answer.type === 'score'
      ? `${answer.id}: score=${String(answer.score)}/${String(answer.scaleMax)}`
      : `${answer.id}: noul=${String(answer.noul)}`
  const probabilities = Object.entries(answer.probabilities)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ')
  return `  ${head}  confidence=${answer.confidence.toFixed(2)} probabilities={${probabilities}} calibrated`
}

/**
 * 领域答案 → 纯 JSON：工具返回值需要可无损序列化，而 `legend` 是 `readonly`
 * （`JsonValue` 只认可变数组），所以在出口处展开，领域类型保持 `readonly`。
 */
function toJsonAnswer(answer: Answer): { [key: string]: Json } {
  const base: { [key: string]: Json } = {
    id: answer.id,
    type: answer.type,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
    calibrated: true,
  }
  if (answer.type === 'choice') base['choice'] = answer.choice
  if (answer.type === 'score') {
    base['score'] = answer.score
    base['scale_max'] = answer.scaleMax
    base['legend'] = [...answer.legend]
  }
  if (answer.type === 'noul') base['noul'] = answer.noul
  return base
}

/** 把问题列表渲染成一行摘要（回显给模型，便于核对它问的是什么）。 */
function renderQuestions(questions: readonly Question[]): string {
  return questions
    .map(question => question.type === 'choice'
      ? `${question.id}(choice×${String(Object.keys(question.criteria).length)})`
      : question.type === 'score'
        ? `${question.id}(score×${String(question.criteria.length)})`
        : `${question.id}(noul)`)
    .join(' ')
}

/** 插件入口：注册两个工具。 */
export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULTS.apiKeyEnv
  const typesafe = {
    baseUrl: config.baseUrl ?? process.env['TYPESAFE_BASE_URL'] ?? DEFAULTS.baseUrl,
    model: config.typesafeModel ?? process.env['TYPESAFE_MODEL'] ?? DEFAULTS.typesafeModel,
  }
  const apiKey = (): string => (process.env[apiKeyEnv] ?? '').trim()

  ctx.tools.register(defineTool({
    name: 'sysone_ask',
    description: [
      'Ask a batch of narrow, independent judgment questions about one piece of state, and get structured answers with calibrated probabilities and confidence from the official TypeSafe/Jev API.',
      'Use it when code you are about to write needs a semantic judgment: routing text to one of several handlers, scoring a document on a rubric, or checking several yes/no conditions.',
      'Ask every question you might need in ONE call: they are evaluated in parallel and cannot see each other\'s answers.',
      'Keep each question atomic (one dimension). For a multi-factor decision, ask one question per factor and combine the answers with sysone_compose instead of asking one big question.',
      'Answer types: choice (pick one of a fixed set), score (a position on an ordered rubric, 2-10 levels), noul (is this statement true, returns a probability).',
      `Backend: official TypeSafe/Jev only, one HTTP request. Requires the ${apiKeyEnv} environment variable; if it is missing or rejected, this tool fails with the reason. There is no local fallback — only calibrated probabilities are accepted.`,
    ].join(' '),
    parameters: {
      state: {
        type: 'string',
        required: true,
        description: 'The content to judge. Pass text, or a JSON object/array as a string when the context has named parts (e.g. {"ticket":"...","policy":"..."}).',
      },
      questions: {
        type: 'array',
        required: true,
        description: 'The questions to ask. Each: {id, type, instructions, criteria}. choice needs criteria as {"option":"description"}; score needs criteria as an ordered array of 2-10 level descriptions (low to high); noul needs no criteria.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Short id used to read the answer back. Sent to TypeSafe as the question key.' },
            type: { type: 'string', required: true, enum: ['choice', 'score', 'noul'] },
            instructions: { type: 'string', required: true, description: 'The one thing to judge, phrased as a question.' },
            criteria: { type: 'json', description: 'choice: {"option":"what it covers"}; score: ["level 0 description","level 1 description",...]' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backend: { type: 'string', required: true },
          model: { type: 'string', required: true },
          calibrated: { type: 'boolean', required: true },
          elapsed_ms: { type: 'integer', required: true },
          calls: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          /** 结构化答案（与 text 内容一致），给需要按字段消费的调用方。 */
          answers: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const questions = parseQuestions(args.questions)
      const key = apiKey()
      if (key === '') {
        throw new Error(
          `sysone_ask 只支持 TypeSafe 官方 Jev 后端，但环境变量 ${apiKeyEnv} 是空的。`
          + `请设置 ${apiKeyEnv}（或用插件配置 apiKeyEnv 换一个变量名）后重试；本插件没有本地兜底。`,
        )
      }
      let result: TypeSafeResult
      try {
        result = await askTypeSafe(
          questions,
          args.state,
          { apiKey: key, baseUrl: typesafe.baseUrl, model: typesafe.model },
          exec.signal,
        )
      } catch (error) {
        if (error instanceof TypeSafeError) {
          const advice = error.kind === 'auth'
            ? `检查 ${apiKeyEnv} 是否有效`
            : error.kind === 'rate-limit'
              ? '稍后重试或降低调用频率'
              : '确认网络与 TYPESAFE_BASE_URL 配置'
          throw new Error(`TypeSafe/Jev 调用失败（${error.kind}）：${error.message}。${advice}。本插件没有本地兜底。`)
        }
        throw error
      }
      const text = [
        `sysone · backend=typesafe(${result.model}) · ${String(questions.length)} 个问题并行 · ${String(result.elapsedMs)}ms`
        + (Object.keys(result.usage).length === 0 ? '' : ` · tokens ${JSON.stringify(result.usage)}`),
        `问题：${renderQuestions(questions)}`,
        ...result.answers.map(renderAnswer),
        '概率由 TypeSafe 标定过（calibrated）。需要按阈值决定动作时，把 answers 交给 sysone_compose。',
      ].join('\n')
      return {
        backend: 'typesafe',
        model: result.model,
        calibrated: true,
        elapsed_ms: result.elapsedMs,
        calls: 1,
        text,
        answers: result.answers.map(toJsonAnswer),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sysone_compose',
    description: [
      'Combine System One answers with deterministic code: weighted composite scoring, or confidence-gated routing.',
      'Use it right after sysone_ask so the decision rule is explicit and reproducible instead of being re-derived by the model.',
      'mode=composite: weights and normalization across several score/noul answers produce one 0-1 number plus per-item contributions; thresholds say act/review/hold.',
      'mode=route: one choice answer plus a confidence threshold produces act (confident), review (usable but let a human glance), or escalate (too flat to choose), and lists other options whose probability is high enough to notify.',
      'No model call happens here: this is pure arithmetic on the answers you pass in.',
    ].join(' '),
    parameters: {
      mode: { type: 'string', required: true, enum: ['composite', 'route'], description: 'composite = weighted score; route = confidence gate.' },
      answers: {
        type: 'array',
        required: true,
        description: 'The answers from sysone_ask. composite needs score/noul items with weight; route needs exactly one choice item.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true },
            type: { type: 'string', required: true, enum: ['choice', 'score', 'noul'] },
            weight: { type: 'number', description: 'composite: relative weight (any positive number; normalized internally).' },
            score: { type: 'number', description: 'score answers: the value returned by sysone_ask.' },
            scale_max: { type: 'number', description: 'score answers: the scaleMax returned by sysone_ask (used to normalize to 0-1).' },
            noul: { type: 'number', description: 'noul answers: the probability returned by sysone_ask.' },
            choice: { type: 'string', description: 'choice answers: the selected option.' },
            confidence: { type: 'number', description: 'Confidence returned by sysone_ask; below min_confidence the item is flagged.' },
            probabilities: { type: 'json', description: 'choice answers: the probability map (used for alsoNotify).' },
          },
        },
      },
      min_confidence: { type: 'number', description: `Below this the item is flagged (composite) or the decision escalates (route). Default ${String(DEFAULTS.minConfidence)}.` },
      act_at: { type: 'number', description: `composite: score at or above this means act. route: confidence at or above this means act. Default ${String(DEFAULTS.actAt)}.` },
      review_at: { type: 'number', description: `composite: score at or above this (but below act_at) means review. Default ${String(DEFAULTS.actAt - 0.2)}.` },
      notify_at: { type: 'number', description: `route: also list options whose probability reaches this. Default ${String(DEFAULTS.notifyAt)}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          decision: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const minConfidence = args.min_confidence ?? DEFAULTS.minConfidence
      const actAt = args.act_at ?? DEFAULTS.actAt
      const reviewAt = args.review_at ?? Math.max(minConfidence, DEFAULTS.actAt - 0.2)

      if (args.mode === 'route') {
        const choices = args.answers.filter(item => item.type === 'choice')
        if (choices.length !== 1) {
          throw new Error(`sysone_compose(mode=route) 需要**恰好一个** choice 答案，收到 ${String(choices.length)} 个`)
        }
        const raw = choices[0] as Record<string, unknown>
        const id = String(raw['id'])
        const choice = typeof raw['choice'] === 'string' ? raw['choice'] : ''
        const confidence = typeof raw['confidence'] === 'number' ? raw['confidence'] : 0
        const probabilitiesRaw = raw['probabilities']
        const probabilities: Record<string, number> = {}
        if (typeof probabilitiesRaw === 'object' && probabilitiesRaw !== null) {
          for (const [key, value] of Object.entries(probabilitiesRaw as Record<string, unknown>)) {
            if (typeof value === 'number') probabilities[key] = value
          }
        }
        const answer: ChoiceAnswer = {
          id,
          type: 'choice',
          choice,
          confidence,
          probabilities,
        }
        const routed = routeByConfidence(answer, { minConfidence, actAt, notifyAt: args.notify_at ?? DEFAULTS.notifyAt })
        const text = [
          `sysone_compose · mode=route · ${id} → ${routed.decision}`,
          `  依据：${routed.reason}`,
          `  分支：${routed.branch ?? '（不锁定，交人决定）'}`
          + (routed.alsoNotify.length === 0 ? '' : `｜同时值得通知：${routed.alsoNotify.join(', ')}`),
          '  阈值是本地的约定（min_confidence / act_at / notify_at），改阈值不用重跑推理。',
        ].join('\n')
        return { mode: 'route', decision: routed.decision, reason: routed.reason, text }
      }

      const items: ComposeItem[] = args.answers.map((item) => {
        const raw = item as Record<string, unknown>
        const id = String(raw['id'])
        const type = String(raw['type'])
        const confidence = typeof raw['confidence'] === 'number' ? raw['confidence'] : 1
        if (type === 'score') {
          const score = typeof raw['score'] === 'number' ? raw['score'] : 0
          const scaleMax = typeof raw['scale_max'] === 'number' ? raw['scale_max'] : 1
          return { id, weight: typeof raw['weight'] === 'number' ? raw['weight'] : 1, value: normalizeScore(score, scaleMax), raw: `${score}/${scaleMax}`, confidence }
        }
        if (type === 'noul') {
          const noul = typeof raw['noul'] === 'number' ? raw['noul'] : 0
          return { id, weight: typeof raw['weight'] === 'number' ? raw['weight'] : 1, value: noul, raw: String(noul), confidence }
        }
        throw new Error(
          `sysone_compose(mode=composite) 只接受 score / noul 答案，收到 ${type}（${id}）。`
          + 'choice 是无序选项，先决定它属于哪条路径（mode=route），再对路径内的有序维度做加权。',
        )
      })
      const composed = composeWeighted(items, minConfidence)
      const decision = composed.composite >= actAt ? 'act' : composed.composite >= reviewAt ? 'review' : 'hold'
      const text = [
        `sysone_compose · mode=composite · composite=${composed.composite.toFixed(3)} → ${decision}`,
        ...composed.contributions.map(item => `  ${item.id}: value=${item.value.toFixed(3)} × weight=${item.weight.toFixed(3)} = ${item.points.toFixed(3)}`),
        `  阈值：act ≥ ${actAt.toFixed(2)}｜review ≥ ${reviewAt.toFixed(2)}｜低于前者一律 hold`,
        composed.lowConfidence.length === 0
          ? '  所有维度的置信度都在门槛之上。'
          : `  ⚠ 这些维度的置信度低于 ${minConfidence.toFixed(2)}，分数不该被当真：${composed.lowConfidence.join(', ')}`,
        '  权重与阈值都在代码里（本插件的参数/常量），改了不用重跑推理。',
      ].join('\n')
      return {
        mode: 'composite',
        decision,
        reason: `composite ${composed.composite.toFixed(3)}（${String(items.length)} 个维度加权）`,
        text,
      }
    },
  }))


  console.error(
    `[system-one] 已挂载 · 工具 sysone_ask / sysone_compose · `
    + (apiKey() === ''
      ? `⚠ ${apiKeyEnv} 为空：sysone_ask 会直接报错（只走官方 Jev，无本地兜底）`
      : `官方 Jev 已配置（${typesafe.model}）`),
  )
}

/** 给真值表用的导出（`primitives.ts` 的纯函数在这里再导一次，便于 node 直接跑）。 */
export { QuestionError }
