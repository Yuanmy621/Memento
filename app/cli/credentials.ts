/**
 * 凭据解析：**环境变量优先，DSH 凭据库兜底**。
 *
 * 两套入口，别混：
 *
 * | 入口 | 认哪些 ref | 谁在用 |
 * | --- | --- | --- |
 * | `resolveApiKey()` / `installApiKey()` | `Memento_API_KEY` → `DEEPSEEK_API_KEY` → 凭据库 `DEEPSEEK_API_KEY` | 模型 API key（`llm-deepseek` 按**固定**变量名取值） |
 * | {@link resolveCredential} / {@link installCredential} / {@link installCredentials} | 环境变量 `$<ref>` → 凭据库 `refs.<ref>` | **任意**额外配置项（例如 system-one 插件的 `TYPESAFE_API_KEY`） |
 *
 * 凭据库 = `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）的 `refs:` 段，
 * 也就是 DSH Web/CLI 已经写入的那些 key。
 *
 * 解析结果要**写回 `process.env`**，因为消费方（`dsh-llm-deepseek`、system-one 插件）
 * 都是按变量名从进程环境里取值的 —— 所以必须在 **import 它们之前**完成安装。
 * `app/desktop/host/index.ts` 开头那段注释讲的就是这个顺序。
 *
 * ⚠️ 任何日志都不得打印 key 本身；要给人看就用 {@link fingerprint}。
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
 * 内核插件要的**额外**凭据（除模型 API key 之外）。
 *
 * 为什么要有这张表：这些 key 的消费方是插件，而插件只认 `process.env[名字]`，
 * 不会来问本模块。表放在这里、由两个启动入口共用（`app/cli/main.ts` 与
 * `app/desktop/host/index.ts`），是为了让它们**不漂** —— 加一个插件 key 只改这一行，
 * CLI 与桌面端同时生效（这正是 `SUPPORTED_MODELS` 那套「单一事实来源」的做法）。
 *
 * ⚠️ **别把模型 API key 加进来**：它走 {@link installApiKey}，多一层 `Memento_API_KEY`
 * 覆盖变量，优先级与本表不同。
 *
 * 缺一个 ref **不是错误**：对应插件的那个工具会在被调用时报错，内核照常启动。
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

/** DSH 凭据库的路径。 */
export function dshCredentialsPath(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh'), '.credentials.yaml')
}

/**
 * 取出凭据库的 `refs:` **段**（不含后面的 `records:` 段）。
 *
 * ⚠️ 段边界不能省。这个文件是三段（`version` / `refs` / `records`），而 `records:` 段里
 * 有一堆**同样缩进**的字段名（`kind` / `payload` / `version` / `secret`）。早先的写法是
 * 「从 `refs:` 切到文件末尾」，只查 `DEEPSEEK_API_KEY` 时看不出问题；一旦支持任意 ref，
 * 查 `secret` 就会命中 `records` 里的字段并**默默返回一个不是凭据的值**。
 *
 * 判据是缩进：段内每一行都以空白开头，第一个**顶格**行就是下一段的开始。
 * （空行不算结束 —— 段内允许有空行。）
 * @param text - 凭据库全文。
 * @returns `refs:` 段的正文；没有这一段时是空串。
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
 * 从 DSH 凭据库中读取一个凭据引用。
 *
 * 该文件结构固定且很小，`refs:` 段里的值就是明文 secret（DSH 自己写入的），
 * 因此这里用一个定向的正则解析，避免为此引入 YAML 依赖。
 * @param ref - 凭据名，默认 `DEEPSEEK_API_KEY`。名字里的正则元字符会被转义，
 *   所以 `a/b`、`a.b` 这类引用名也安全。
 * @returns 命中的凭据；文件缺失、没有 `refs:` 段或没有该引用时返回 `undefined`。
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
 * 解析**任意**凭据引用，但不修改环境。
 *
 * 顺序（先到先用）：
 *   1. 环境变量 `$<ref>` —— 显式 export 的永远最优先；
 *   2. 凭据库 `refs.<ref>`。
 *
 * 与 {@link resolveApiKey} 只差一条：DeepSeek 那把 key 多一层本工具专属的覆盖变量
 * `Memento_API_KEY`（历史原因）。通用入口**不**为每个 ref 再造一个覆盖变量 ——
 * ref 本身就是那个环境变量名，再加一层只会让人搞不清该 export 哪个。
 *
 * @param ref - 凭据名，同时也是目标环境变量名（例如 `TYPESAFE_API_KEY`）。
 * @returns 命中的凭据；名字为空或两处都没有时返回 `undefined`。
 */
export function resolveCredential(ref: string): ResolvedCredential | undefined {
  const name = ref.trim()
  if (name === '') return undefined
  const ambient = process.env[name]?.trim()
  if (ambient !== undefined && ambient.length > 0) return { key: ambient, origin: `$${name}` }
  return readDshCredential(name)
}

/**
 * 解析并把一个凭据安装到 `process.env[ref]`，供「按变量名取值」的消费方读取。
 *
 * 写回是**必需**的：`dsh-llm-deepseek` 与 system-one 插件都是直接读
 * `process.env[名字]`，不会来问本模块。
 * @param ref - 凭据名（= 环境变量名）。
 * @returns 命中的凭据；没配时返回 `undefined` —— **这不是错误**，由调用方决定要不要告警。
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
 * 批量安装（给启动流程用）：只要能解析到就写进 `process.env`。
 *
 * 命中与没命中**都**返回 —— 「哪些没配」正是启动日志要报告的东西。
 * 而且这里**不抛异常**：一个可选配置项缺失，不该让内核起不来。
 * @param refs - 凭据名列表。
 * @returns 与入参同序的结果列表。
 */
export function installCredentials(refs: readonly string[]): readonly InstalledCredential[] {
  return refs.map(ref => ({ ref: ref.trim(), credential: installCredential(ref) }))
}

/**
 * 找出可用的 DeepSeek key，但不修改环境。
 * @returns 命中的凭据，或 `undefined`。
 */
export function resolveApiKey(): ResolvedCredential | undefined {
  const own = process.env[Memento_API_KEY_ENV]?.trim()
  if (own !== undefined && own.length > 0) return { key: own, origin: `$${Memento_API_KEY_ENV}` }
  return resolveCredential(API_KEY_ENV)
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
