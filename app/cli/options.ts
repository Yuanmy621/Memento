/**
 * 命令行参数解析（零依赖）。
 *
 * @module YuanMy/options
 */

import { resolve } from 'node:path'

/** 允许的推理强度，与 DeepSeek adapter 的 `reasoningEffort` 对齐。 */
export const EFFORTS = ['off', 'low', 'high', 'max'] as const
/** 推理强度类型。 */
export type Effort = (typeof EFFORTS)[number]

/** 一次 CLI 运行的完整配置。 */
export interface Options {
  /** agent 的工作目录（同时作为会话 `cwd` 与文件工具的相对根）。 */
  readonly cwd: string
  /** 该目录存放会话日志与自定义工具产生的数据。 */
  readonly stateDir: string
  /** LLM provider id。 */
  readonly provider: string
  /** 模型 id。 */
  readonly model: string
  /** 推理强度。 */
  readonly effort: Effort
  /** 单次请求输出上限；`undefined` 用 provider 默认。 */
  readonly maxTokens: number | undefined
  /** 显式指定的新会话 id；`undefined` 则自动生成。 */
  readonly sessionId: string | undefined
  /** 恢复某个已落盘的会话。 */
  readonly resume: string | undefined
  /** 一次性提问（非交互模式）。 */
  readonly prompt: string | undefined
  /** 是否把会话写入 `stateDir/sessions`。 */
  readonly persist: boolean
  /** 只打印内核里注册的工具后退出。 */
  readonly listTools: boolean
  /** 不显示模型的推理过程。 */
  readonly noReasoning: boolean
  /** 打印帮助。 */
  readonly help: boolean
}

/** 解析失败时抛出；`main` 会把它转成退出码 2。 */
export class UsageError extends Error {}

/**
 * YuanMy **对用户暴露**的模型清单（单一事实来源）。
 *
 * 内核适配器申报的目录比这更长（还包含 `deepseek-flash` 这个 V4.1 旧版，
 * 以及 `deepseek-v4-flash-vision-exp` 实验视觉模型）。这里只保留两款主力，
 * CLI 的默认值与桌面端下拉框都从这里取 —— 两边因此不会漂移。
 *
 * `name` 只作**兜底显示名**：读得到适配器目录时优先用适配器给的名称与描述，
 * 读不到（离线、适配器不申报）时用它，至少不是一个裸 id。
 */
export const SUPPORTED_MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
] as const

/** 默认模型：清单里的第一款。 */
export const DEFAULT_MODEL: string = SUPPORTED_MODELS[0].id

/** 允许缺省的配置输入（桌面端等非 CLI 调用方从这里进入）。 */
export interface OptionsInput extends Partial<Options> {}

/**
 * 用 CLI 的同一套默认值把「部分配置」补全成完整的 {@link Options}。
 *
 * CLI 走 `parseOptions()`（argv → 本函数）；桌面端直接传 `{ cwd, model }` 等字段。
 * 两边的默认值因此只在一处定义，不会漂移。
 * @param input - 调用方显式给出的字段；其余取默认值。
 * @returns 归一化后的完整配置（`cwd` / `stateDir` 已解析成绝对路径）。
 */
export function resolveOptions(input: OptionsInput = {}): Options {
  const root = resolve(input.cwd ?? process.cwd())
  return {
    cwd: root,
    stateDir: resolve(input.stateDir ?? `${root}/.YuanMy`),
    provider: input.provider ?? 'deepseek-official',
    model: input.model ?? (process.env.YuanMy_MODEL?.trim() || DEFAULT_MODEL),
    effort: input.effort ?? 'high',
    maxTokens: input.maxTokens,
    sessionId: input.sessionId,
    resume: input.resume,
    prompt: input.prompt,
    persist: input.persist ?? true,
    listTools: input.listTools ?? false,
    noReasoning: input.noReasoning ?? false,
    help: input.help ?? false,
  }
}

const HELP = `YuanMy — 基于 DeepSeek Harness 内核的终端 coding agent

用法:
  YuanMy [选项]

选项:
  -p, --prompt <text>     一次性执行该任务后退出（非交互）
      --cwd <dir>         agent 的工作目录（默认: 当前目录）
      --model <id>        模型 id（默认: $YuanMy_MODEL 或 ${DEFAULT_MODEL}）
      --provider <id>     provider id（默认: deepseek-official）
      --effort <level>    推理强度: off | low | high | max（默认: high）
      --max-tokens <n>    单次请求输出上限
      --session <id>      指定新会话 id（默认自动生成）
      --resume <id>       恢复一个已持久化的会话
      --state-dir <dir>   会话与运行数据目录（默认: <cwd>/.YuanMy）
      --no-persist        不把会话写入磁盘
      --list-tools        打印已注册工具后退出
      --no-reasoning      不显示模型的推理过程（默认灰色显示）
  -h, --help              显示帮助
  -v, --version           显示版本

环境变量:
  DEEPSEEK_API_KEY        模型 API key；缺省时回退到 ~/.dsh/.credentials.yaml
  YuanMy_API_KEY            同上，优先级更高
  YuanMy_MODEL              默认模型 id
`

/** 帮助文本。 */
export function helpText(): string {
  return HELP
}

/** 读取一个需要取值的选项。 */
function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new UsageError(`${flag} 需要一个取值`)
  }
  return value
}

/**
 * 解析 `process.argv.slice(2)`。
 * @param argv - 去掉 `node script` 之后的参数数组。
 * @returns 解析后的配置。
 * @throws UsageError 参数非法时。
 */
export function parseOptions(argv: readonly string[]): Options {
  let cwd: string | undefined
  let stateDir: string | undefined
  let provider = 'deepseek-official'
  let model = process.env.YuanMy_MODEL?.trim() || DEFAULT_MODEL
  let effort: Effort = 'high'
  let maxTokens: number | undefined
  let sessionId: string | undefined
  let resume: string | undefined
  let prompt: string | undefined
  let persist = true
  let listTools = false
  let noReasoning = false
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        break
      case '-v':
      case '--version':
        process.stdout.write('YuanMy 0.1.0\n')
        process.exit(0)
        break
      case '-p':
      case '--prompt':
        prompt = takeValue(argv, i, arg)
        i += 1
        break
      case '--cwd':
        cwd = takeValue(argv, i, arg)
        i += 1
        break
      case '--state-dir':
        stateDir = takeValue(argv, i, arg)
        i += 1
        break
      case '--model':
        model = takeValue(argv, i, arg)
        i += 1
        break
      case '--provider':
        provider = takeValue(argv, i, arg)
        i += 1
        break
      case '--effort': {
        const value = takeValue(argv, i, arg)
        if (!(EFFORTS as readonly string[]).includes(value)) {
          throw new UsageError(`--effort 只能是 ${EFFORTS.join(' | ')}，收到 "${value}"`)
        }
        effort = value as Effort
        i += 1
        break
      }
      case '--max-tokens': {
        const value = Number(takeValue(argv, i, arg))
        if (!Number.isInteger(value) || value <= 0) throw new UsageError('--max-tokens 需要正整数')
        maxTokens = value
        i += 1
        break
      }
      case '--session':
        sessionId = takeValue(argv, i, arg)
        i += 1
        break
      case '--resume':
        resume = takeValue(argv, i, arg)
        i += 1
        break
      case '--no-persist':
        persist = false
        break
      case '--list-tools':
        listTools = true
        break
      case '--no-reasoning':
        noReasoning = true
        break
      default:
        throw new UsageError(`未知选项 "${arg}"（用 --help 查看用法）`)
    }
  }

  if (resume !== undefined && sessionId !== undefined) {
    throw new UsageError('--resume 与 --session 不能同时使用')
  }

  return resolveOptions({
    cwd,
    stateDir,
    provider,
    model,
    effort,
    maxTokens,
    sessionId,
    resume,
    prompt,
    persist,
    listTools,
    noReasoning,
    help,
  })
}
