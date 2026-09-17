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

const HELP = `YuanMy — 基于 DeepSeek Harness 内核的终端 coding agent

用法:
  YuanMy [选项]

选项:
  -p, --prompt <text>     一次性执行该任务后退出（非交互）
      --cwd <dir>         agent 的工作目录（默认: 当前目录）
      --model <id>        模型 id（默认: $YuanMy_MODEL 或 deepseek-flash）
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
  let model = process.env.YuanMy_MODEL?.trim() || 'deepseek-flash'
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

  const root = resolve(cwd ?? process.cwd())
  return {
    cwd: root,
    stateDir: resolve(stateDir ?? `${root}/.YuanMy`),
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
  }
}
