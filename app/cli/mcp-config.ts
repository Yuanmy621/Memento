/**
 * MCP 服务器的**配置文件**层：让「挂哪些服务器」可以不改代码、不改环境变量地改。
 *
 * ## 三种来源，一份配置
 *
 * | 来源 | 位置 | 说明 |
 * | --- | --- | --- |
 * | 内置 | `app/cli/kernel.ts` 的 `mcpSpecs()` | 仓库自带的（补天） |
 * | 项目目录 | `<cwd>/.YuanMy/mcp/<名字>.{ts,js}` | 丢个文件进去就是一个 server |
 * | **配置文件** | `<cwd>/.YuanMy/mcp.json` | 本模块管的：显式开关（`enabled: true` 才挂）+ 可用内联定义覆盖 |
 *
 * 优先级：配置文件 > 项目目录 > 内置。`$YuanMy_MCP`（冒号分隔的名字）仍然有效，
 * 它是「临时开一个」的快捷方式；配置里显式 `enabled: true` 才是持久开关。
 *
 * ## 配置文件长什么样
 *
 * ```json
 * {
 *   "servers": [
 *     { "name": "butian", "enabled": true },
 *     { "name": "my-thing", "enabled": false },
 *     {
 *       "name": "remote",
 *       "enabled": true,
 *       "transport": "streamable-http",
 *       "url": "http://127.0.0.1:3000/mcp",
 *       "headers": { "Authorization": "Bearer …" }
 *     }
 *   ]
 * }
 * ```
 *
 * 只写 `{ "name": "butian", "enabled": true }` 就够 —— 其余字段从内置/项目目录的
 * 定义里继承，所以开关一个服务器不用抄一遍启动参数。
 *
 * ⚠️ 写坏了（JSON 语法错）不能把内核搞崩：{@link readMcpConfig} 只记录错误并返回空表，
 * 由调用方决定要不要提示。设置界面会把这个错误显示出来。
 *
 * @module YuanMy/cli/mcp-config
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一条 MCP 服务器配置。 */
export interface McpConfigEntry {
  /** 服务器名字（也是工具名里的命名空间）。 */
  readonly name: string
  /** 是否挂载。必须显式写 `true`；缺省/漏写一律视为不挂载。 */
  readonly enabled: boolean
  /** 传输方式；缺省从别的来源继承。 */
  readonly transport?: 'stdio' | 'streamable-http'
  /** stdio：可执行文件。 */
  readonly command?: string
  /** stdio：参数。 */
  readonly args?: readonly string[]
  /** stdio：显式转发的环境变量名。 */
  readonly forwardEnv?: readonly string[]
  /** streamable-http：端点。 */
  readonly url?: string
  /** streamable-http：请求头。 */
  readonly headers?: Readonly<Record<string, string>>
}

/** 读配置的结果。 */
export interface McpConfig {
  /** 配置里的条目（顺序即文件的顺序）。 */
  readonly entries: readonly McpConfigEntry[]
  /** 配置文件绝对路径。 */
  readonly path: string
  /** 文件是否存在。 */
  readonly exists: boolean
  /** 解析失败的原因（存在但不是合法 JSON 时）。 */
  readonly error?: string
}

/** 配置文件相对工作目录的位置。 */
export function mcpConfigPath(cwd: string): string {
  return join(cwd, '.YuanMy', 'mcp.json')
}

/** 把未知值收紧成字符串数组。 */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length === value.length ? out : undefined
}

/** 把未知值收紧成字符串字典。 */
function stringDict(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    out[key] = item
  }
  return out
}

/**
 * 读 MCP 配置。
 *
 * 坏文件**不抛异常**：内核启动不该因为一个手写坏的 JSON 就失败。
 * @param cwd - agent 的工作目录。
 * @returns 配置（含路径、是否存在、解析错误）。
 */
export function readMcpConfig(cwd: string): McpConfig {
  const path = mcpConfigPath(cwd)
  if (!existsSync(path)) return { entries: [], path, exists: false }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { entries: [], path, exists: true, error: error instanceof Error ? error.message : String(error) }
  }
  const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { servers?: unknown }).servers)
    ? (raw as { servers: unknown[] }).servers
    : []
  const entries: McpConfigEntry[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record['name'] !== 'string' || record['name'] === '') continue
    const transport = record['transport'] === 'stdio' || record['transport'] === 'streamable-http'
      ? record['transport']
      : undefined
    entries.push({
      name: record['name'],
      enabled: record['enabled'] === true,
      ...(transport === undefined ? {} : { transport }),
      ...(typeof record['command'] === 'string' ? { command: record['command'] } : {}),
      ...(stringArray(record['args']) === undefined ? {} : { args: stringArray(record['args']) as string[] }),
      ...(stringArray(record['forwardEnv']) === undefined ? {} : { forwardEnv: stringArray(record['forwardEnv']) as string[] }),
      ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
      ...(stringDict(record['headers']) === undefined ? {} : { headers: stringDict(record['headers']) as Record<string, string> }),
    })
  }
  return { entries, path, exists: true }
}
