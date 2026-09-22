/**
 * 漏洞盒子（vulbox.com）**私有接口**客户端。
 *
 * ## 这些接口是从哪来的
 *
 * 漏洞盒子没有公开 API 文档，也没有官方 MCP。这里的路径、请求头与判定规则全部来自它自己
 * 前端 bundle 里的真实定义 —— `paypal.vulbox.com`（企业 SRC 门户，Nuxt SSR）与
 * `www.vulbox.com` 的 `_nuxt/*.js`，并**逐条实测过**（见 `README.md` 的实测表）。
 *
 * ```js
 * // paypal.vulbox.com/public/3752b65.js 里的原始形态
 * BASE_URL_API: "https://vapi.vulbox.com"                       // 所有门户共用一个 API 网关
 * e.onRequest(t => {
 *   t.headers["Content-Type"] = "application/json;charset=UTF-8"
 *   t.headers["X-client-Type"] = "web"
 *   t.headers.uuid = localStorage.uuid || <随机 16~32 位>
 *   const o = $cookies.get("vulbox_token"); if (o) t.headers.Authorization = "Bearer " + o
 *   t.headers["X-Host-Original"] = window.location.host          // ← 用哪个门户的身份
 * })
 * // 响应：{ code, msg, data }；code === 200 才是成功
 * ```
 *
 * 由此得到四条**必须遵守**的约定，缺一个就会拿到 404 / 暂无权限：
 *
 * | 约定 | 说明 |
 * | --- | --- |
 * | 网关只有一个：`vapi.vulbox.com` | 门户、主站、企业 SRC 大厅都走它 |
 * | `X-Host-Original` 决定「你是谁的门户」 | 传 `paypal.vulbox.com` 才能读到 PayPal 这个 SRC 的接口；传 `www.vulbox.com` 会回 `企业SRC信息不存在` |
 * | 凭据是 `Authorization: Bearer <vulbox_token>` | token 在 Cookie 里（`vulbox_token`），不是 Cookie 本身 |
 * | 判定 `code === 200` | 业务失败也是 HTTP 200，必须看 envelope |
 *
 * ## 登录态与「暂无权限」
 *
 * `code` 的几种含义（实测）：
 *   - `401` + `Receive a wrong Token` / `Can't found Token` —— 没带 / 带错了 token；
 *   - `301001 暂无权限` —— token 有效，但**没有加入这个 SRC 项目**。
 *     企业 SRC 的资产范围（`assets.content`）与公告详情（`/web/src/project/notice/<id>`）
 *     都要先「加入项目」才给看，未加入时 `assets.accessible = 4` 且 `content` 为空串；
 *   - `404 企业SRC信息不存在` —— `X-Host-Original` 不是一个 SRC 门户（比如主站）。
 *
 * ## 为什么用「token 有效但没加入」这种话
 *
 * 光看 `logged: false` 会让人以为登录过期了（实测里 `user.vulbox.com` 主站明明是登录状态，
 * 门户侧仍回 `logged: false`）。所以 {@link VulboxError} 把 `forbidden` 单独分一类，
 * 提示是「去门户点加入项目」，而不是「重新复制 Cookie」。
 *
 * @module Memento/mcp/vulbox/client
 */

/** API 网关。所有接口路径都相对它 —— 门户与主站共用一个。 */
const BASE = 'https://vapi.vulbox.com'

/** 单次请求超时（毫秒）。 */
const TIMEOUT_MS = 20_000

/** 统一 UA：带上一个正常浏览器的，避免被当成脚本拦掉。 */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Memento-Agent/0.1 vulbox-mcp'

/** 默认门户：`X-Host-Original` 不给时用它（企业 SRC 门户的域名）。 */
export const DEFAULT_PORTAL = process.env['VULBOX_PORTAL'] ?? 'paypal.vulbox.com'

/** 主站域名（企业 SRC 大厅、帮助中心、总榜都在它名下）。 */
export const MAIN_SITE = 'www.vulbox.com'

/** 失败的种类，决定给模型/用户的提示怎么写。 */
export type VulboxErrorKind =
  /** 没配凭据。 */
  | 'no-credential'
  /** 凭据无效 / 过期。 */
  | 'auth'
  /** 凭据有效但没权限（典型：没加入这个 SRC 项目）。 */
  | 'forbidden'
  /** HTTP 层失败。 */
  | 'http'
  /** 业务层失败（`code !== 200`）。 */
  | 'api'

/** 带种类的错误：调用方据此决定是「去配凭据」「去加入项目」还是「重试」。 */
export class VulboxError extends Error {
  readonly kind: VulboxErrorKind

  constructor(kind: VulboxErrorKind, message: string) {
    super(message)
    this.name = 'VulboxError'
    this.kind = kind
  }
}

/** 一次请求要用的凭据。 */
export interface Credential {
  /** `vulbox_token` Cookie 的值（JWT）。 */
  readonly token: string
  /** `uuid` Cookie 的值；没有就由客户端生成一个（实测不校验，但接口要这个头）。 */
  readonly uuid: string
}

/** 漏洞盒子的 envelope。 */
interface Envelope {
  readonly code?: unknown
  readonly msg?: unknown
  readonly data?: unknown
}

/**
 * 从一个 uuid 生成器借来的随机串（对齐前端实现：数字 + 小写 + 大写各至少一个）。
 * 前端是 `localStorage.uuid || 随机生成后写回`，所以这个值本身不参与鉴权。
 */
function randomUuid(): string {
  const digits = '0123456789'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const length = 16 + Math.floor(Math.random() * 17)
  const chars = [
    digits[Math.floor(Math.random() * digits.length)],
    lower[Math.floor(Math.random() * lower.length)],
    upper[Math.floor(Math.random() * upper.length)],
  ]
  const pool = digits + lower + upper
  while (chars.length < length) chars.push(pool[Math.floor(Math.random() * pool.length)] ?? 'a')
  return chars.join('')
}

/**
 * 从 Cookie 串里取一个键的值。
 * @param cookie - 浏览器里整串 Cookie（也容忍 `Cookie:` 前缀与换行）。
 * @param name - 键名。
 * @returns 值；没有就是空串。
 */
export function cookieValue(cookie: string, name: string): string {
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1)
  }
  return ''
}

/**
 * 把用户粘贴的 Cookie 整串解析成凭据。
 *
 * 只认 `vulbox_token`（鉴权用）与 `uuid`（请求头用）两个键 —— 其余 Cookie
 * （`VB_INDEX_LAYOUT`、`WeChat_uuid`、`authorization=1`）实测都不参与接口鉴权。
 * @param cookie - 原始 Cookie 串。
 * @returns 凭据；没有 `vulbox_token` 时返回 `undefined`。
 */
export function credentialOf(cookie: string): Credential | undefined {
  const token = cookieValue(cookie, 'vulbox_token')
  if (token === '') return undefined
  const uuid = cookieValue(cookie, 'uuid')
  return { token, uuid: uuid === '' ? randomUuid() : uuid }
}

/** 判断一个响应是不是「业务成功」。 */
function isOk(envelope: Envelope): boolean {
  return envelope.code === 200
}

/** 取业务错误文案。 */
function messageOf(envelope: Envelope): string {
  const msg = envelope.msg
  return typeof msg === 'string' && msg !== '' ? msg : '（接口没给错误信息）'
}

/** 判断错误文案是不是「凭据本身的问题」。 */
function looksLikeAuthError(text: string): boolean {
  return /wrong Token|Can't found Token|Unauthenticated|登录|登录过期|请先登录/i.test(text)
}

/** 组装请求头。 */
function headersFor(portal: string, credential: Credential | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'X-client-Type': 'web',
    // 决定「用哪个门户的身份」：SRC 门户传自己的域名，主站传 www
    'X-Host-Original': portal,
    Referer: `https://${portal}/`,
    'User-Agent': USER_AGENT,
  }
  if (credential !== undefined) {
    headers['Authorization'] = `Bearer ${credential.token}`
    headers['uuid'] = credential.uuid
  }
  return headers
}

/**
 * 发一次 GET 并解包 envelope。
 *
 * 只实现 GET：这个 MCP 是**只读**的，漏洞盒子的写接口（加入项目 / 提交漏洞 / 反馈）
 * 一律不注册、也不在这里开口子。
 *
 * @param portal - `X-Host-Original`：`paypal.vulbox.com` 之类的门户域名，或 `www.vulbox.com`。
 * @param path - 接口路径（以 `/` 开头）。
 * @param params - 查询参数；`undefined` 的键会被丢掉。
 * @param credential - 凭据；不传就是匿名请求。
 * @returns `envelope.data`。
 * @throws {VulboxError} 网络 / HTTP / 业务 / 权限 / 凭据问题，都带 `kind`。
 */
export async function apiGet(
  portal: string,
  path: string,
  params: Readonly<Record<string, string | number | undefined>> = {},
  credential?: Credential | undefined,
): Promise<unknown> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const query = search.toString()
  const url = `${BASE}${path}${query === '' ? '' : `?${query}`}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: headersFor(portal, credential),
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new VulboxError('http', `请求 ${path} 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new VulboxError('auth', `${path} 需要登录（HTTP ${String(response.status)}）`)
    }
    throw new VulboxError('http', `${path} 返回 HTTP ${String(response.status)}`)
  }

  let envelope: Envelope
  try {
    envelope = JSON.parse(text) as Envelope
  } catch {
    throw new VulboxError('api', `${path} 返回的不是 JSON：${text.slice(0, 120)}`)
  }

  if (isOk(envelope)) return envelope.data
  const message = messageOf(envelope)
  if (looksLikeAuthError(message)) throw new VulboxError('auth', `${path}：${message}`)
  // 301001 是「登录了但没加入这个项目」——单独一类，提示要能落到「去门户点加入」
  if (/暂无权限|无权限/.test(message)) throw new VulboxError('forbidden', `${path}：${message}`)
  throw new VulboxError('api', `${path}：${message}`)
}

/**
 * 从项目信息里取门户域名。
 *
 * 企业 SRC 大厅返回的每条项目都带 `src_url`（形如 `paypal.vulbox.com`），
 * 门户接口要靠它当 `X-Host-Original`。
 * @param srcUrl - 项目里的 `src_url`。
 * @returns 门户域名；给空就退回 {@link DEFAULT_PORTAL}。
 */
export function portalOf(srcUrl: string | undefined): string {
  const trimmed = (srcUrl ?? '').trim()
  return trimmed === '' ? DEFAULT_PORTAL : trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

/** API 网关地址（工具输出里附「原文链接」用）。 */
export function gateway(): string {
  return BASE
}

// ─────────────────────────────────────────────────────────────────────────────
// 「我是谁」：只能从主站 SSR 页面的 window.__NUXT__ 里读
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 SSR 页面里读出来的账号信息。
 *
 * 为什么要绕这一圈（实测）：网关那两个「账号」接口（`/web/account/basic-info`、
 * `/web/home/user-info`）对 Bearer / Cookie / 两者组合**一律回 `logged: false`**，
 * 而同一份 Cookie 在主站 SSR 上明确是登录态（uid / 用户名 / 实名都在页面里）。
 * 所以「我是谁」这件事只有 SSR 这条路是通的 —— 它是**服务端渲染时就查好了**的。
 */
export interface PortalUser {
  /** SSR 判定是否登录。 */
  readonly logged: boolean
  readonly username: string
  readonly uid: number | null
  /** 实名姓名（站方会打码，如 `**远`）。 */
  readonly realName: string
  readonly mobile: string
  /** 等级名，如「见习白帽」。 */
  readonly level: string
  readonly expCurrent: number | null
  readonly expTotal: number | null
  /** 站内信数量。 */
  readonly messageCount: number | null
  readonly season: number | null
}

/** 把 SSR 页面里的字符串字面量（`"a\u002Fb"`）还原成真值。 */
function unescapeJsString(raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`) as string
  } catch {
    return raw
  }
}

/** 逐个解析 IIFE 的实参（`false,0,"",true,1,"173****2646",void 0,"Memento",…`）。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = false
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (quote) {
      current += char
      if (char === '\\') {
        current += text[i + 1] ?? ''
        i += 1
      } else if (char === '"') {
        quote = false
      }
      continue
    }
    if (char === '"') { quote = true; current += char; continue }
    if (char === '{' || char === '[' || char === '(') depth += 1
    if (char === '}' || char === ']' || char === ')') depth -= 1
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/** 一个实参 token → 值（只认 SSR 里实际出现的那几种形态）。 */
function valueOfToken(token: string, params: ReadonlyMap<string, unknown>): unknown {
  const text = token.trim()
  if (text === '') return undefined
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (text === 'void 0' || text === 'undefined') return undefined
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('"')) return unescapeJsString(text.slice(1, -1))
  if (text === '{}') return {}
  if (text === '[]') return []
  return params.get(text)
}

/**
 * 解析 `window.__NUXT__=(function(a,b,…){ <prelude>; return {…} }(v1,v2,…));`。
 *
 * 只做**受限求值**：形参 → 实参映射 + 前缀里的 `x.prop=value` 赋值。
 * 刻意不 `eval` 页面脚本 —— 那等于让被侦察的站点在我们的进程里执行任意代码。
 */
function parseNuxt(script: string): { params: Map<string, unknown>; state: string } | undefined {
  const head = script.indexOf('(function(')
  if (head === -1) return undefined
  const paramsEnd = script.indexOf(')', head + 10)
  if (paramsEnd === -1) return undefined
  const names = script.slice(head + 10, paramsEnd).split(',').map((name) => name.trim())
  const callAt = script.lastIndexOf('}(')
  if (callAt === -1) return undefined
  const argsEnd = script.lastIndexOf(')')
  if (argsEnd <= callAt) return undefined
  const args = splitTopLevel(script.slice(callAt + 2, argsEnd))
  const params = new Map<string, unknown>()
  names.forEach((name, index) => {
    if (name !== '') params.set(name, valueOfToken(args[index] ?? '', params))
  })
  // 前缀里的 `o.season_in_year=n` / `q.season={enable:a}` 这类赋值
  const prelude = script.slice(paramsEnd, callAt)
  for (const match of prelude.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*([^;,]+)/g)) {
    const target = params.get(match[1] ?? '')
    const key = match[2] ?? ''
    const value = valueOfToken(match[3] ?? '', params)
    if (typeof target === 'object' && target !== null) {
      (target as Record<string, unknown>)[key] = value
    }
  }
  return { params, state: script.slice(paramsEnd, callAt) }
}

/** 取一个对象的 `{…}` 文本（按花括号配对，跳过字符串里的括号）。 */
function objectAt(text: string, from: number): { body: string; end: number } | undefined {
  const open = text.indexOf('{', from)
  if (open === -1) return undefined
  let depth = 0
  let quote = false
  for (let i = open; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (quote) {
      if (char === '\\') i += 1
      else if (char === '"') quote = false
      continue
    }
    if (char === '"') { quote = true; continue }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return { body: text.slice(open + 1, i), end: i }
    }
  }
  return undefined
}

/** 把 `{a:1, b:"x", c:{…}}` 的顶层条目解析成键值。 */
function entriesOf(body: string, params: ReadonlyMap<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const entry of splitTopLevel(body)) {
    const colon = entry.indexOf(':')
    if (colon === -1) continue
    const key = entry.slice(0, colon).trim().replace(/^["']|["']$/g, '')
    const valueText = entry.slice(colon + 1).trim()
    if (valueText.startsWith('{')) {
      const inner = objectAt(valueText, 0)
      out.set(key, inner === undefined ? {} : Object.fromEntries(entriesOf(inner.body, params)))
      continue
    }
    out.set(key, valueOfToken(valueText, params))
  }
  return out
}

/**
 * 读主站 SSR 页面里的账号信息。
 *
 * @param cookie - 浏览器里 vulbox.com 的整串 Cookie（SSR 认 Cookie，不认 Bearer）。
 * @returns 账号信息。
 * @throws {VulboxError} `auth` 页面上不是登录态；`api` 页面结构变了解析不出来；`http` 网络失败。
 */
export async function fetchPortalUser(cookie: string): Promise<PortalUser> {
  if (cookie.trim() === '') throw new VulboxError('no-credential', '需要 Cookie 才能读账号信息')
  let html: string
  try {
    const response = await fetch(`https://${MAIN_SITE}/`, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: cookie,
        'User-Agent': USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new VulboxError('http', `主站首页返回 HTTP ${String(response.status)}`)
    html = await response.text()
  } catch (error) {
    if (error instanceof VulboxError) throw error
    throw new VulboxError('http', `取主站首页失败：${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * ⚠️ 必须切到 `</script>` 为止：页面后面还有别的内联脚本（统计代码里也有 `}(…)`），
   * 不切的话 `lastIndexOf('}(')` 会跑到那段里去，参数表整个错位
   * （实测：用户名/uid 全空，只有不走参数的 `level.name` 是对的）。
   */
  const start = html.indexOf('window.__NUXT__=')
  const end = html.indexOf('</script>', start)
  const script = html.slice(start, end === -1 ? undefined : end)
  const parsed = parseNuxt(script)
  if (parsed === undefined) {
    throw new VulboxError('api', '主站页面里找不到 window.__NUXT__（前端改版了？）')
  }
  const userAt = parsed.state.indexOf('user:{')
  const userObject = userAt === -1 ? undefined : objectAt(parsed.state, userAt)
  if (userObject === undefined) {
    throw new VulboxError('api', '主站 SSR 状态里没有 user 对象（前端改版了？）')
  }
  const user = entriesOf(userObject.body, parsed.params)
  const infoRaw = user.get('userInfo')
  const info = (typeof infoRaw === 'object' && infoRaw !== null ? infoRaw : {}) as Record<string, unknown>
  const levelRaw = info['level']
  const level = (typeof levelRaw === 'object' && levelRaw !== null ? levelRaw : {}) as Record<string, unknown>
  const seasonRaw = info['season']
  const season = (typeof seasonRaw === 'object' && seasonRaw !== null ? seasonRaw : {}) as Record<string, unknown>
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
  const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  /** 内层对象可能是 `{}`（SSR 里被参数化过），所以用户名等字段两个层级都找一遍。 */
  const pick = (key: string, fallback: unknown): unknown => info[key] ?? user.get(key) ?? fallback

  return {
    logged: user.get('isLogin') === true,
    username: asString(pick('username', '')),
    uid: asNumber(pick('uid', null)),
    realName: asString(pick('real_name', '')),
    mobile: asString(pick('mobile', '')),
    level: asString(level['name']),
    expCurrent: asNumber(level['exp_cur']),
    expTotal: asNumber(level['exp_total']),
    messageCount: asNumber(pick('message_count', null)),
    season: asNumber(season['season_in_year']),
  }
}
