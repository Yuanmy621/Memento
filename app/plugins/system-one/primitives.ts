/**
 * System One 的**纯逻辑层**：问题类型、校验、按代码组合。
 *
 * 这一层刻意不碰网络、不碰 LLM、不碰 cordis —— 全部是纯函数，所以能在 Node 里直接
 * 跑真值表（`node --experimental-strip-types` 即可），也方便以后换后端。
 *
 * ## 三个 primitives（对齐 TypeSafe/Jev 的定义）
 *
 * | 类型 | 问什么 | 答什么 |
 * | --- | --- | --- |
 * | `choice` | 从一组固定选项里选一个 | `choice` + `probabilities` + `confidence` |
 * | `score` | 落在一条有序标尺的哪一格 | `score`（可为小数）+ `probabilities` + `confidence` |
 * | `noul` | 这个陈述成立吗 | `noul`（0~1 的概率） |
 *
 * ## 置信度（confidence）说的到底是什么
 *
 * 上游的 confidence 是「概率分布有多集中」：全压在一个选项上就是 1.0，摊平就低。
 * 它是**关于这次回答**的指标，**不是**「这个回答正确」的保证，也**不是**行动的许可 ——
 * 许可要由调用方的阈值决定（见 {@link routeByConfidence}）。
 * 本插件只接官方 Jev，概率是标定过的；但 confidence 仍只是**这次回答**的分布集中度，
 * 不代表答案正确，也不是行动的许可。
 *
 * @module Memento/plugins/system-one/primitives
 */

/** 三种问题类型。 */
export type QuestionType = 'choice' | 'score' | 'noul'

/** Choice：从固定选项里选一个。 */
export interface ChoiceQuestion {
  readonly id: string
  readonly type: 'choice'
  readonly instructions: string
  /** 选项名 → 描述（描述可为空串；选项名与描述都会发给模型）。 */
  readonly criteria: Readonly<Record<string, string>>
}

/** Score：落在一条有序标尺的哪一格（0 起编号）。 */
export interface ScoreQuestion {
  readonly id: string
  readonly type: 'score'
  readonly instructions: string
  /** 有序的档位描述，从低到高；至少 2 档、至多 10 档。 */
  readonly criteria: readonly string[]
}

/** Noul：这个陈述成立吗。 */
export interface NoulQuestion {
  readonly id: string
  readonly type: 'noul'
  readonly instructions: string
}

/** 一个问题。 */
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion

/** 所有答案共有的字段。 */
export interface AnswerBase {
  readonly id: string
  readonly type: QuestionType
  /** 分布有多集中（0~1）。见模块注释：它不代表答案正确。 */
  readonly confidence: number
  /** 概率分布；score 的键是档位号（字符串）。 */
  readonly probabilities: Readonly<Record<string, number>>
}

/** Choice 的答案。 */
export interface ChoiceAnswer extends AnswerBase {
  readonly type: 'choice'
  readonly choice: string
}

/** Score 的答案。 */
export interface ScoreAnswer extends AnswerBase {
  readonly type: 'score'
  readonly score: number
  /** 标尺上限（= criteria.length - 1），归一化时用它。 */
  readonly scaleMax: number
  /** 档位号 → 描述。 */
  readonly legend: readonly string[]
}

/** Noul 的答案。 */
export interface NoulAnswer extends AnswerBase {
  readonly type: 'noul'
  /** 「成立」的概率，0~1。 */
  readonly noul: number
}

/** 一个答案。 */
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer

// ─────────────────────────────────────────────────────────────────────────────
// 校验：模型给的问题结构不可信
// ─────────────────────────────────────────────────────────────────────────────

/** 一个工具最多接受多少个问题（一次请求是并行的，但 token 与延迟仍要有人管）。 */
export const MAX_QUESTIONS = 12
/** Score 的档位上下限（与上游一致：至少 2 档、至多 10 档）。 */
export const MIN_SCORE_LEVELS = 2
export const MAX_SCORE_LEVELS = 10
/** Choice 最多多少个选项（上游是 255，这里更保守）。 */
export const MAX_CHOICE_OPTIONS = 40

/** 校验失败时抛这个，工具层会把消息原样给模型看。 */
export class QuestionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuestionError'
  }
}

/**
 * 把工具参数里的问题数组校验成 {@link Question}[]。
 *
 * 为什么不直接信任：参数是模型写的，`criteria` 在 schema 里是自由 JSON
 * （choice 要「选项→描述」的映射，score 要字符串数组），必须由这里判定，
 * 并且**报错要具体**（第几个问题、哪个字段、期望什么），否则模型只能瞎改。
 * @param raw - 工具参数里的 `questions`。
 * @returns 校验通过的问题列表。
 * @throws {QuestionError} 结构不合法。
 */
export function parseQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new QuestionError('questions 必须是非空数组')
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new QuestionError(`一次最多 ${String(MAX_QUESTIONS)} 个问题（收到 ${String(raw.length)} 个）`)
  }
  const seen = new Set<string>()
  return raw.map((item, index) => {
    const at = `questions[${String(index)}]`
    if (typeof item !== 'object' || item === null) throw new QuestionError(`${at} 必须是对象`)
    const record = item as Record<string, unknown>
    const id = record['id']
    if (typeof id !== 'string' || id.trim() === '') throw new QuestionError(`${at}.id 必须是非空字符串`)
    if (seen.has(id)) throw new QuestionError(`${at}.id "${id}" 重复了；每个问题的 id 必须唯一（答案按 id 回填）`)
    seen.add(id)
    const instructions = record['instructions']
    if (typeof instructions !== 'string' || instructions.trim() === '') {
      throw new QuestionError(`${at}.instructions 必须是非空字符串（一句话说清要判断什么）`)
    }
    const type = record['type']
    if (type !== 'choice' && type !== 'score' && type !== 'noul') {
      throw new QuestionError(`${at}.type 必须是 "choice" / "score" / "noul"，收到 ${JSON.stringify(type)}`)
    }
    if (type === 'noul') return { id, type, instructions }

    const criteria = record['criteria']
    if (type === 'choice') {
      if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
        throw new QuestionError(`${at}.criteria 必须是「选项名 → 描述」的对象，例如 {"returns":"退换货","billing":"账单"}`)
      }
      const entries = Object.entries(criteria as Record<string, unknown>)
      if (entries.length < 2) throw new QuestionError(`${at}.criteria 至少要有 2 个选项`)
      if (entries.length > MAX_CHOICE_OPTIONS) {
        throw new QuestionError(`${at}.criteria 的选项不能超过 ${String(MAX_CHOICE_OPTIONS)} 个`)
      }
      const map: Record<string, string> = {}
      for (const [key, value] of entries) {
        if (key.trim() === '') throw new QuestionError(`${at}.criteria 里有空选项名`)
        if (value !== null && typeof value !== 'string') {
          throw new QuestionError(`${at}.criteria["${key}"] 的描述必须是字符串或 null`)
        }
        map[key] = value ?? ''
      }
      return { id, type, instructions, criteria: map }
    }

    if (!Array.isArray(criteria)) {
      throw new QuestionError(`${at}.criteria 必须是有序的档位描述数组（从低到高），例如 ["无影响","有绕行方案","完全阻塞"]`)
    }
    if (criteria.length < MIN_SCORE_LEVELS || criteria.length > MAX_SCORE_LEVELS) {
      throw new QuestionError(
        `${at}.criteria 的档位数必须在 ${String(MIN_SCORE_LEVELS)}~${String(MAX_SCORE_LEVELS)} 之间（收到 ${String(criteria.length)}）`,
      )
    }
    const levels = criteria.map((level, levelIndex) => {
      if (typeof level !== 'string' || level.trim() === '') {
        throw new QuestionError(`${at}.criteria[${String(levelIndex)}] 必须是非空字符串（描述一个具体情境，不要只写数字）`)
      }
      return level
    })
    return { id, type, instructions, criteria: levels }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 组合：权重、阈值、路由 —— 这部分是「代码拥有工作流」的落点
// ─────────────────────────────────────────────────────────────────────────────

/** 组合里的一个条目。 */
export interface ComposeItem {
  readonly id: string
  /** 该维度在总分里的权重（内部会归一化，不必自己凑成 1）。 */
  readonly weight: number
  /** 归一化后的取值（0~1）。 */
  readonly value: number
  /** 原始分（写进结果便于核对）。 */
  readonly raw: string
  /** 该维度的置信度（0~1）。 */
  readonly confidence: number
}

/** 组合结果。 */
export interface ComposeResult {
  /** 加权总分（0~1）。 */
  readonly composite: number
  /** 每个维度贡献了多少分（便于解释「为什么是这个结论」）。 */
  readonly contributions: readonly { readonly id: string; readonly weight: number; readonly value: number; readonly points: number }[]
  /** 低于置信度门槛的维度 id（这些维度的分数不该被当真）。 */
  readonly lowConfidence: readonly string[]
}

/**
 * 概率加权求和（Composite scoring 模式）。
 *
 * 上游的叮嘱照抄在这里：**一个复杂判断要拆成多个单独的问题**，各自打分，再用
 * 代码里的权重合起来；权重是你的，改了权重不用重跑推理。
 * @param items - 各维度（权重 + 归一化取值 + 置信度）。
 * @param minConfidence - 低于它就记进 `lowConfidence`。
 * @returns 总分与逐项贡献。
 */
export function composeWeighted(items: readonly ComposeItem[], minConfidence: number): ComposeResult {
  const totalWeight = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
  const contributions = items.map((item) => {
    const weight = totalWeight === 0 ? 0 : Math.max(0, item.weight) / totalWeight
    return { id: item.id, weight: Number(weight.toFixed(4)), value: item.value, points: Number((weight * item.value).toFixed(4)) }
  })
  const composite = contributions.reduce((sum, item) => sum + item.points, 0)
  return {
    composite: Number(composite.toFixed(4)),
    contributions,
    lowConfidence: items.filter(item => item.confidence < minConfidence).map(item => item.id),
  }
}

/** 把 Score 归一化到 0~1（不同长度的标尺才能互相加权）。 */
export function normalizeScore(score: number, scaleMax: number): number {
  if (!Number.isFinite(scaleMax) || scaleMax <= 0) return 0
  return Number(Math.min(Math.max(score / scaleMax, 0), 1).toFixed(4))
}

/** 路由决策。 */
export type RouteDecision = 'act' | 'review' | 'escalate'

/** 路由结果。 */
export interface RouteResult {
  readonly decision: RouteDecision
  /** 决策依据（一句话，便于写进日志或给用户看）。 */
  readonly reason: string
  /** 决策锁定到的选项（confidence 够高、且是 choice 时）。 */
  readonly branch: string | null
  /** 概率也不小、值得一并通知的其它选项（上游示例里的「第二个团队抄送」）。 */
  readonly alsoNotify: readonly string[]
}

/**
 * 置信度门控路由（Confidence-gated routing 模式）。
 *
 * 三个出口，语义分明：
 *   - `escalate`：置信度低于 `minConfidence` —— 交给人或更强的推理模型，不要硬选；
 *   - `review`：够高但没到 `actAt` —— 可以动，但让人过一眼；
 *   - `act`：≥ `actAt` —— 直接用。
 * @param answer - 一个 choice 答案。
 * @param options - 阈值；`notifyAt` 以上的其它选项会被列进 `alsoNotify`。
 * @returns 路由结果。
 */
export function routeByConfidence(
  answer: ChoiceAnswer,
  options: { readonly minConfidence: number; readonly actAt: number; readonly notifyAt: number },
): RouteResult {
  const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])
  const alsoNotify = ranked
    .filter(([option, probability]) => option !== answer.choice && probability >= options.notifyAt)
    .map(([option]) => option)
  if (answer.confidence < options.minConfidence) {
    return {
      decision: 'escalate',
      reason: `confidence ${answer.confidence.toFixed(2)} < ${options.minConfidence.toFixed(2)}：分布太散，别硬选，交人/强模型`,
      branch: null,
      alsoNotify,
    }
  }
  if (answer.confidence < options.actAt) {
    return {
      decision: 'review',
      reason: `confidence ${answer.confidence.toFixed(2)} 在 [${options.minConfidence.toFixed(2)}, ${options.actAt.toFixed(2)})：可以动，但先让人过一眼`,
      branch: answer.choice,
      alsoNotify,
    }
  }
  return {
    decision: 'act',
    reason: `confidence ${answer.confidence.toFixed(2)} ≥ ${options.actAt.toFixed(2)}：直接执行`,
    branch: answer.choice,
    alsoNotify,
  }
}
