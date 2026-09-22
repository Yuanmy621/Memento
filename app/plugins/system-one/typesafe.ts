/**
 * TypeSafe 后端：直接打官方的 System One 接口（`POST /v1/systemone`）。
 *
 * 契约来自官方文档（https://docs.typesafe.ai/api 与三个 primitive 页），字段名一个不改：
 *
 * ```jsonc
 * // 请求
 * {
 *   "state": "…文本…" | { …对象… } | [ …数组… ],
 *   "model": "jev-latest",
 *   "questions": {
 *     "department": { "type": "choice", "instructions": "…", "criteria": { "returns": "…", "billing": "…" } },
 *     "severity":   { "type": "score",  "instructions": "…", "criteria": ["低", "中", "高"] },
 *     "is_refund":  { "type": "noul",   "instructions": "…" }
 *   }
 * }
 * // 响应
 * {
 *   "model": "jev-1.13.0",
 *   "answers": {
 *     "department": { "type":"choice", "choice":"returns", "confidence":0.42, "probabilities":{…} },
 *     "severity":   { "type":"score",  "score":1.43, "confidence":0.35, "legend":{"0":"低",…}, "probabilities":{"0":0.0,…} },
 *     "is_refund":  { "type":"noul",   "noul":0.95 }
 *   },
 *   "usage": { "input_tokens": 589, "output_tokens": 212 }
 * }
 * ```
 *
 * 三条与上游对齐的语义（写在这里免得以后改坏）：
 *   1. 一次请求里所有问题**并行独立**评估，互相看不到对方的答案；
 *   2. `confidence` 只描述这次回答的分布有多集中，**不是**「答案正确」的保证；
 *   3. 答案里的概率是**标定过**的（上游把 calibration 当训练目标）。
 *
 * @module YuanMy/plugins/system-one/typesafe
 */

import type { Answer, ChoiceAnswer, NoulAnswer, Question, ScoreAnswer } from './primitives.ts'

/** 调 TypeSafe 需要的配置。 */
export interface TypeSafeConfig {
  /** API key（`Authorization: Bearer …`）。 */
  readonly apiKey: string
  /** 网关地址，默认 `https://api.typesafe.ai`。 */
  readonly baseUrl: string
  /** 模型名，默认 `jev-latest`。 */
  readonly model: string
}

/** 后端失败的分类，决定给模型的提示是「去配 key」还是「重试」。 */
export type TypeSafeErrorKind = 'no-credential' | 'auth' | 'rate-limit' | 'http' | 'api'

/** 带分类的失败。 */
export class TypeSafeError extends Error {
  readonly kind: TypeSafeErrorKind

  constructor(kind: TypeSafeErrorKind, message: string) {
    super(message)
    this.name = 'TypeSafeError'
    this.kind = kind
  }
}

/** 一次调用的结果。 */
export interface TypeSafeResult {
  readonly answers: readonly Answer[]
  /** 上游报的模型版本（如 `jev-1.13.0`）。 */
  readonly model: string
  /** token 计量（上游原样给）。 */
  readonly usage: Readonly<Record<string, number>>
  /** 往返耗时（毫秒）。 */
  readonly elapsedMs: number
}

/** 把问题列表编成上游的 `questions` 映射。 */
function toWireQuestions(questions: readonly Question[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const question of questions) {
    if (question.type === 'choice') {
      out[question.id] = { type: 'choice', instructions: question.instructions, criteria: question.criteria }
      continue
    }
    if (question.type === 'score') {
      out[question.id] = { type: 'score', instructions: question.instructions, criteria: question.criteria }
      continue
    }
    out[question.id] = { type: 'noul', instructions: question.instructions }
  }
  return out
}

/**
 * state 的形态：能当 JSON 解析就用对象/数组（上游推荐「有多个部分时用命名的 JSON 字段」），
 * 否则原样当字符串。这样调用方不用关心上游接受什么类型。
 */
function toWireState(state: string): unknown {
  const trimmed = state.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return state
    }
  }
  return state
}

/** 从上游答案里取一个数值字段，缺失就明确报错（不静默给 0）。 */
function numberField(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeSafeError('api', `${where} 缺少数值字段 ${key}（上游返回结构变了？）`)
  }
  return value
}

/** 把上游的 probabilities 规整成 `Record<string, number>`。 */
function probabilitiesField(source: Record<string, unknown>, where: string): Record<string, number> {
  const raw = source['probabilities']
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeSafeError('api', `${where} 缺少 probabilities（上游返回结构变了？）`)
  }
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number') out[key] = value
  }
  return out
}

/**
 * 调一次 TypeSafe。
 * @param questions - 已校验的问题列表。
 * @param state - 待评估内容（字符串；像 JSON 就转成对象发过去）。
 * @param config - key / 网关 / 模型。
 * @param signal - 取消信号。
 * @returns 结构化答案 + 计量。
 * @throws {TypeSafeError} 没 key、鉴权失败、限速、网络或上游结构异常。
 */
export async function askTypeSafe(
  questions: readonly Question[],
  state: string,
  config: TypeSafeConfig,
  signal: AbortSignal,
): Promise<TypeSafeResult> {
  if (config.apiKey.trim() === '') {
    throw new TypeSafeError('no-credential', '没有 TypeSafe API key')
  }
  const body = JSON.stringify({
    state: toWireState(state),
    model: config.model,
    questions: toWireQuestions(questions),
  })
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      signal,
    })
  } catch (error) {
    throw new TypeSafeError('http', `请求 TypeSafe 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const elapsedMs = Date.now() - started
  const text = await response.text()

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new TypeSafeError('auth', `TypeSafe 拒绝了这个 key（HTTP ${String(response.status)}）：${text.slice(0, 160)}`)
    }
    if (response.status === 429) {
      throw new TypeSafeError('rate-limit', `TypeSafe 限速（HTTP 429）：${text.slice(0, 160)}`)
    }
    throw new TypeSafeError('http', `TypeSafe 返回 HTTP ${String(response.status)}：${text.slice(0, 200)}`)
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new TypeSafeError('api', `TypeSafe 返回的不是 JSON：${text.slice(0, 160)}`)
  }

  const answersRaw = payload['answers']
  if (typeof answersRaw !== 'object' || answersRaw === null) {
    throw new TypeSafeError('api', 'TypeSafe 响应里没有 answers 字段')
  }
  const answersById = answersRaw as Record<string, Record<string, unknown>>
  const answers: Answer[] = questions.map((question) => {
    const where = `answers.${question.id}`
    const raw = answersById[question.id]
    if (typeof raw !== 'object' || raw === null) {
      throw new TypeSafeError('api', `${where} 缺失（上游没有回答这个问题？）`)
    }
    if (question.type === 'choice') {
      const choice = raw['choice']
      if (typeof choice !== 'string') throw new TypeSafeError('api', `${where}.choice 不是字符串`)
      const built: ChoiceAnswer = {
        id: question.id,
        type: 'choice',
        choice,
        probabilities: probabilitiesField(raw, where),
        confidence: numberField(raw, 'confidence', where),
      }
      return built
    }
    if (question.type === 'score') {
      const built: ScoreAnswer = {
        id: question.id,
        type: 'score',
        score: numberField(raw, 'score', where),
        scaleMax: question.criteria.length - 1,
        legend: question.criteria,
        probabilities: probabilitiesField(raw, where),
        confidence: numberField(raw, 'confidence', where),
      }
      return built
    }
    const built: NoulAnswer = {
      id: question.id,
      type: 'noul',
      noul: numberField(raw, 'noul', where),
      // Noul 没有单独的 confidence（上游语义）：集中度就是两侧概率的较大者
      probabilities: { yes: numberField(raw, 'noul', where), no: Number((1 - numberField(raw, 'noul', where)).toFixed(4)) },
      confidence: Math.max(numberField(raw, 'noul', where), 1 - numberField(raw, 'noul', where)),
    }
    return built
  })

  const usage = typeof payload['usage'] === 'object' && payload['usage'] !== null
    ? Object.fromEntries(Object.entries(payload['usage'] as Record<string, unknown>).filter(([, v]) => typeof v === 'number') as [string, number][])
    : {}
  return {
    answers,
    model: typeof payload['model'] === 'string' ? payload['model'] : config.model,
    usage,
    elapsedMs,
  }
}
