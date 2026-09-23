/**
 * MCP 服务器的配置文件层：让「挂哪些服务器」可以不改代码、不改环境变量地改。
 *
 * 来源优先级为配置文件（`<cwd>/.Memento/mcp.json`）> 项目目录 > 内置，`$Memento_MCP`
 * 是临时开关。JSON 写坏不会让内核启动失败：`readMcpConfig()` 只记录错误并返回空表。
 *
 * @module Memento/cli/mcp-config
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一条 MCP 服务器配置。 */
export interface McpConfigEntry {
  /** 服务器名字（也是工具名里的命名空间）。 */
  readonly name: string
  /** 是否挂载；只有显式写 `true` 才挂载，缺省或漏写一律视为不挂载。 */
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
  return join(cwd, '.Memento', 'mcp.json')
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
 * 读 MCP 配置，坏文件不抛异常：内核启动不因一个手写坏的 JSON 而失败。
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
