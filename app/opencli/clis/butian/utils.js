/**
 * 补天（butian.net）适配器的共享层：凭据、页面 token、envelope 解包。
 *
 * ## 为什么是 Node 侧 fetch，而不是驱动浏览器
 *
 * 补天的个人中心是「服务端渲染页面 + 站内 POST 接口」的老式结构：
 * 接口路径、参数、envelope 都已经从页面自身的内联脚本里读出来了，用 `fetch`
 * 就能拿到数据。所以这些命令都是 `browser: false` —— **不需要 opencli 的
 * Chrome 扩展**（`opencli doctor` 里那项 Extension 没连上也能用）。
 *
 * 代价只有一个：Cookie 要自己提供（见 {@link readCookie}）。
 *
 * ## 三个必须遵守的约定（缺一个就拿不到数据）
 *
 * | 约定 | 依据 |
 * | --- | --- |
 * | `POST` 要带 `ajax=1` + `x-www-form-urlencoded` | 站点自己的 axios 封装就是这么发的 |
 * | 成功判定 `status === 1 \|\| success === 1` | 业务失败也返回 HTTP 200，必须看 envelope |
 * | 个人中心接口要带 **页面 token** | 少了它返回 `{"status":0,"info":"no token"}` |
 *
 * ⚠️ token 是**每页一个**、嵌在该页 HTML 里的（形如 `token: "40位hex"`），
 * 所以 {@link pageToken} 要按页取并缓存 —— 拿 A 页的 token 去调 B 页的接口同样会
 * `no token`。
 *
 * @module Memento/opencli/clis/butian/utils
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors'

/** 站点域名（写进 adapter 的 `domain` 字段，opencli 用它做站点归类）。 */
export const DOMAIN = 'www.butian.net'
/** 站点根地址。 */
export const ORIGIN = `https://${DOMAIN}`

/**
 * 凭据文件位置 —— 与 Memento 里的补天 MCP 共用同一份。
 *
 * 填一次两边都能用：`~/.Memento/butian-cookie.txt` 里放浏览器里 butian.net 的
 * Cookie 整串（`Cookie:` 前缀、换行都会被自动清掉）。
 * 想放别处用 `BUTIAN_COOKIE_FILE`，或直接用环境变量 `BUTIAN_COOKIE`。
 */
const COOKIE_FILE = process.env.BUTIAN_COOKIE_FILE ?? join(homedir(), '.Memento', 'butian-cookie.txt')

/** 去掉 `Cookie:` 前缀与换行，拼成一行。 */
function normalizeCookie(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/^cookie\s*:\s*/i, ''))
    .join('; ')
}

/**
 * 读登录 Cookie。
 * @returns {Promise<string>} Cookie 串。
 * @throws {AuthRequiredError} 两处都没有（或为空）时，提示去哪填。
 */
export async function readCookie() {
  const fromEnv = process.env.BUTIAN_COOKIE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return normalizeCookie(fromEnv)
  let raw
  try {
    raw = await readFile(COOKIE_FILE, 'utf8')
  } catch {
    throw new AuthRequiredError(
      DOMAIN,
      `没有找到补天凭据。把浏览器里 butian.net 的 Cookie 写进 ${COOKIE_FILE}`
      + `（或设置环境变量 BUTIAN_COOKIE），再跑一次。`,
    )
  }
  const cookie = normalizeCookie(raw)
  if (cookie === '') {
    throw new AuthRequiredError(DOMAIN, `${COOKIE_FILE} 是空的：把浏览器里 butian.net 的 Cookie 粘进去即可。`)
  }
  return cookie
}

/** 页面 token 缓存：同一个进程里同一页只取一次。 */
const tokenCache = new Map()

/**
 * 取某个页面里嵌的 CSRF token。
 *
 * 页面里的形态有两种（都见过）：`token: "40位hex"` 与 `var token = "40位hex"`，
 * 所以匹配 `token` 后面跟 `:` 或 `=` 的十六进制串。
 *
 * ⚠️ 这里刻意用 `redirect: 'manual'`：凭据失效时补天返回的是 **302**（body 为空），
 * 而跟随后拿到的是登录页 HTML —— 那样就只能靠「找不到 token」来猜，
 * 提示会写成「站点改版了」，把人带偏。拦住 3xx 就能准确说成「Cookie 失效」。
 *
 * @param {string} pagePath - 页面路径（如 `/WhiteHat/Center/loo`）。
 * @returns {Promise<string>} token。
 */
export async function pageToken(pagePath) {
  const cached = tokenCache.get(pagePath)
  if (cached !== undefined) return cached
  const cookie = await readCookie()
  const response = await fetch(`${ORIGIN}${pagePath}`, {
    headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0 opencli-butian-adapter' },
    redirect: 'manual',
  })
  if (response.status >= 300 && response.status < 400) {
    throw new AuthRequiredError(
      DOMAIN,
      `${pagePath} 被重定向到登录页（HTTP ${String(response.status)}）—— `
      + `Cookie 无效或已过期，请重新从浏览器复制一份写进 ${COOKIE_FILE}。`,
    )
  }
  if (!response.ok) {
    throw new CommandExecutionError(`取 ${pagePath} 失败：HTTP ${String(response.status)}`)
  }
  const html = await response.text()
  const match = /token\s*[:=]\s*"([0-9a-f]{16,})"/.exec(html)
  if (match === null) {
    // 没 302、也没有 token：两种可能都说清楚，别只报一种。
    if (/登录|loginForm|passport/i.test(html.slice(0, 4000))) {
      throw new AuthRequiredError(
        DOMAIN,
        `${pagePath} 返回的是登录相关页面 —— Cookie 多半已失效，重新复制一份写进 ${COOKIE_FILE}。`,
      )
    }
    throw new CommandExecutionError(
      `${pagePath} 里没有 token（这个页面本该有）。要么 Cookie 已失效，要么补天改版了 —— `
      + '先用 `opencli butian center` 确认登录态，还是不行就说明页面结构变了。',
    )
  }
  tokenCache.set(pagePath, match[1])
  return match[1]
}

/**
 * 发一次请求并解包 envelope。
 * @param {string} path - 接口路径。
 * @param {'GET'|'POST'} method - `POST` 会带上 `ajax=1` 与表单编码。
 * @param {Record<string, string|number|undefined>} params - 参数，`undefined` 的键丢掉。
 * @param {string} referer - 来源页（站点会校验）。
 * @returns {Promise<unknown>} `envelope.data`。
 */
async function call(path, method, params, referer) {
  const cookie = await readCookie()
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  search.set('ajax', '1')
  const url = method === 'GET' ? `${ORIGIN}${path}?${search.toString()}` : `${ORIGIN}${path}`
  const headers = {
    Cookie: cookie,
    Referer: referer,
    'User-Agent': 'Mozilla/5.0 opencli-butian-adapter',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
  }
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded'

  // 同 pageToken：不跟随重定向，把 3xx 当成「登录态失效」这个准确信号。
  const response = await fetch(url, {
    method,
    headers,
    body: method === 'POST' ? search.toString() : undefined,
    redirect: 'manual',
  })
  if (response.status >= 300 && response.status < 400) {
    throw new AuthRequiredError(
      DOMAIN,
      `${path} 被重定向（HTTP ${String(response.status)}）—— Cookie 失效了，重新复制一份写进 ${COOKIE_FILE}。`,
    )
  }
  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    if (text.includes('<html')) {
      throw new AuthRequiredError(DOMAIN, `${path} 返回了登录页 —— Cookie 过期了，重新复制一份。`)
    }
    throw new CommandExecutionError(`${path} 返回的不是 JSON：${text.slice(0, 120)}`)
  }
  if (envelope.status !== 1 && envelope.success !== 1) {
    const info = envelope.info ?? envelope.msg ?? envelope.message ?? '（接口没给错误信息）'
    if (/登录|no token|未授权/.test(String(info))) {
      throw new AuthRequiredError(DOMAIN, `${path}：${String(info)}（Cookie 过期或 token 不对）`)
    }
    throw new CommandExecutionError(`${path}：${String(info)}`)
  }
  return envelope.data
}

/** POST 接口（自动带 `ajax=1`）。 */
export function apiPost(path, params, referer) {
  return call(path, 'POST', params, referer)
}

/** GET 接口。 */
export function apiGet(path, params, referer) {
  return call(path, 'GET', params, referer)
}

/** 漏洞级别：0 低 / 1 中 / 2 高 / 其余严重（取自漏洞列表页的行渲染代码）。 */
const LEVEL_LABEL = { 0: '低', 1: '中', 2: '高' }

/**
 * 级别码转文字。
 * @param {unknown} value - 接口返回的 level。
 * @returns {string} 低 / 中 / 高 / 严重。
 */
export function levelLabel(value) {
  return LEVEL_LABEL[Number(value)] ?? '严重'
}

/** 漏洞状态码（取自漏洞列表页的筛选按钮）。 */
const STATUS_LABEL = { 1: '待审核', 3: '待打款', 4: '已完结', 5: '已忽略', 6: '待补充', 7: '处理中' }

/**
 * 状态码转文字。
 * @param {unknown} value - 接口返回的 status。
 * @returns {string} 中文状态；未知码原样显示，不瞎猜。
 */
export function statusLabel(value) {
  return STATUS_LABEL[Number(value)] ?? String(value ?? '')
}
