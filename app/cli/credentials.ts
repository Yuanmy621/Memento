/**
 * 凭据解析：环境变量优先，凭据库的 `refs:` 段兜底。
 *
 * 凭据库指 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）。
 * 解析结果会写回 `process.env`，因为消费方（`dsh-llm-deepseek`、system-one 插件）
 * 按变量名从进程环境取值，所以要在 import 它们之前完成安装；日志不得打印 key 本身。
 *
 * @module Memento/credentials
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 适配器默认读取的环境变量名（`llm-deepseek` 的 `apiKeyEnv`）。 */
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 本工具自己的覆盖变量，优先级最高。 */
export const Memento_API_KEY_ENV = 'Memento_API_KEY'

/**
 * 内核插件要的额外凭据（除模型 API key 外），消费方只认 `process.env[名字]`；缺一个 ref
 * 不是错误，对应工具在被调用时才报错。模型 API key 不在此列，它走 `installApiKey()`。
 */
export const PLUGIN_CREDENTIAL_REFS = [
  /** system-one 插件（决策原语 `sysone_ask` / `sysone_compose`）的 TypeSafe/Jev 网关 key。 */
  'TYPESAFE_API_KEY',
] as const

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

/** 凭据库（`$DSH_HOME/.credentials.yaml`）的路径。 */
export function dshCredentialsPath(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh'), '.credentials.yaml')
}

/**
 * 取出凭据库的 `refs:` 段正文：段内每行都以空白开头，第一个顶格行即下一段开始
 * （空行不算结束）。不划段边界的话，查 `secret` 会命中后面 `records:` 段的同名字段。
 */
function refsSection(text: string): string {
  const lines: string[] = []
  let inside = false
  for (const line of text.split('\n')) {
    if (!inside) {
      if (/^refs:[ \t]*$/.test(line)) inside = true
      continue
    }
    if (line !== '' && !/^[ \t]/.test(line)) break
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * 从凭据库读一个凭据引用：`refs:` 段里的值就是明文 secret，用定向正则解析，
 * 不引 YAML 依赖；引用名里的正则元字符会被转义。
 */
export function readDshCredential(ref: string = API_KEY_ENV): ResolvedCredential | undefined {
  const path = dshCredentialsPath()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^[ \\t]+${escaped}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(refsSection(text))
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

// ─────────────────────────────────────────────────────────────────────────────
// 通用入口：任意 ref（插件的 API key 之类「额外配置项」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析任意凭据引用但不修改环境：先环境变量 `$<ref>`，再凭据库 `refs.<ref>`；与
 * `resolveApiKey()` 的差别是后者多一层 `Memento_API_KEY` 覆盖变量。
 */
export function resolveCredential(ref: string): ResolvedCredential | undefined {
  const name = ref.trim()
  if (name === '') return undefined
  const ambient = process.env[name]?.trim()
  if (ambient !== undefined && ambient.length > 0) return { key: ambient, origin: `$${name}` }
  return readDshCredential(name)
}

/**
 * 解析并把凭据写入 `process.env[ref]`，供「按变量名取值」的消费方读取；没配时返回
 * `undefined`，不算错误，由调用方决定要不要告警。
 */
export function installCredential(ref: string): ResolvedCredential | undefined {
  const name = ref.trim()
  const hit = resolveCredential(name)
  if (hit !== undefined && name !== '') process.env[name] = hit.key
  return hit
}

/** 批量安装的结果：每个 ref 配上它到底有没有命中。 */
export interface InstalledCredential {
  /** 凭据名（= 环境变量名）。 */
  readonly ref: string
  /** 命中的凭据；没配就是 `undefined`。 */
  readonly credential: ResolvedCredential | undefined
}

/**
 * 批量安装：命中与没命中都返回（启动日志要报告哪些没配），且不抛异常 ——
 * 一个可选配置项缺失不该让内核起不来。
 */
export function installCredentials(refs: readonly string[]): readonly InstalledCredential[] {
  return refs.map(ref => ({ ref: ref.trim(), credential: installCredential(ref) }))
}

/** 找出可用的 DeepSeek key，但不修改环境。 */
export function resolveApiKey(): ResolvedCredential | undefined {
  const own = process.env[Memento_API_KEY_ENV]?.trim()
  if (own !== undefined && own.length > 0) return { key: own, origin: `$${Memento_API_KEY_ENV}` }
  return resolveCredential(API_KEY_ENV)
}

/**
 * 解析并把 key 安装到 `process.env`，供 `llm-deepseek` 在请求时读取；没有 key 时返回
 * `undefined`，agent 仍能启动，只是首次请求会失败。
 */
export function installApiKey(): ResolvedCredential | undefined {
  const hit = resolveApiKey()
  if (hit !== undefined) process.env[API_KEY_ENV] = hit.key
  return hit
}
