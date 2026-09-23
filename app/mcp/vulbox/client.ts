/**
 * 漏洞盒子（vulbox.com）私有接口客户端：门户、主站与企业 SRC 大厅共用 `https://vapi.vulbox.com` 一个网关。
 * 接口路径与请求头取自门户前端 bundle，属私有接口，没有公开文档。
 *
 * 请求头 `X-Host-Original` 决定用哪个门户的身份；凭据取自 Cookie 里的 `vulbox_token`，
 * 以 `Authorization: Bearer <token>` 发出。响应是 `{ code, msg, data }`，业务失败同样返回 HTTP 200，
 * 只有 `code === 200` 才算成功；`301001 暂无权限` 表示 token 有效但未加入该项目。
 *
 * @module Memento/mcp/vulbox/client
 */

/** API 网关，门户与主站共用；所有接口路径都相对它。 */
const BASE = 'https://vapi.vulbox.com'

/** 单次请求超时（毫秒）。 */
const TIMEOUT_MS = 20_000

/** 用正常浏览器的 UA，避免被当成脚本拦掉。 */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Memento-Agent/0.1 vulbox-mcp'

/** 默认门户，即 `X-Host-Original` 缺省时的取值；`VULBOX_PORTAL` 可覆盖。 */
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
/** `uuid` Cookie 的值；缺失时由客户端随机生成，接口不校验它但要这个头。 */
  readonly uuid: string
}

/** 漏洞盒子的 envelope。 */
interface Envelope {
  readonly code?: unknown
  readonly msg?: unknown
  readonly data?: unknown
}

/** 生成 16~32 位随机串，前三位分别是数字、小写、大写（对齐前端实现）；该值不参与鉴权。 */
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

/** 从整串 Cookie 里取一个键的值；容忍 `Cookie:` 前缀与换行，取不到返回空串。 */
export function cookieValue(cookie: string, name: string): string {
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1)
  }
  return ''
}

/**
 * 把整串 Cookie 解析成凭据：只用 `vulbox_token`（鉴权）与 `uuid`（请求头），其余键
 * （`VB_INDEX_LAYOUT`、`WeChat_uuid`、`authorization=1`）不参与鉴权；缺 `vulbox_token` 返回 `undefined`。
 */
export function credentialOf(cookie: string): Credential | undefined {
  const token = cookieValue(cookie, 'vulbox_token')
  if (token === '') return undefined
  const uuid = cookieValue(cookie, 'uuid')
  return { token, uuid: uuid === '' ? randomUuid() : uuid }
}

/** 是否业务成功只看 envelope 的 `code`，HTTP 状态码不代表业务结果。 */
function isOk(envelope: Envelope): boolean {
  return envelope.code === 200
}

/** 取 envelope 里的业务错误文案。 */
function messageOf(envelope: Envelope): string {
  const msg = envelope.msg
  return typeof msg === 'string' && msg !== '' ? msg : '（接口没给错误信息）'
}

/** 判断错误文案是不是「凭据本身的问题」。 */
function looksLikeAuthError(text: string): boolean {
  return /wrong Token|Can't found Token|Unauthenticated|登录|登录过期|请先登录/i.test(text)
}

/** 组装请求头；`X-Host-Original` 与 `Referer` 都由门户域名推出。 */
function headersFor(portal: string, credential: Credential | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'X-client-Type': 'web',
// `X-Host-Original` 决定用哪个门户的身份：门户传自己的域名，主站传 www；传错会回「企业SRC信息不存在」
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
 * 发一次 GET 并解包 envelope，返回其中的 `data`；只实现 GET，写接口不在这里开口子。
 * `portal` 作为 `X-Host-Original` 发出，`params` 里值为 `undefined` 的键会被丢掉，失败抛带 `kind` 的 {@link VulboxError}。
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
// 301001 是「登录了但没加入这个项目」，单独归类，提示要能落到「去门户点加入」
  if (/暂无权限|无权限/.test(message)) throw new VulboxError('forbidden', `${path}：${message}`)
  throw new VulboxError('api', `${path}：${message}`)
}

/**
 * 从项目信息里取门户域名：企业 SRC 大厅每条项目都带 `src_url`（形如 `paypal.vulbox.com`），
 * 门户接口靠它当 `X-Host-Original`；去掉 `https://` 前缀与路径，为空时退回 {@link DEFAULT_PORTAL}。
 */
export function portalOf(srcUrl: string | undefined): string {
  const trimmed = (srcUrl ?? '').trim()
  return trimmed === '' ? DEFAULT_PORTAL : trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

/** API 网关地址。 */
export function gateway(): string {
  return BASE
}

// 「我是谁」：只能从主站 SSR 页面的 window.__NUXT__ 里读

/**
 * 从主站 SSR 页面读出的账号信息：网关的账号接口（`/web/account/basic-info`、
 * `/web/home/user-info`）对任何凭据都回 `logged: false`，判登录态只能靠 SSR。
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
 * 解析 `window.__NUXT__=(function(a,b,…){ <prelude>; return {…} }(v1,v2,…));`：
 * 只做受限求值（形参 → 实参映射加上前缀里的 `x.prop=value` 赋值），不 `eval` 页面脚本。
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
 * 读主站 SSR 页面里的账号信息；SSR 认 Cookie 而不认 Bearer，
 * 失败按原因抛 `auth`（未登录）/ `api`（页面结构变化）/ `http`（网络）三类。
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
   * 切片要一直取到 `</script>`：页面后面还有别的内联脚本（统计代码里也有 `}(…)`），
   * 否则 `lastIndexOf('}(')` 会落到那段上，参数表整体错位、用户名与 uid 全空。
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
