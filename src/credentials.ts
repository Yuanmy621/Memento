/**
 * DeepSeek API key 解析。
 *
 * 解析顺序（先到先用）：
 *   1. `YuanMy_API_KEY` / `DEEPSEEK_API_KEY` 环境变量；
 *   2. DSH 自己的凭据库 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）
 *      的 `refs.DEEPSEEK_API_KEY` —— 也就是 DSH Web/CLI 已经写入的那把 key。
 *
 * 解析结果会被写回 `process.env[DEEPSEEK_API_KEY]`，因为
 * `@deepseek-ai/dsh-llm-deepseek` 是从“启动环境快照”里按变量名取 key 的。
 * 本模块只负责取出与安装，任何日志都不得打印 key 本身。
 *
 * @module YuanMy/credentials
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 适配器默认读取的环境变量名（`llm-deepseek` 的 `apiKeyEnv`）。 */
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 本工具自己的覆盖变量，优先级最高。 */
export const YuanMy_API_KEY_ENV = 'YuanMy_API_KEY'

/** 一次成功的解析：key 本身 + 它来自哪里（用于启动横幅展示）。 */
export interface ResolvedCredential {
  /** 真实 key；调用方不得打印。 */
  readonly key: string
  /** 人类可读的来源描述，例如 `$DEEPSEEK_API_KEY` 或 `~/.dsh/.credentials.yaml`。 */
  readonly origin: string
}

/** 把 key 变成可安全打印的指纹，例如 `sk-ab…9f2`。 */
export function fingerprint(key: string): string {
  return key.length <= 10 ? '***' : `${key.slice(0, 5)}…${key.slice(-3)}`
}

/** DSH 凭据库的路径。 */
export function dshCredentialsPath(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh'), '.credentials.yaml')
}

/**
 * 从 DSH 凭据库中读取一个凭据引用。
 *
 * 该文件结构固定且很小，`refs:` 段里的值就是明文 secret（DSH 自己写入的），
 * 因此这里用一个定向的正则解析，避免为此引入 YAML 依赖。
 * @param ref - 凭据名，默认 `DEEPSEEK_API_KEY`。
 * @returns 命中的凭据；文件缺失或没有该引用时返回 `undefined`。
 */
export function readDshCredential(ref: string = API_KEY_ENV): ResolvedCredential | undefined {
  const path = dshCredentialsPath()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const refsAt = text.search(/^refs:\s*$/m)
  const section = refsAt === -1 ? text : text.slice(refsAt)
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^[ \\t]+${escaped}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(section)
  if (match === null) return undefined
  const value = unquote(match[1])
  if (value.length === 0) return undefined
  return { key: value, origin: path.replace(homedir(), '~') }
}

/** 去掉 YAML 里可能出现的成对引号。 */
function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * 找出可用的 key，但不修改环境。
 * @returns 命中的凭据，或 `undefined`。
 */
export function resolveApiKey(): ResolvedCredential | undefined {
  const own = process.env[YuanMy_API_KEY_ENV]?.trim()
  if (own !== undefined && own.length > 0) return { key: own, origin: `$${YuanMy_API_KEY_ENV}` }
  const ambient = process.env[API_KEY_ENV]?.trim()
  if (ambient !== undefined && ambient.length > 0) return { key: ambient, origin: `$${API_KEY_ENV}` }
  return readDshCredential()
}

/**
 * 解析并把 key 安装到 `process.env`，供 llm-deepseek 在请求时读取。
 * @returns 命中的凭据；没有 key 时返回 `undefined`（此时 agent 仍能启动，只是首次请求会失败）。
 */
export function installApiKey(): ResolvedCredential | undefined {
  const hit = resolveApiKey()
  if (hit !== undefined) process.env[API_KEY_ENV] = hit.key
  return hit
}
