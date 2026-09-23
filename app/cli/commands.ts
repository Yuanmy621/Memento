/**
 * 用户命令（`/命令`）：把「一句话 + 一段指令」做成可复用的入口。
 *
 * 命令由用户敲 `/名字` 触发，放在 `.agents/commands/<名字>.md`；与 skill 的区别是
 * 只在触发的那一回合注入正文，不常驻会话目录。`include` 里的路径相对命令文件所在
 * 目录解析，内联时会剥掉 frontmatter。
 *
 * @module Memento/cli/commands
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/** 一条命令。 */
export interface CommandDef {
  /** 命令名（敲 `/名字` 用的那个）。 */
  readonly name: string
  /** 一句话说明。 */
  readonly description: string
  /** 参数提示（纯展示）。 */
  readonly argsHint: string
  /** 要内联的文件（相对命令目录，已解析成绝对路径）。 */
  readonly includes: readonly string[]
  /** 命令正文（frontmatter 之后的部分）。 */
  readonly body: string
  /** 命令文件绝对路径。 */
  readonly path: string
  /** 命令文件所在目录（`include` 相对它解析）。 */
  readonly dir: string
  /** 来自哪个根：项目 / 用户级 / 环境变量追加。 */
  readonly scope: 'project' | 'user' | 'extra'
}

/** 一个命令根的用途标记。 */
interface CommandRoot {
  readonly dir: string
  readonly scope: CommandDef['scope']
}

/**
 * 要扫描的命令目录，项目里的排在前面；同名命令以先找到的为准。
 */
export function commandRoots(cwd: string): CommandRoot[] {
  const roots: CommandRoot[] = [
    { dir: join(cwd, '.agents', 'commands'), scope: 'project' },
    { dir: join(cwd, '.dsh', 'commands'), scope: 'project' },
  ]
  const extra = process.env.Memento_COMMAND_DIRS?.trim()
  if (extra !== undefined && extra !== '') {
    for (const part of extra.split(':')) {
      const dir = part.trim()
      if (dir !== '') roots.push({ dir, scope: 'extra' })
    }
  }
  return roots
}

/**
 * 切出 frontmatter 与正文；只认 `key: value` 与 `key:` 后跟 `- item` 的列表形态，
 * 为此引一个 YAML 依赖不值得。
 */
function splitFrontmatter(text: string): {
  fields: Map<string, string>
  listFields: Map<string, string[]>
  body: string
} {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { fields: new Map(), listFields: new Map(), body: text }
  const fields = new Map<string, string>()
  const listFields = new Map<string, string[]>()
  let index = 1
  let currentList: string | null = null
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '---') break
    // 列表项（`  - value`）归到上一个 `key:` 名下
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && currentList !== null) {
      listFields.get(currentList)?.push(stripQuotes((item[1] ?? '').trim()))
      continue
    }
    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (pair === null) continue
    const key = pair[1] ?? ''
    const rawValue = pair[2] ?? ''
    const value = rawValue.trim()
    if (value === '') {
      // `key:` 后面可能跟列表
      currentList = key
      if (!listFields.has(key)) listFields.set(key, [])
      continue
    }
    currentList = null
    fields.set(key, stripQuotes(value))
  }
  return { fields, listFields, body: lines.slice(index + 1).join('\n').replace(/^\n+/, '') }
}

/** 去掉成对引号。 */
function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  // 列表形态 `[a, b]`
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).trim()
  }
  return value
}

/** 取 `include` 字段（支持 `include: a`、`include: [a, b]`、`include:` + `- a`）。 */
function includesOf(fields: Map<string, string>, listFields: Map<string, string[]>): string[] {
  const list = listFields.get('include')
  if (list !== undefined && list.length > 0) return list
  const inline = fields.get('include')
  if (inline === undefined || inline === '') return []
  return inline.split(',').map(part => part.trim()).filter(part => part !== '')
}

/** 读一个命令文件；单个文件坏掉时返回 `undefined`，避免整张表消失。 */
async function readCommand(path: string, scope: CommandDef['scope']): Promise<CommandDef | undefined> {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const { fields, listFields, body } = splitFrontmatter(text)
  const name = fields.get('name') ?? basename(path).replace(/\.md$/, '')
  const dir = dirname(path)
  return {
    name,
    description: fields.get('description') ?? '',
    argsHint: fields.get('args') ?? '',
    includes: includesOf(fields, listFields).map(rel => resolve(dir, rel)),
    body,
    path,
    dir,
    scope,
  }
}

/** 列出所有可用命令（同名时项目优先）。 */
export async function listCommands(cwd: string): Promise<CommandDef[]> {
  const found = new Map<string, CommandDef>()
  for (const root of commandRoots(cwd)) {
    if (!existsSync(root.dir)) continue
    let entries
    try {
      entries = await readdir(root.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // 只认顶层 `.md`：命令自带的资产放进同名子目录（如 `report/`），不当作命令
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      if (entry.name.startsWith('.')) continue
      const def = await readCommand(join(root.dir, entry.name), root.scope)
      if (def === undefined) continue
      if (!found.has(def.name)) found.set(def.name, def)
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 内联一个文件，剥掉 frontmatter。 */
async function readIncluded(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined
    const text = await readFile(path, 'utf8')
    // SKILL.md 的 frontmatter 是给 provider 看的，给模型只会白占 token
    const { body } = splitFrontmatter(text)
    return body.trim() === '' ? text : body
  } catch {
    return undefined
  }
}

/** 一次展开的结果。 */
export interface ExpandedCommand {
  /** 展开后要发给 agent 的文本。 */
  readonly text: string
  /** `include` 里读不到的文件（不致命，但要如实告知）。 */
  readonly missing: readonly string[]
}

/**
 * 把 `/名字 参数…` 展开成一段可直接当用户消息发出的文本，段落顺序为命令正文 →
 * 内联文件 → 本次输入（指令在前、素材居中、具体要求最后）。
 */
export async function expandCommand(def: CommandDef, argsText: string): Promise<ExpandedCommand> {
  const parts = [def.body.trim()]
  const missing: string[] = []
  for (const path of def.includes) {
    const content = await readIncluded(path)
    if (content === undefined) {
      missing.push(path)
      continue
    }
    parts.push(`===== 内联：${path} =====\n\n${content.trim()}`)
  }
  const args = argsText.trim()
  parts.push(`===== 本次输入 =====\n\n${args === '' ? '（没有额外输入，按上面的指令执行）' : args}`)
  return { text: parts.filter(part => part !== '').join('\n\n'), missing }
}

/**
 * 判断一段输入是不是命令并切出名字与参数；只认整行以 `/` 开头的输入，
 * `${}` 之类的内容不会被误判。
 */
export function matchCommand(
  input: string,
  commands: readonly CommandDef[],
): { def: CommandDef; args: string } | undefined {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return undefined
  const space = trimmed.search(/\s/)
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase()
  const args = space === -1 ? '' : trimmed.slice(space + 1)
  const def = commands.find(command => command.name.toLowerCase() === name)
  return def === undefined ? undefined : { def, args }
}
