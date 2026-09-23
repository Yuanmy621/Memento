/**
 * Memento 自己的工具插件：补充内核里没有的 `tree` 与 `fetch_url`。
 *
 * 插件形状为模块级 `name` + `inject` + `apply(ctx, config)`，可以直接
 * `await ctx.plugin(customTools)` 挂载；官方工具由 `@deepseek-ai/dsh-tool-*` 提供。
 *
 * @module Memento/tools
 */

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 插件名。 */
export const name = 'Memento-tools'
/** 依赖 `ctx.tools` 注册表。 */
export const inject = ['tools']

/** 插件配置：工具需要一个可信的工作目录基准（模型给的相对路径以它为根）。 */
export interface Config {
  /** agent 的工作目录，绝对路径。 */
  readonly cwd: string
}

/** 配置 schema：`cwd` 没有默认值，缺失时在挂载阶段报错。 */
export const Config: z<Config> = z.object({
  cwd: z.string().required(),
})

/** 目录遍历时默认跳过的名字。 */
const DEFAULT_IGNORES = new Set([
  '.git', '.hg', '.svn', '.DS_Store', '.Memento', '.cache', '.turbo', '.venv', '.idea', '.vscode-test',
  'node_modules', 'dist', 'build', 'out', 'coverage', '__pycache__', 'target', '.next', '.nuxt',
])

/** `tree` 的默认/上限参数。 */
const TREE_DEFAULT_DEPTH = 3
const TREE_MAX_DEPTH = 10
const TREE_DEFAULT_LIMIT = 400
const TREE_MAX_LIMIT = 5000

/** `fetch_url` 的默认/上限参数。 */
const FETCH_DEFAULT_CHARS = 20_000
const FETCH_MAX_CHARS = 200_000
const FETCH_TIMEOUT_MS = 20_000

/** 一行 `tree` 输出。 */
interface TreeLine {
  readonly depth: number
  readonly name: string
  readonly kind: 'dir' | 'file' | 'link'
}

/**
 * 递归收集目录条目，深度优先、目录在前、名字升序。
 */
async function collectTree(
  root: string,
  options: {
    readonly depth: number
    readonly includeIgnored: boolean
    readonly limit: number
    readonly signal: AbortSignal
  },
): Promise<{ lines: TreeLine[]; truncated: boolean }> {
  const lines: TreeLine[] = []
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > options.depth) return
    options.signal.throwIfAborted()
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 无权限 / 竞态删除的目录不致命：跳过即可。
      return
    }
    const visible = entries
      .filter(entry => options.includeIgnored || !DEFAULT_IGNORES.has(entry.name))
      .sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1
        const bDir = b.isDirectory() ? 0 : 1
        return aDir !== bDir ? aDir - bDir : a.name.localeCompare(b.name)
      })

    for (const entry of visible) {
      if (lines.length >= options.limit) {
        truncated = true
        return
      }
      const kind: TreeLine['kind'] = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file'
      lines.push({ depth, name: entry.name, kind })
      if (kind === 'dir') await walk(join(dir, entry.name), depth + 1)
    }
  }

  await walk(root, 0)
  return { lines, truncated }
}

/** 把收集到的条目渲染成缩进的树形文本。 */
function renderTree(root: string, lines: readonly TreeLine[], truncated: boolean): string {
  const out = [`${root}`]
  for (const line of lines) {
    const indent = '  '.repeat(line.depth)
    const suffix = line.kind === 'dir' ? '/' : line.kind === 'link' ? ' ->' : ''
    out.push(`${indent}${line.name}${suffix}`)
  }
  if (truncated) out.push('… (已达到条目上限，结果被截断)')
  return out.join('\n')
}

/**
 * 挂载 Memento 自定义工具。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tree',
    description: [
      'Show a directory as an indented tree. Use it to get oriented in an unfamiliar project',
      'before reading files. Directories are listed before files; heavy directories such as',
      'node_modules and .git are skipped unless all=true.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Directory to list: absolute, or relative to the working directory. Defaults to the working directory.' },
      depth: { type: 'integer', description: `Maximum recursion depth (default ${TREE_DEFAULT_DEPTH}, max ${TREE_MAX_DEPTH}).` },
      all: { type: 'boolean', description: 'Include ignored directories such as node_modules, .git, dist.' },
      limit: { type: 'integer', description: `Maximum number of entries to print (default ${TREE_DEFAULT_LIMIT}, max ${TREE_MAX_LIMIT}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          text: { type: 'string', required: true },
          entries: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.root}</path>\n<type>tree</type>\n<content>\n${value.text}\n</content>`,
      }],
    },
    // 只读目录，可以与其他只读调用并行。
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = resolve(config.cwd)
      const requested = args.path === undefined ? base : isAbsolute(args.path) ? args.path : resolve(base, args.path)
      const depth = clamp(args.depth ?? TREE_DEFAULT_DEPTH, 1, TREE_MAX_DEPTH)
      const limit = clamp(args.limit ?? TREE_DEFAULT_LIMIT, 1, TREE_MAX_LIMIT)
      const { lines, truncated } = await collectTree(requested, {
        depth,
        includeIgnored: args.all === true,
        limit,
        signal: exec.signal,
      })
      if (lines.length === 0) {
        throw new Error(`tree: "${requested}" 不是可读目录，或目录为空`)
      }
      return {
        root: requested,
        text: renderTree(requested, lines, truncated),
        entries: lines.length,
        truncated,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fetch_url',
    description: [
      'Fetch a URL and return its body as text (HTML is returned as-is, not converted to Markdown).',
      'Use it to read online documentation or a failing endpoint. Only text/* and JSON responses are accepted.',
    ].join(' '),
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to fetch.' },
      max_chars: { type: 'integer', description: `Maximum characters to return (default ${FETCH_DEFAULT_CHARS}, max ${FETCH_MAX_CHARS}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          status: { type: 'integer', required: true },
          content_type: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<url>${value.url}</url>\n<status>${value.status} ${value.content_type}</status>\n<content>\n${value.text}\n</content>`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const target = new URL(args.url)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(`fetch_url: 只支持 http/https，收到 "${target.protocol}"`)
      }
      const cap = clamp(args.max_chars ?? FETCH_DEFAULT_CHARS, 1, FETCH_MAX_CHARS)
      // 把「调用方的取消」与「本次请求超时」合成一个信号。
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      const response = await fetch(target, {
        signal,
        redirect: 'follow',
        headers: { accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' },
      })
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
      if (!/^(text\/|application\/(json|xml|x-yaml|javascript))/.test(contentType)) {
        throw new Error(`fetch_url: 不支持的内容类型 "${contentType}"`)
      }
      const body = await response.text()
      const truncated = body.length > cap
      return {
        url: response.url,
        status: response.status,
        content_type: contentType,
        text: truncated ? `${body.slice(0, cap)}\n… (截断，原文 ${body.length} 字符)` : body,
        truncated,
      }
    },
  }))
}

/** 把数字夹在 `[min, max]` 之间（模型给的参数不可信）。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}
