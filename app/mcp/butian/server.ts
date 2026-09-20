#!/usr/bin/env node
/**
 * 补天（butian.net）MCP server —— **只读**。
 *
 * 它把补天的私有接口包装成 MCP 工具，由 YuanMy 内核里的 `@deepseek-ai/dsh-mcp-client`
 * 挂载后，模型就能像调用原生工具一样调用它们（工具名形如
 * `mcp__butian__butian_project_hall`）。
 *
 * ## 运行方式
 *
 * 标准输入输出上的 JSON-RPC（stdio 传输），由 MCP 客户端拉起：
 *
 * ```bash
 * node --experimental-strip-types app/mcp/butian/server.ts
 * ```
 *
 * 也可以单独手工验证（自己发一行 `initialize` 进去）。Node ≥ 22.19 原生剥离类型，
 * 所以这个文件**不需要构建**，和仓库里其它 TS 一致。
 *
 * ## 凭据填在哪里
 *
 * 免登录工具（项目大厅 / 排行 / 平台数字）不需要任何配置。
 * 需要登录的工具（个人中心 / 任务 / 关注列表）按顺序从两处取 Cookie：
 *
 *   1. **文件 `~/.YuanMy/butian-cookie.txt`** ← 推荐，把浏览器里 butian.net 的
 *      Cookie 整串粘进去即可（`Cookie:` 前缀和多余换行都会被自动清掉）。
 *      想放别处就用环境变量 `BUTIAN_COOKIE_FILE` 指定路径。
 *   2. 环境变量 `BUTIAN_COOKIE`。
 *
 * 没配也能启动：那些工具会返回「需要凭据」的明确提示，而不是报错崩掉。
 * 填好后用 `butian_doctor` 工具一次性看清哪些接口通了。
 *
 * ⚠️ 光有 Cookie 还不够：补天需登录的接口还要一个表单字段 `token`，它**不在 Cookie 里**，
 * 而是内联渲染在 `/WhiteHat/Center` 页面 HTML 中。{@link authToken} 负责带 Cookie 拉
 * 一次这个页面并抠出来（按 Cookie 缓存），{@link loginCall} 负责把它补进参数。
 * 详见 `client.ts` 的模块注释。
 *
 * ## 只读承诺
 *
 * 这里**故意不注册**任何改变账号状态的接口（签到 `/WhiteHat/Sign/userCheckin`、
 * 领任务 `/WhiteHat/Mission/take`、提交漏洞 `/Loo/submit` 等都不在表里）。
 * 要加写操作请先想清楚：它们会真实改变你账号的数据。
 *
 * @module YuanMy/mcp/butian/server
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { apiGet, apiPost, authToken, ButianError, site, type CallOptions } from './client.ts'

/** 这个 server 的名字：工具名会变成 `mcp__butian__<工具>`。 */
const SERVER_NAME = 'butian'
/** 版本号，`initialize` 时报给客户端。 */
const VERSION = '0.1.0'

/**
 * 自己填 Cookie 时的默认位置。
 *
 * 想放到别处（比如密码管理器挂载的目录）就用环境变量 `BUTIAN_COOKIE_FILE` 覆盖它。
 */
const COOKIE_FILE = process.env['BUTIAN_COOKIE_FILE'] ?? join(homedir(), '.YuanMy', 'butian-cookie.txt')

/**
 * 读登录 Cookie。
 *
 * 环境变量优先（内核会显式传），其次看文件。文件按「整行即 Cookie」处理 ——
 * 用户从浏览器 DevTools 复制的那串直接粘进去就行，首尾空白与 `Cookie:` 前缀都容忍。
 * @returns Cookie 串；两处都没有时返回 `undefined`。
 */
async function readCookie(): Promise<string | undefined> {
  const fromEnv = process.env['BUTIAN_COOKIE']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return normalizeCookie(fromEnv)
  try {
    const text = await readFile(COOKIE_FILE, 'utf8')
    const trimmed = normalizeCookie(text)
    return trimmed === '' ? undefined : trimmed
  } catch {
    // 文件不存在是正常状态（只用免登录工具）
    return undefined
  }
}

/** 去掉 `Cookie:` 前缀与换行（用户复制粘贴的形态很多）。 */
function normalizeCookie(raw: string): string {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => line.replace(/^cookie\s*:\s*/i, ''))
    .join('; ')
}

/** 每次调用都重新读：用户在会话中途填了凭据，不用重启 MCP。 */
async function options(): Promise<CallOptions> {
  return { cookie: await readCookie() }
}

/**
 * 取登录 Cookie；没有就抛可操作的 `no-credential`。
 *
 * 集中在这里是为了让类型收窄一次，调用方拿到的就是 `string`。
 */
function requireCookie(opts: CallOptions, tool: string): string {
  if (opts.cookie === undefined) {
    throw new ButianError('no-credential', `${tool} 需要登录后才能调用`)
  }
  return opts.cookie
}

/**
 * 调**需登录**的接口：自动补上补天要求的 `token`。
 *
 * 光有 Cookie 不够 —— 补天会回 `{status:0, info:"no token"}`。token 得从个人中心页
 * 的 HTML 里刮（见 `client.ts` 的 {@link authToken}，按 Cookie 缓存）。
 *
 * @param path - 接口路径。
 * @param method - `GET` / `POST`。
 * @param params - 业务参数；`token` 由这里补，别自己传。
 * @param cookie - 登录 Cookie（用 {@link requireCookie} 取）。
 * @param referer - 伪造的来源页。
 */
async function loginCall(
  path: string,
  method: 'GET' | 'POST',
  params: Readonly<Record<string, string | number | undefined>>,
  cookie: string,
  referer: string,
): Promise<unknown> {
  const withToken = { ...params, token: await authToken(cookie) }
  const opts: CallOptions = { cookie }
  return method === 'GET' ? apiGet(path, withToken, opts, referer) : apiPost(path, withToken, opts, referer)
}

/** 把任意数据序列化成给模型看的紧凑 JSON（控制体积，避免把上下文塞满）。 */
function toText(value: unknown, limit = 24_000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${String(text.length)} 字符）` : text
}

/** MCP 工具的标准返回：一段文本。 */
function reply(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] }
}

/**
 * 统一的错误 → 文本转换。
 *
 * MCP 工具抛异常会让模型看到一段栈；这里改成**可操作**的说明：
 * 缺凭据就说去哪填，登录过期就说重新复制 Cookie。
 */
function describe(error: unknown): string {
  if (error instanceof ButianError) {
    if (error.kind === 'no-credential') {
      return `需要登录凭据：${error.message}\n\n`
        + `配置方式（二选一）：\n`
        + `1. 写文件 ${COOKIE_FILE}（内容就是浏览器里 butian.net 的 Cookie 整串）；\n`
        + `2. 设置环境变量 BUTIAN_COOKIE 后重启 YuanMy。\n`
        + `免登录工具（项目大厅 / 排行 / 平台数字）不受影响。`
    }
    if (error.kind === 'auth') {
      return `登录态无效或已过期：${error.message}\n请重新从浏览器复制 Cookie 覆盖 `
        + `${COOKIE_FILE}（或更新 BUTIAN_COOKIE）。`
    }
    return `补天接口调用失败：${error.message}`
  }
  return `补天工具内部错误：${error instanceof Error ? error.message : String(error)}`
}

/** 包一层：把错误变成可读文本，而不是让 MCP 层抛栈。 */
async function guard(run: () => Promise<string>): Promise<{ content: { type: 'text'; text: string }[] }> {
  try {
    return reply(await run())
  } catch (error) {
    return reply(describe(error))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: SERVER_NAME, version: VERSION })

// ── 免登录：项目大厅 ────────────────────────────────────────────────────────

/**
 * 项目大厅的两种榜单。
 * 注意 `/Reward/corps` 的 `count` 字段补天自己返回 0（列表却有数据），
 * 所以这里以 `list.length` 为准，并把「本页条数」和「总数」分开报。
 */
server.registerTool('butian_project_hall', {
  title: '补天项目大厅',
  description: '浏览补天的 SRC 项目/厂商列表（免登录）。'
    + 'kind=public 是公益SRC（面向所有白帽），kind=exclusive 是专属SRC企业（有奖金区间）。'
    + '支持按名称搜索、翻页。做 SRC 选目标时先用这个。',
  inputSchema: {
    kind: z.enum(['public', 'exclusive']).default('exclusive')
      .describe('public=公益SRC（/Reward/pub），exclusive=专属SRC企业（/Reward/corps）'),
    name: z.string().optional().describe('按名称搜索（模糊匹配，可省略）'),
    page: z.number().int().min(1).default(1).describe('页码，从 1 开始'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ kind, name, page }) => guard(async () => {
  const opts = await options()
  if (kind === 'public') {
    const data = await apiPost('/Reward/pub', { name, p: page }, opts, `${site()}/Reward/plan/2`) as {
      count?: number; current?: number; list?: { company_id?: string; company_name?: string }[]
    }
    const list = data.list ?? []
    return [
      `公益SRC 项目（第 ${String(data.current ?? page)} 页，共 ${String(data.count ?? '?')} 家，本页 ${String(list.length)} 条）`,
      ...list.map((item, index) => `${String(index + 1)}. ${item.company_name ?? '?'}（id ${item.company_id ?? '?'}）`),
    ].join('\n')
  }
  const data = await apiPost('/Reward/corps', { name, p: page }, opts, `${site()}/Reward/plan/1`) as {
    count?: number; list?: {
      company_id?: string; company_name?: string; min_reward?: string; max_reward?: string
      introduce?: string; service_status?: string; service_type?: string
    }[]
  }
  const list = data.list ?? []
  const lines = list.map((item, index) => {
    const reward = item.min_reward === undefined ? '' : `｜奖金 ${item.min_reward}-${item.max_reward ?? '?'}`
    const intro = (item.introduce ?? '').slice(0, 60)
    return `${String(index + 1)}. ${item.company_name ?? '?'}（id ${item.company_id ?? '?'}）${reward}`
      + (intro === '' ? '' : `\n   ${intro}`)
  })
  return [
    `专属SRC 企业（第 ${String(page)} 页，本页 ${String(list.length)} 条；补天的 count 字段恒为 0，以本页条数为准）`,
    ...lines,
  ].join('\n')
}))

// ── 免登录：排行 ────────────────────────────────────────────────────────────

server.registerTool('butian_rank', {
  title: '补天白帽排行',
  description: '查补天的白帽 / 团队排行榜（免登录）。scope=total 是总榜，scope=month 是月榜（需要 month）。'
    + '返回值里 fight/hunter/eye 是三类榜单（战力/猎手/眼），每项含 uid、user_name、acount（积分）。',
  inputSchema: {
    scope: z.enum(['total', 'month']).default('total').describe('total=总榜，month=月榜'),
    month: z.string().optional().describe('月榜的月份，格式 2026-08（scope=month 时必填）'),
    page: z.number().int().min(1).default(1).describe('页码'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ scope, month, page }) => guard(async () => {
  const opts = await options()
  const params: Record<string, string | number | undefined> = {
    t: scope === 'month' ? 1 : 2,
    p: page,
    // 匿名访问时 token 就是空串（页面里 `var token = ""`）；登录后它会带值。
    token: '',
    ...(scope === 'month' ? { m: month } : {}),
  }
  const data = await apiPost('/Rank/monthWhiteRank', params, opts, `${site()}/Rank/whitehat`) as {
    fight?: { uid?: number; user_name?: string; acount?: string }[]
    hunter?: unknown[]; eye?: unknown[]; count?: number
  }
  const out: string[] = [`${scope === 'month' ? `月榜 ${month ?? '?'}` : '总榜'}（第 ${String(page)} 页）`]
  const sections: [string, { user_name?: string; acount?: string }[] | undefined][] = [
    ['战力榜 fight', data.fight],
    ['猎手榜 hunter', data.hunter as { user_name?: string; acount?: string }[] | undefined],
    ['眼榜 eye', data.eye as { user_name?: string; acount?: string }[] | undefined],
  ]
  for (const [title, list] of sections) {
    if (list === undefined || list.length === 0) continue
    out.push(`\n${title}（${String(list.length)} 人）`)
    list.forEach((item, index) => {
      out.push(`  ${String(index + 1)}. ${item.user_name ?? '?'}　${item.acount ?? ''}`)
    })
  }
  if (data.count !== undefined) out.push(`\n总人数 ${String(data.count)}`)
  return out.join('\n')
}))

// ── 免登录：平台总览 ────────────────────────────────────────────────────────

server.registerTool('butian_platform_stats', {
  title: '补天平台数字',
  description: '补天平台的汇总数字（免登录）：累计漏洞数、累计奖金、入驻企业数、白帽数等。'
    + '想快速了解平台规模、或做报告里的一句背景时用它。',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => guard(async () => {
  const opts = await options()
  const data = await apiPost('/Rank/getNumbers', {}, opts, `${site()}/Rank/whitehat`) as Record<string, number>
  const label: Record<string, string> = {
    loo: '累计漏洞',
    reward: '累计奖金（元）',
    company: '入驻企业',
    whitehat: '白帽专家',
    effect: '漏洞影响企业',
  }
  return Object.entries(data)
    .map(([key, value]) => `${label[key] ?? key}: ${String(value)}`)
    .join('\n')
}))

// ── 需要登录：个人空间 ──────────────────────────────────────────────────────

server.registerTool('butian_me', {
  title: '我的补天空间',
  description: '读我自己的补天个人中心数据（**需要登录 Cookie**）：积分、排名、等级、荣誉币等。'
    + '接口是 /WhiteHat/Center/spaceData。凭据没配时会提示去哪填。',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => guard(async () => {
  const cookie = requireCookie(await options(), 'butian_me')
  const data = await loginCall('/WhiteHat/Center/spaceData', 'POST', {}, cookie, `${site()}/WhiteHat/Center`)
  return `个人中心数据（原始返回）：\n${toText(data)}`
}))

server.registerTool('butian_missions', {
  title: '我的补天任务',
  description: '列出补天的任务/成就进度（**需要登录 Cookie**）。接口 /WhiteHat/Mission/lists（GET）。'
    + '只读：领取任务（/WhiteHat/Mission/take）这类写操作没有注册进这个 MCP。',
  inputSchema: {
    page: z.number().int().min(1).default(1).describe('页码'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ page }) => guard(async () => {
  const cookie = requireCookie(await options(), 'butian_missions')
  const data = await loginCall('/WhiteHat/Mission/lists', 'GET', { p: page }, cookie, `${site()}/WhiteHat/Center`)
  return `任务列表（原始返回）：\n${toText(data)}`
}))

server.registerTool('butian_my_follow', {
  title: '我关注的 SRC',
  description: '列出我在补天关注的厂商 / 项目（**需要登录 Cookie**）。接口 /WhiteHat/Follow/index。'
    + '做 SRC 时用来回顾自己跟踪的目标。',
  inputSchema: {
    page: z.number().int().min(1).default(1).describe('页码'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ page }) => guard(async () => {
  const cookie = requireCookie(await options(), 'butian_my_follow')
  const data = await loginCall('/WhiteHat/Follow/index', 'POST', { p: page }, cookie, `${site()}/WhiteHat/Center`)
  return `我关注的厂商（原始返回）：\n${toText(data)}`
}))

// ── 自检 ────────────────────────────────────────────────────────────────────

/**
 * 一次性把每个接口都打一遍，报告「通了 / 需要登录 / 失败」。
 *
 * 填好 Cookie 之后先跑这个：一次就能看清哪些接口可用、各自的返回结构长什么样，
 * 不用逐个工具试。
 */
server.registerTool('butian_doctor', {
  title: '补天连接自检',
  description: '检查补天 MCP 的连接状态：是否配置了凭据，以及每个接口是否可用、返回什么结构。'
    + '填完 Cookie 后先跑这个。',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => guard(async () => {
  const opts = await options()
  const lines: string[] = [
    `凭据：${opts.cookie === undefined ? `未配置（免登录工具可用；需要登录的工具会提示去 ${COOKIE_FILE} 填）` : `已配置（${String(opts.cookie.length)} 字符）`}`,
    '',
    '接口自检：',
  ]

  /** 逐个跑，不让一个失败打断后面的。 */
  const probes: { path: string; method: 'GET' | 'POST'; params: Record<string, string | number | undefined>; referer: string; needsLogin: boolean }[] = [
    { path: '/Rank/getNumbers', method: 'POST', params: {}, referer: `${site()}/Rank/whitehat`, needsLogin: false },
    { path: '/Reward/pub', method: 'POST', params: { p: 1 }, referer: `${site()}/Reward/plan/2`, needsLogin: false },
    { path: '/Reward/corps', method: 'POST', params: { p: 1 }, referer: `${site()}/Reward/plan/1`, needsLogin: false },
    { path: '/Rank/monthWhiteRank', method: 'POST', params: { t: 2, p: 1, token: '' }, referer: `${site()}/Rank/whitehat`, needsLogin: false },
    { path: '/WhiteHat/Center/spaceData', method: 'POST', params: {}, referer: `${site()}/WhiteHat/Center`, needsLogin: true },
    { path: '/WhiteHat/Mission/lists', method: 'GET', params: { p: 1 }, referer: `${site()}/WhiteHat/Center`, needsLogin: true },
    { path: '/WhiteHat/Follow/index', method: 'POST', params: { p: 1 }, referer: `${site()}/WhiteHat/Center`, needsLogin: true },
    { path: '/WhiteHat/Sign/continue_days', method: 'POST', params: {}, referer: `${site()}/WhiteHat/Center`, needsLogin: true },
  ]

  for (const probe of probes) {
    const label = `${probe.method} ${probe.path}${probe.needsLogin ? '（需登录）' : ''}`
    if (probe.needsLogin && opts.cookie === undefined) {
      lines.push(`  ⊘ ${label} — 未配置凭据，跳过`)
      continue
    }
    try {
      // 需登录的接口要额外带 token（由 loginCall 从个人中心页刮取并缓存）。
      const data = probe.needsLogin
        ? await loginCall(probe.path, probe.method, probe.params, requireCookie(opts, 'butian_doctor'), probe.referer)
        : probe.method === 'GET'
          ? await apiGet(probe.path, probe.params, opts, probe.referer)
          : await apiPost(probe.path, probe.params, opts, probe.referer)
      const shape = JSON.stringify(data)
      const keys = typeof data === 'object' && data !== null && !Array.isArray(data)
        ? Object.keys(data as Record<string, unknown>).join(', ')
        : Array.isArray(data) ? `数组(${String(data.length)})` : typeof data
      lines.push(`  ✓ ${label} — 字段: ${keys}`)
      lines.push(`      ${(shape ?? '').slice(0, 160)}${(shape ?? '').length > 160 ? '…' : ''}`)
    } catch (error) {
      const kind = error instanceof ButianError ? error.kind : 'unknown'
      lines.push(`  ✗ ${label} — [${kind}] ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  lines.push('', '✗ 表示该接口这次没通（凭据过期 / 接口变了）。')
  return lines.join('\n')
}))

// ─────────────────────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 连上 stdio 传输。
 *
 * ⚠️ stdio 传输下 **stdout 是协议通道**：任何 `console.log` 都会破坏 JSON-RPC 帧。
 * 需要打日志一律走 `console.error`（stderr 由客户端收走，不进协议）。
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // 启动就把「凭据配了没」说清楚：否则「需要登录的工具没反应」会让人以为是 bug。
  const configured = await readCookie() === undefined ? '未配置凭据（仅免登录工具可用）' : '已配置凭据'
  console.error(`[butian-mcp] 就绪 · 只读工具 7 个 · ${configured}`)
}

main().catch((error: unknown) => {
  console.error(`[butian-mcp] 启动失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
