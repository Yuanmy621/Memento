/**
 * 补天（butian.net）私有接口客户端：站点根 `https://www.butian.net`，POST 走表单编码而非 JSON。
 * 接口路径与参数取自补天前端 bundle，属私有接口，没有公开文档。
 *
 * POST 一律带 `ajax=1`（前端拦截器自动加，缺了会被当成普通页面请求）；成功判定是 envelope 里
 * `status === 1 || success === 1`，业务失败同样返回 HTTP 200。需登录的接口还要带表单字段 `token`，
 * 它不在 Cookie 里，而是内联渲染在 `/WhiteHat/Center` 页面中（40 位 hex，见 {@link authToken}）。
 *
 * @module Memento/mcp/butian/client
 */

/** 站点根。所有接口路径都相对它。 */
const BASE = 'https://www.butian.net'

/** 单次请求超时（毫秒）；补天偶发慢响应，取值偏宽。 */
const TIMEOUT_MS = 20_000

/** 固定 UA；补天对空 UA 偶发拦截。 */
const USER_AGENT = 'Memento-Agent/0.1 (+https://github.com/) butian-mcp'

/** 失败的种类，决定给模型/用户的提示怎么写。 */
export type ButianErrorKind =
  /** 没配凭据，这个接口需要登录。 */
  | 'no-credential'
  /** 配了凭据但登录态过期 / 无效。 */
  | 'auth'
  /** HTTP 层失败（状态码、网络）。 */
  | 'http'
  /** 业务层失败（envelope 里 status !== 1）。 */
  | 'api'

/** 带种类的错误：界面/模型据此决定是「去配凭据」还是「重试」。 */
export class ButianError extends Error {
  readonly kind: ButianErrorKind

  constructor(kind: ButianErrorKind, message: string) {
    super(message)
    this.name = 'ButianError'
    this.kind = kind
  }
}

/** 一次调用的选项。 */
export interface CallOptions {
  /** 登录 Cookie；不传就按匿名请求（免登录接口可用）。 */
  readonly cookie?: string | undefined
}

/** 补天返回的 envelope。 */
interface Envelope {
  readonly status?: unknown
  readonly success?: unknown
  readonly info?: unknown
  readonly msg?: unknown
  readonly message?: unknown
  readonly data?: unknown
}

/** 判断一个响应是不是「业务成功」。 */
function isOk(envelope: Envelope): boolean {
  return envelope.status === 1 || envelope.success === 1
}

/** 从 envelope 里取错误文案。 */
function messageOf(envelope: Envelope): string {
  for (const key of ['info', 'msg', 'message'] as const) {
    const value = envelope[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return '（接口没给错误信息）'
}

/**
 * 判断业务错误是不是「没登录 / 登录过期」：补天对未登录的 POST 有时 302 到登录页（拿到 HTML），
 * 有时回 `{status:0, info:'请先登录'}`，两种都要认出来，否则只会暴露成「解析失败」。
 */
function looksLikeAuthError(text: string): boolean {
  // `no token` 也要算：它是「token 过期/没带上」的形态，属于登录态问题而不是业务失败。
  return /登录|登陆|login|未授权|无权限|请先|no token/i.test(text)
}

/** 组装请求头；部分接口校验 `Referer`，缺失会失败。 */
function headersFor(path: string, cookie: string | undefined, referer: string): Record<string, string> {
  const headers: Record<string, string> = {
    // 补天的前端带这个头；带上它才是「ajax 请求」的身份
    'X-Requested-With': 'XMLHttpRequest',
    Referer: referer,
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/javascript, */*; q=0.01',
  }
  if (cookie !== undefined && cookie !== '') headers['Cookie'] = cookie
// `path` 不参与签名计算，形参留作按路径加特例头用
  void path
  return headers
}

// token：需登录的接口都要带，取自个人中心页内联的 Vue data

/**
 * 从个人中心页 HTML 抠 token 的正则：页面里是 `token: "4bcb…"` 这种 Vue data 字段，
 * 只认冒号加引号包着的长 hex，以免匹配到 bundle 里的 `token: t.token,`。
 */
const TOKEN_RE = /\btoken\s*:\s*"([0-9a-fA-F]{16,})"/

/** 登录后个人中心页的 Vue 挂载点；用它区分「个人中心页」和「被踢回登录页」。 */
const CENTER_MARKER = 'whitehatIndex'

/**
 * token 缓存：token 与登录态一一对应，键直接用 Cookie 串，
 * 中途换 Cookie（重新登录）时旧 token 不会串到新会话上。
 */
let tokenCache: { cookie: string; token: string } | undefined

/** 丢掉缓存的 token；接口报 `no token` 时调用，让下次调用重新抓。 */
function clearTokenCache(): void {
  tokenCache = undefined
}

/**
 * 取当前登录态对应的 `token`：带 Cookie 拉一次 `/WhiteHat/Center`，从 HTML 里抠出内联值并按 Cookie 缓存。
 *
 * 抠不到时按页面区分原因：不是个人中心页即登录态失效（`auth`），是个人中心页则是前端改版（`api`）。
 */
export async function authToken(cookie: string): Promise<string> {
  const cached = tokenCache
  if (cached !== undefined && cached.cookie === cookie) return cached.token

  const url = `${BASE}/WhiteHat/Center`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: cookie,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new ButianError('http', `取 token 时请求 /WhiteHat/Center 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) {
    throw new ButianError('http', `取 token 时 /WhiteHat/Center 返回 HTTP ${String(response.status)}`)
  }

  const html = await response.text()
  const matched = TOKEN_RE.exec(html)
  if (matched === null || matched[1] === undefined) {
    // 没抠到：先看拿到的是不是个人中心页，是的话就是前端改版，否则是登录态没了。
    if (!html.includes(CENTER_MARKER)) {
      throw new ButianError('auth', '个人中心页被重定向到登录页，读不到 token')
    }
    throw new ButianError('api', '在 /WhiteHat/Center 页面里找不到 token 字段（补天前端可能改版了）')
  }

  tokenCache = { cookie, token: matched[1] }
  return matched[1]
}

/**
 * 发一次请求并解包 envelope，返回其中的 `data`：`GET` 用 query，`POST` 用表单体并自动补 `ajax=1`，
 * `params` 里值为 `undefined` 的键会被丢掉；`referer` 是伪造的来源页，部分接口校验它。
 */
async function callApi(
  path: string,
  method: 'GET' | 'POST',
  params: Readonly<Record<string, string | number | undefined>>,
  options: CallOptions,
  referer: string,
): Promise<unknown> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  // POST 一律带 ajax=1（前端拦截器就是这么加的）；GET 也带上，无副作用。
  search.set('ajax', '1')

  const url = method === 'GET' ? `${BASE}${path}?${search.toString()}` : `${BASE}${path}`
  const headers = headersFor(path, options.cookie, referer)
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded'

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? search.toString() : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new ButianError('http', `请求 ${path} 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    if (looksLikeAuthError(text) || response.status === 401 || response.status === 403) {
      throw new ButianError('auth', `${path} 需要登录（HTTP ${String(response.status)}）`)
    }
    throw new ButianError('http', `${path} 返回 HTTP ${String(response.status)}`)
  }

  let envelope: Envelope
  try {
    envelope = JSON.parse(text) as Envelope
  } catch {
    // 拿到 HTML 通常是「被重定向到登录页」—— fetch 跟随后状态码是 200
    if (looksLikeAuthError(text) || /<html/i.test(text)) {
      throw new ButianError('auth', `${path} 需要登录（返回了登录页而不是 JSON）`)
    }
    throw new ButianError('api', `${path} 返回的不是 JSON：${text.slice(0, 120)}`)
  }

  if (!isOk(envelope)) {
    const message = messageOf(envelope)
    // `no token` 说明缓存的 token 已经轮换掉了：清缓存，下次调用会自动重抓。
    if (/no token/i.test(message)) clearTokenCache()
    if (looksLikeAuthError(message)) throw new ButianError('auth', `${path}：${message}`)
    throw new ButianError('api', `${path}：${message}`)
  }
  return envelope.data
}

/** GET 接口。 */
export function apiGet(
  path: string,
  params: Readonly<Record<string, string | number | undefined>>,
  options: CallOptions,
  referer: string,
): Promise<unknown> {
  return callApi(path, 'GET', params, options, referer)
}

/** POST 接口（自动带 `ajax=1`）。 */
export function apiPost(
  path: string,
  params: Readonly<Record<string, string | number | undefined>>,
  options: CallOptions,
  referer: string,
): Promise<unknown> {
  return callApi(path, 'POST', params, options, referer)
}

/** 站点根地址。 */
export function site(): string {
  return BASE
}
