#!/usr/bin/env node
/**
 * 漏洞盒子（vulbox.com）MCP server —— **只读**。
 *
 * 把漏洞盒子的私有接口包装成 MCP 工具，由 Memento 内核里的 `@deepseek-ai/dsh-mcp-client`
 * 挂载后，模型就能像调用原生工具一样调用它们（工具名形如
 * `mcp__vulbox__vulbox_projects`）。
 *
 * ## 它能回答什么问题（挖洞现场最常问的）
 *
 *   - 「漏洞盒子上有哪些企业 SRC 可以打？奖金多少？我加入了没？」→ `vulbox_projects`
 *   - 「PayPal 这个 SRC 的范围（assets）和规则是什么？」→ `vulbox_src_scope`
 *   - 「这个门户有哪些公告（评级标准 / 处理流程 / 活动）？」→ `vulbox_src_notices` / `vulbox_src_notice`
 *   - 「平台上谁在挖、分数多少？」→ `vulbox_rank` / `vulbox_src_rank`
 *   - 「提交/评级规范在哪？」→ `vulbox_help`
 *   - 「凭据通不通？」→ `vulbox_doctor`
 *
 * ## 运行方式
 *
 * stdio 上的 JSON-RPC，由 MCP 客户端拉起：
 *
 * ```bash
 * node --experimental-strip-types app/mcp/vulbox/server.ts
 * ```
 *
 * ## 凭据填在哪里
 *
 * 按顺序取：
 *   1. 环境变量 `VULBOX_COOKIE`（内核会显式转发）；
 *   2. 文件 `~/.Memento/vulbox-cookie.txt` ← 推荐：把浏览器里 vulbox.com 的 Cookie
 *      整串粘进去即可（`Cookie:` 前缀、换行都会自动清掉）。
 *      换路径用 `VULBOX_COOKIE_FILE`。
 *
 * 内容里真正用到的只有 `vulbox_token`（JWT，鉴权）和 `uuid`（请求头）。
 * 没配也能启动：需要登录的工具会给出「去哪填」的明确提示。
 *
 * ## 只读承诺
 *
 * 这里**故意不注册**任何改变账号状态的接口：加入项目（`/hacker/project/join`）、
 * 项目邀请（`/hacker/project/invitation`）、提交漏洞、意见反馈（`/web/feedback/in`）、
 * 退出登录（`/openapi/account/logout`）都不在表里。要加写操作请先想清楚：
 * 它们会真实改变你账号的数据（比如「加入项目」之后范围才可见，但那也该由人点）。
 *
 * @module Memento/mcp/vulbox/server
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  apiGet, credentialOf, DEFAULT_PORTAL, fetchPortalUser, gateway, MAIN_SITE, portalOf,
  VulboxError, type Credential,
} from './client.ts'

/** 这个 server 的名字：工具名会变成 `mcp__vulbox__<工具>`。 */
const SERVER_NAME = 'vulbox'
/** 版本号，`initialize` 时报给客户端。 */
const VERSION = '0.1.0'

/**
 * 自己填 Cookie 时的默认位置。
 *
 * 换位置用环境变量 `VULBOX_COOKIE_FILE`（冒烟测试必须用它，别读用户真实凭据）。
 */
const COOKIE_FILE = process.env['VULBOX_COOKIE_FILE'] ?? join(homedir(), '.Memento', 'vulbox-cookie.txt')

/** 读登录 Cookie：环境变量优先，其次文件。 */
async function readCookie(): Promise<string> {
  const fromEnv = process.env['VULBOX_COOKIE']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  try {
    return await readFile(COOKIE_FILE, 'utf8')
  } catch {
    return ''
  }
}

/** 每次调用都重新读：用户在会话中途填了凭据，不用重启 MCP。 */
async function credential(): Promise<Credential | undefined> {
  return credentialOf(await readCookie())
}

/** 把网页里的 HTML 片段压成一行纯文本（公告 / 规则的 content 是富文本）。 */
function plain(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 把任意数据序列化成给模型看的紧凑 JSON（控制体积）。 */
function toText(value: unknown, limit = 20_000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${String(text.length)} 字符）` : text
}

/** MCP 工具的标准返回。 */
function reply(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] }
}

/**
 * 统一的错误 → 文本转换。
 *
 * 四条不同的出路，别混成一句「调用失败」：
 *   - 没凭据 → 去哪填；
 *   - 凭据无效 → 重新复制 Cookie；
 *   - **暂无权限** → 去门户点「加入项目」（企业 SRC 的范围与公告详情都要先加入）；
 *   - 其余业务失败 → 原样报出来。
 */
function describe(error: unknown): string {
  if (error instanceof VulboxError) {
    if (error.kind === 'no-credential') {
      return `需要登录凭据：${error.message}\n\n`
        + `配置方式（二选一）：\n`
        + `1. 写文件 ${COOKIE_FILE}（内容就是浏览器里 vulbox.com 的 Cookie 整串）；\n`
        + `2. 设置环境变量 VULBOX_COOKIE 后重启 Memento。\n`
        + `免登录也能用的工具：vulbox_projects / vulbox_rank / vulbox_platform_stats / vulbox_help。`
    }
    if (error.kind === 'auth') {
      return `登录态无效或已过期：${error.message}\n`
        + `请重新登录 vulbox.com 后复制 Cookie 覆盖 ${COOKIE_FILE}（或更新 VULBOX_COOKIE）。`
    }
    if (error.kind === 'forbidden') {
      return `登录态没问题，但**没有这个 SRC 项目的权限**：${error.message}\n`
        + `企业 SRC 的资产范围（assets）与公告详情都要求先加入项目：\n`
        + `  用浏览器打开对应门户（如 https://${DEFAULT_PORTAL}），点「加入项目」后再试。\n`
        + `（未加入时 assets.accessible = 4 且 content 为空串，这是接口的设计，不是解析问题。）`
    }
    return `漏洞盒子接口调用失败：${error.message}`
  }
  return `漏洞盒子工具内部错误：${error instanceof Error ? error.message : String(error)}`
}

/** 包一层：把错误变成可读文本，而不是让 MCP 层抛栈。 */
async function guard(run: () => Promise<string>): Promise<{ content: { type: 'text'; text: string }[] }> {
  try {
    return reply(await run())
  } catch (error) {
    return reply(describe(error))
  }
}

/**
 * `assets.accessible` 的语义 —— 摘自门户前端自己的提示文案（`f53acb0.js`）。
 *
 * 这张表比「暂无权限」四个字有用得多：模型据此能直接告诉用户**该做哪一步**
 * （去认证 / 联系管理员 / 换项目），而不是反复重配 Cookie。
 */
const ACCESSIBLE_HINT: Record<number, string> = {
  0: '有权限（接口会直接返回资产范围）',
  1: '门户文案「完成认证加入项目后再查看哦~」→ 去完成实名认证并加入项目',
  2: '门户文案「内测SRC，联系管理员后加入~」→ 这类项目要联系管理员才能加入',
  3: '门户文案「抱歉，您未取得资产查看权限～」→ 账号没有该项目的资产权限',
  4: '未加入该项目（实测：未加入时就是 4，门户前端未处理这个值，页面会空一块）',
}

/** 门户参数的公共定义（各 SRC 工具共用）。 */
const portalArg = z.string().optional()
  .describe(`SRC 门户域名，如 ${DEFAULT_PORTAL}（默认就是它）。可从 vulbox_projects 的「门户」列拿。`)

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: SERVER_NAME, version: VERSION })

// ── 企业 SRC 大厅（免登录）──────────────────────────────────────────────────

server.registerTool('vulbox_projects', {
  title: '漏洞盒子企业SRC大厅',
  description: '列出漏洞盒子上的企业 SRC 项目（免登录）：项目 id、名称、奖金区间、结束时间、'
    + '门户域名、是否已加入（hacker_joined_exists）、是否还能提交漏洞。'
    + '**选目标先看这个** —— 奖金高、没结束、允许提交的项目才是能打的。',
  inputSchema: {
    page: z.number().int().min(1).default(1).describe('页码，从 1 开始'),
    page_size: z.number().int().min(1).max(50).default(20).describe('每页条数'),
    keyword: z.string().optional().describe('按名称过滤（本地过滤，接口不支持搜索）'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ page, page_size, keyword }) => guard(async () => {
  const data = await apiGet(MAIN_SITE, '/web/project/enterprise/src', { page, page_size }) as {
    current_page?: number; total?: number; data?: Record<string, unknown>[]
  }
  const all = data.data ?? []
  const key = (keyword ?? '').trim().toLowerCase()
  const list = key === '' ? all : all.filter((row) => String(row['task_title'] ?? '').toLowerCase().includes(key))
  const lines = list.map((row, index) => {
    const joined = row['hacker_joined_exists'] === true ? '已加入' : '未加入'
    const submit = row['src_cant_submit_vul'] === true ? '× 不可提交' : '✓ 可提交'
    return `${String(index + 1)}. [${String(row['id'] ?? '?')}] ${String(row['task_title'] ?? '?')}\n`
      + `   奖金 ${String(row['reward_range'] ?? '?')} 元｜难度 ${String(row['difficulty_name'] ?? '?')}`
      + `｜截止 ${String(row['task_etime'] ?? '?').slice(0, 10)}\n`
      + `   门户 ${String(row['src_url'] ?? '?')}｜${joined}｜${submit}`
  })
  return [
    `企业 SRC（第 ${String(data.current_page ?? page)} 页 / 共 ${String(data.total ?? '?')} 个项目`
      + `，本页 ${String(all.length)} 条${key === '' ? '' : `，过滤后 ${String(list.length)} 条`}）`,
    ...lines,
    '',
    '看某个项目的范围与规则：vulbox_src_scope（门户参数用上面的「门户」列）',
  ].join('\n')
}))

server.registerTool('vulbox_platform_stats', {
  title: '漏洞盒子平台数字',
  description: '漏洞盒子的累计数字（免登录）：累计漏洞数、白帽数、入驻企业数。做报告背景或了解平台规模时用。',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => guard(async () => {
  const data = await apiGet(MAIN_SITE, '/web/project/application/info', {}) as Record<string, number>
  const label: Record<string, string> = { all_vul: '累计漏洞', all_user: '白帽用户', all_enterprise: '入驻企业' }
  return Object.entries(data).map(([key, value]) => `${label[key] ?? key}: ${String(value)}`).join('\n')
}))

server.registerTool('vulbox_rank', {
  title: '漏洞盒子总榜',
  description: '漏洞盒子主站的赛季排行榜（免登录）：名次、昵称、战队、分数、段位。'
    + '看某个 SRC 项目内部的榜用 vulbox_src_rank。',
  inputSchema: {
    page: z.number().int().min(1).default(1).describe('页码'),
    page_size: z.number().int().min(1).max(50).default(20).describe('每页条数'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ page, page_size }) => guard(async () => {
  const data = await apiGet(MAIN_SITE, '/web/index/ranking', { page, page_size }) as {
    start?: string; list?: Record<string, unknown>[]
  }
  const list = data.list ?? []
  const lines = list.map((row, index) => {
    const rank = (page - 1) * page_size + index + 1
    const team = String(row['team_name'] ?? '') === '' ? '' : `｜战队 ${String(row['team_name'])}`
    const mine = row['is_mine'] === true ? ' ← 你' : ''
    return `${String(rank)}. ${String(row['user_name'] ?? '?')}　${String(row['score'] ?? '?')} 分`
      + `｜${String(row['dan'] ?? '?')}${team}${mine}`
  })
  return [`赛季榜（统计起点 ${String(data.start ?? '?')}，本页 ${String(list.length)} 人）`, ...lines].join('\n')
}))

// ── SRC 门户（只读；范围/规则需要先加入项目）─────────────────────────────────

server.registerTool('vulbox_src_info', {
  title: 'SRC 门户概况',
  description: '读一个 SRC 门户的概况：项目 id、名称、简介、官网、以及这个门户开了哪些模块'
    + '（排行榜 / 赏金榜 / 漏洞动态）。用它确认门户域名对不对、有哪些板块可看。',
  inputSchema: { portal: portalArg },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ portal }) => guard(async () => {
  const host = portalOf(portal ?? DEFAULT_PORTAL)
  const cred = await credential()
  const data = await apiGet(host, '/web/src/basic-info', {}, cred) as {
    info?: Record<string, unknown>; config?: Record<string, unknown>
  }
  const info = data.info ?? {}
  const config = data.config ?? {}
  const flag = (key: string): string => (Number(config[key]) === 1 ? '开' : '关')
  return [
    `${String(info['title'] ?? '?')}（门户 ${host}，项目 id ${String(info['project_id'] ?? '?')}）`,
    `简介：${plain(String(info['description'] ?? ''))}`,
    `官网：${String(info['official_site'] ?? '?')}｜联系邮箱：${String(info['official_email'] ?? '（未公开）')}`,
    '',
    `模块开关：白帽排行 ${flag('show_user_rank')}｜战队排行 ${flag('show_team_rank')}`
      + `｜赏金榜 ${flag('show_bounties')}｜漏洞动态 ${flag('show_vuln_moment')}`,
  ].join('\n')
}))

server.registerTool('vulbox_src_scope', {
  title: 'SRC 资产范围与规则',
  description: '读一个 SRC 门户的**测试范围**：奖金档位（严重/高/中/低）、项目说明、'
    + '测试规则 rules、资产列表 assets.content。**挖洞前必看**。'
    + '若返回「范围为空」通常是还没加入该项目（接口只对成员开放），按提示去门户点加入。',
  inputSchema: { portal: portalArg },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ portal }) => guard(async () => {
  const host = portalOf(portal ?? DEFAULT_PORTAL)
  const cred = await credential()
  const data = await apiGet(host, '/web/src/project/profile', {}, cred) as {
    bounties?: Record<string, string>
    description?: string
    rules?: string
    assets?: { content?: string; accessible?: number }
    validation?: Record<string, boolean>
  }
  const b = data.bounties ?? {}
  const range = (level: string, name: string): string => {
    const min = b[`${level}_min`]
    const max = b[`${level}_max`]
    if (min === undefined && max === undefined) return ''
    return `${name} ${String(min ?? '?')} ~ ${String(max ?? '?')} 元`
  }
  const rewards = [
    range('serious', '严重'), range('high', '高危'), range('middle', '中危'), range('low', '低危'),
  ].filter((line) => line !== '')
  const assets = plain(String(data.assets?.content ?? ''))
  const rules = plain(String(data.rules ?? ''))
  const out: string[] = [
    `${host} 的测试范围（项目 id 见 vulbox_src_info）`,
    '',
    '## 奖金档位',
    ...(rewards.length === 0 ? ['（接口没返回奖金档位）'] : rewards),
    '',
    '## 项目说明',
    plain(String(data.description ?? '')) || '（空）',
  ]
  if (rules !== '') {
    out.push('', '## 测试规则', rules)
  }
  if (assets !== '') {
    out.push('', '## 资产范围', assets)
  } else {
    const accessible = Number(data.assets?.accessible ?? -1)
    out.push(
      '',
      '## 资产范围',
      `⚠️ 接口返回的资产范围是空的（assets.accessible = ${String(data.assets?.accessible ?? '?')}）。`,
      `语义：${ACCESSIBLE_HINT[accessible] ?? '（门户前端没有这个取值，可能是新状态）'}`,
      '企业 SRC 的资产范围与公告详情只对项目成员开放，这是接口的设计而不是解析问题。',
      `下一步：浏览器打开 https://${host} 按门户提示操作（认证 / 加入 / 联系管理员），然后再调一次本工具。`,
    )
  }
  return out.join('\n')
}))

server.registerTool('vulbox_src_notices', {
  title: 'SRC 公告列表',
  description: '列出一个 SRC 门户的公告（评级标准、处理流程、活动、奖励发放等）。'
    + '公告标题里常有关键规则线索，看到感兴趣的点 vulbox_src_notice 读全文。',
  inputSchema: {
    portal: portalArg,
    page: z.number().int().min(1).default(1).describe('页码'),
    page_size: z.number().int().min(5).max(50).default(20)
      .describe('每页条数（接口要求必填，且不得小于 5）'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ portal, page, page_size }) => guard(async () => {
  const host = portalOf(portal ?? DEFAULT_PORTAL)
  const cred = await credential()
  const data = await apiGet(host, '/web/src/project/notices', { page, page_size }, cred) as {
    current_page?: number; total?: number; data?: Record<string, unknown>[]
  }
  const list = data.data ?? []
  const kind: Record<number, string> = { 1: '活动', 2: '公告', 3: '规则' }
  const lines = list.map((row, index) => {
    const top = row['top'] === 1 ? '📌 ' : ''
    return `${String(index + 1)}. ${top}[${String(row['id'] ?? '?')}] ${String(row['title'] ?? '?')}`
      + `　${kind[Number(row['type'])] ?? `type=${String(row['type'])}`}｜${String(row['created_at'] ?? '')}`
  })
  return [
    `${host} 的公告（第 ${String(data.current_page ?? page)} 页，共 ${String(data.total ?? '?')} 条）`,
    ...lines,
    '',
    '读全文：vulbox_src_notice（portal + id）。注意公告详情要**先加入项目**才给看。',
  ].join('\n')
}))

server.registerTool('vulbox_src_notice', {
  title: 'SRC 公告详情',
  description: '读一条公告的全文（评级标准 / 处理流程 / 活动规则都在这）。'
    + '返回「暂无权限」表示还没加入该项目 —— 这是接口的权限设计，不是参数写错。',
  inputSchema: {
    id: z.number().int().min(1).describe('公告 id（从 vulbox_src_notices 拿）'),
    portal: portalArg,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ id, portal }) => guard(async () => {
  const host = portalOf(portal ?? DEFAULT_PORTAL)
  const cred = await credential()
  const data = await apiGet(host, `/web/src/project/notice/${String(id)}`, {}, cred) as Record<string, unknown>
  return [
    `${String(data['title'] ?? `公告 ${String(id)}`)}`,
    `发布 ${String(data['created_at'] ?? '?')}${data['updated_at'] === undefined ? '' : `｜更新 ${String(data['updated_at'])}`}`,
    '',
    plain(String(data['content'] ?? '')) || toText(data),
  ].join('\n')
}))

server.registerTool('vulbox_src_rank', {
  title: 'SRC 门户排行榜',
  description: '读一个 SRC 门户自己的排行榜（白帽榜 / 战队榜）。'
    + '看这个项目上有没有人在挖、谁挖得多，据此判断项目活跃度。',
  inputSchema: {
    portal: portalArg,
    kind: z.enum(['user', 'team']).default('user').describe('user=白帽榜，team=战队榜'),
    page: z.number().int().min(1).default(1).describe('页码'),
    page_size: z.number().int().min(1).max(50).default(20).describe('每页条数'),
    period: z.string().optional().describe('周期，如 month（门户 config 里的 show_rank_periods 决定）'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ portal, kind, page, page_size, period }) => guard(async () => {
  const host = portalOf(portal ?? DEFAULT_PORTAL)
  const cred = await credential()
  const data = await apiGet(host, `/web/src/rank/${kind}`, { page, page_size, period }, cred) as Record<string, unknown>
  if (Number(data['enable']) !== 1) {
    return `${host} 的${kind === 'user' ? '白帽' : '战队'}榜没有开启（接口返回 enable=false）。`
  }
  if (kind === 'team') {
    const list = (data['list'] ?? []) as Record<string, unknown>[]
    const lines = list.map((row, index) => `${String(index + 1)}. ${String(row['team_name'] ?? row['name'] ?? '?')}`
      + `　${String(row['score'] ?? row['total'] ?? '')}`)
    return [`${host} 战队榜（排序 ${String(data['sort'] ?? '?')}，本页 ${String(list.length)} 支）`, ...lines].join('\n')
  }
  const list = (data['data'] ?? []) as Record<string, unknown>[]
  const lines = list.map((row, index) => {
    const mine = row['is_self'] === true ? ' ← 你' : ''
    return `${String(index + 1)}. ${String(row['username'] ?? '?')}　${String(row['total'] ?? '')} 分${mine}`
  })
  return [
    `${host} 白帽榜（排序 ${String(data['sort'] ?? '?')}，第 ${String(data['current_page'] ?? page)} 页`
      + ` / 共 ${String(data['total'] ?? '?')} 人）`,
    ...lines,
  ].join('\n')
}))

server.registerTool('vulbox_src_vulns', {
  title: 'SRC 漏洞动态 / 赏金榜',
  description: '读一个 SRC 门户公开的漏洞动态与赏金榜（很多门户没开这两个板块，会明确告诉你 enable=false）。'
    + '开了的门户能看到最近公开的漏洞标题与奖励，是了解「这个项目什么漏洞收、给多少钱」的好材料。',
  inputSchema: { portal: portalArg },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ portal }) => guard(async () => {
  const host = portalOf(portal ?? DEFAULT_PORTAL)
  const cred = await credential()
  const [moments, bounties] = await Promise.all([
    apiGet(host, '/web/src/vuln/moments', {}, cred).catch((error: unknown) => ({ error })),
    apiGet(host, '/web/src/vuln/bounties', {}, cred).catch((error: unknown) => ({ error })),
  ]) as [Record<string, unknown>, Record<string, unknown>]
  const out: string[] = [`${host} 的公开漏洞信息`]
  const section = (title: string, data: Record<string, unknown>): void => {
    if ('error' in data) {
      out.push('', `## ${title}`, `读取失败：${data['error'] instanceof Error ? data['error'].message : String(data['error'])}`)
      return
    }
    if (Number(data['enable']) !== 1) {
      out.push('', `## ${title}`, '该门户没有开启这个板块（enable=false）。')
      return
    }
    out.push('', `## ${title}`, toText(data))
  }
  section('漏洞动态 moments', moments)
  section('赏金榜 bounties', bounties)
  return out.join('\n')
}))

// ── 我是谁（读主站 SSR，用 Cookie）───────────────────────────────────────────

server.registerTool('vulbox_me', {
  title: '我的漏洞盒子账号',
  description: '读当前凭据对应的账号：登录态、用户名/uid、**实名与手机打码**、等级与经验、站内信数量。'
    + '两个用途：① 检查 Cookie 是否还有效（网关那两个账号接口恒回 logged:false，不可信，'
    + '这里读的是主站 SSR 渲染出来的真实登录态）；② 加入 SRC 项目前自查。',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => guard(async () => {
  const raw = await readCookie()
  if (raw.trim() === '') {
    throw new VulboxError('no-credential', 'vulbox_me 需要 Cookie')
  }
  const user = await fetchPortalUser(raw)
  if (!user.logged) {
    throw new VulboxError('auth', '主站 SSR 判定未登录（Cookie 里没有有效的 vulbox_token）')
  }
  return [
    `账号：${user.username}（uid ${String(user.uid ?? '?')}）`,
    `实名：${user.realName === '' ? '未实名' : `${user.realName}（已实名）`}`
      + `｜手机：${user.mobile === '' ? '未绑定' : `${user.mobile}（已绑定）`}`,
    `等级：${user.level === '' ? '?' : user.level}`
      + (user.expCurrent === null ? '' : `（经验 ${String(user.expCurrent)}/${String(user.expTotal ?? '?')}）`)
      + `｜赛季第 ${String(user.season ?? '?')} 季｜站内信 ${String(user.messageCount ?? '?')} 条`,
    '',
    '加入企业 SRC 项目要过四项检查（门户弹窗里的「微信 / 实名 / 手机 / 签署SRC项目参与协议」）：',
    `  · 实名：${user.realName === '' ? '❌ 未实名' : '✅ 已实名'}`,
    `  · 手机：${user.mobile === '' ? '❌ 未绑定' : '✅ 已绑定'}`,
    '  · 微信绑定 / 协议签署：这两项只有用户中心那个后端知道，而它不认这套 token'
      + '（回 Receive a wrong Token）——在浏览器门户点「加入项目」时弹窗会逐项标 已认证/未认证。',
  ].join('\n')
}))

// ── 帮助中心（免登录）───────────────────────────────────────────────────────

server.registerTool('vulbox_help', {
  title: '漏洞盒子帮助中心',
  description: '帮助中心的目录、文章全文与搜索：注册/实名认证、漏洞提交规范、评级标准、'
    + '奖励与提现规则都在这里。写报告前拿它对齐平台口径。'
    + '三种用法：不传参数=目录；传 id=读全文；传 search=搜索。',
  inputSchema: {
    id: z.number().int().min(1).optional().describe('文章 id（读全文）'),
    search: z.string().optional().describe('关键词搜索（与 id 二选一）'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ id, search }) => guard(async () => {
  if (id !== undefined) {
    const data = await apiGet(MAIN_SITE, '/web/help-center/article', { id }) as Record<string, unknown>
    return [`${String(data['title'] ?? `文章 ${String(id)}`)}（${String(data['updated_at'] ?? '?')} 更新）`, '',
      plain(String(data['content'] ?? ''))].join('\n')
  }
  if (search !== undefined && search.trim() !== '') {
    const data = await apiGet(MAIN_SITE, '/web/help-center/articles/search', { search }) as unknown
    return `搜索「${search}」的结果：\n${toText(data)}`
  }
  const data = await apiGet(MAIN_SITE, '/web/help-center/articles', {}) as Record<string, unknown>[]
  const walk = (nodes: Record<string, unknown>[], depth: number): string[] => nodes.flatMap((node) => [
    `${'  '.repeat(depth)}- [${String(node['id'] ?? '?')}] ${String(node['title'] ?? '?')}`,
    ...walk((node['children'] ?? []) as Record<string, unknown>[], depth + 1),
  ])
  return ['帮助中心目录（用 vulbox_help id=<编号> 读全文）', ...walk(Array.isArray(data) ? data : [], 0)].join('\n')
}))

// ── 自检 ────────────────────────────────────────────────────────────────────

server.registerTool('vulbox_doctor', {
  title: '漏洞盒子连接自检',
  description: '检查漏洞盒子 MCP 的连接状态：凭据配了没、每个接口通不通、返回什么结构。'
    + '任何工具报「需要登录 / 暂无权限」时先跑这个，一次看清问题在哪一层。',
  inputSchema: { portal: portalArg },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ portal }) => guard(async () => {
  const host = portalOf(portal ?? DEFAULT_PORTAL)
  const cred = await credential()
  const lines: string[] = [
    `网关：${gateway()}`,
    `门户：${host}（可用 VULBOX_PORTAL 改默认值）`,
    `凭据：${cred === undefined
      ? `未配置（免登录工具可用；需要登录的会提示去 ${COOKIE_FILE} 填）`
      : `已配置（token ${String(cred.token.length)} 字符、uuid ${String(cred.uuid.length)} 字符）`}`,
    '',
    '接口自检：',
  ]
  const probes: { portal: string; path: string; need: string; login: boolean }[] = [
    { portal: MAIN_SITE, path: '/web/project/enterprise/src?page=1&page_size=1', need: '企业SRC大厅', login: false },
    { portal: MAIN_SITE, path: '/web/project/application/info', need: '平台数字', login: false },
    { portal: MAIN_SITE, path: '/web/index/ranking?page=1&page_size=1', need: '总榜', login: false },
    { portal: MAIN_SITE, path: '/web/help-center/articles', need: '帮助中心目录', login: false },
    { portal: host, path: '/web/src/basic-info', need: '门户概况', login: false },
    { portal: host, path: '/web/src/project/profile', need: '范围与规则', login: true },
    { portal: host, path: '/web/src/project/notices?page=1&page_size=5', need: '公告列表', login: false },
    { portal: host, path: '/web/src/rank/user?page=1&page_size=5', need: '门户白帽榜', login: false },
  ]
  for (const probe of probes) {
    const label = `${probe.need}（${probe.portal}${probe.path.split('?')[0] ?? ''}）`
    try {
      const data = await apiGet(probe.portal, probe.path.split('?')[0] ?? probe.path,
        Object.fromEntries(new URLSearchParams(probe.path.split('?')[1] ?? '')), cred)
      const text = JSON.stringify(data)
      const keys = typeof data === 'object' && data !== null && !Array.isArray(data)
        ? Object.keys(data as Record<string, unknown>).join(', ')
        : Array.isArray(data) ? `数组(${String(data.length)})` : typeof data
      lines.push(`  ✓ ${label} — 字段: ${keys}`)
      lines.push(`      ${text.slice(0, 150)}${text.length > 150 ? '…' : ''}`)
    } catch (error) {
      const kind = error instanceof VulboxError ? error.kind : 'unknown'
      lines.push(`  ✗ ${label} — [${kind}] ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // SSR 那一路单独探：它是唯一能证明「Cookie 还有效」的路径
  try {
    const user = await fetchPortalUser(await readCookie())
    lines.push(user.logged
      ? `  ✓ 主站 SSR 账号（Cookie）— ${user.username} / uid ${String(user.uid ?? '?')} / 实名 ${user.realName || '未实名'}`
      : '  ✗ 主站 SSR 账号（Cookie）— 未登录：Cookie 里没有有效的 vulbox_token')
  } catch (error) {
    lines.push(`  ✗ 主站 SSR 账号（Cookie）— ${error instanceof Error ? error.message : String(error)}`)
  }
  lines.push('', '注：只读工具不会改动账号；「加入项目」「提交漏洞」这类写操作没有注册。')
  return lines.join('\n')
}))

// ─────────────────────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 连上 stdio 传输。
 *
 * ⚠️ stdio 下 **stdout 是协议通道**：任何 `console.log` 都会破坏 JSON-RPC 帧，
 * 日志一律走 `console.error`。
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const configured = await credential() === undefined ? '未配置凭据（仅免登录工具可用）' : '已配置凭据'
  console.error(`[vulbox-mcp] 就绪 · ${configured} · 门户 ${DEFAULT_PORTAL}`)
}

main().catch((error: unknown) => {
  console.error(`[vulbox-mcp] 启动失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
