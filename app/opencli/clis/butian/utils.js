/**
 * 补天（butian.net）适配器的共享层：凭据、页面 token、envelope 解包。
 *
 * 补天是「服务端渲染页面 + 站内 POST 接口」结构，接口路径与参数都能从页面内联脚本读出，用 `fetch` 就够（`browser: false`），
 * 代价是 Cookie 要自己提供（见 `readCookie`）。三条约定：`POST` 要带 `ajax=1` 与 `x-www-form-urlencoded`；
 * 成功判定为 `status === 1 || success === 1`（业务失败也返回 HTTP 200）；个人中心接口要带页面 token，少了它返回
 * `{"status":0,"info":"no token"}`；token 每页一个、嵌在该页 HTML 里，`pageToken` 按页缓存，拿 A 页的调 B 页同样报错。
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
 * 凭据文件位置（与 Memento 的补天 MCP 共用同一份）：`~/.Memento/butian-cookie.txt` 里放 butian.net 的 Cookie 整串，
 * `Cookie:` 前缀与换行会被清掉；可用 `BUTIAN_COOKIE_FILE` 换路径，或用环境变量 `BUTIAN_COOKIE` 直接给。
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

/** 读登录 Cookie：环境变量与凭据文件都没有（或为空）时抛 `AuthRequiredError`，并提示去哪填。 */
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
 * 取某个页面里嵌的 CSRF token：形态有 `token: "40位hex"` 与 `var token = "40位hex"` 两种，匹配 `token` 后跟 `:` 或 `=` 的十六进制串。
 * 用 `redirect: 'manual'` 是因为凭据失效时补天返回 302（body 为空），跟随重定向只会拿到登录页 HTML，拦住 3xx 才能准确报「Cookie 失效」。
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
    // 没 302、也没有 token：登录页与改版两种可能都要说清楚。
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
 * 发一次请求并解包 envelope，返回 `envelope.data`：`POST` 会带上 `ajax=1` 与表单编码，
 * `params` 里 `undefined` 的键丢掉，`referer` 是来源页（站点会校验）。
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

/** 级别码转文字：低 / 中 / 高 / 严重。 */
export function levelLabel(value) {
  return LEVEL_LABEL[Number(value)] ?? '严重'
}

/** 漏洞状态码（取自漏洞列表页的筛选按钮）。 */
const STATUS_LABEL = { 1: '待审核', 3: '待打款', 4: '已完结', 5: '已忽略', 6: '待补充', 7: '处理中' }

/** 状态码转文字；未知码原样显示。 */
export function statusLabel(value) {
  return STATUS_LABEL[Number(value)] ?? String(value ?? '')
}
