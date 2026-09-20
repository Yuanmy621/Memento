/**
 * 补天（butian.net）**私有接口**客户端。
 *
 * ## 这些接口是从哪来的
 *
 * 补天没有公开 API 文档，也没有官方 MCP。这里的路径与参数全部来自它自己前端
 * bundle 里的真实定义（`/Public/static/js/main.js` 等），并且**逐条实测过**：
 *
 * ```js
 * // bundle 里的原始形态（axios 封装）
 * const i = axios.create({ baseURL: '/', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
 * // 请求拦截器：POST/DELETE 一律 merge({ ajax: 1 }, data)
 * // 响应拦截器：1 !== s.status && 1 !== s.success 视为失败
 * const fetchSpaceData = e => api({ url: '/WhiteHat/Center/spaceData', method: 'post', data: e })
 * ```
 *
 * 由此得到三条**必须遵守**的约定，缺一个就会拿到 302 或空响应：
 *
 * | 约定 | 说明 |
 * | --- | --- |
 * | `POST` 必须带 `ajax=1` | 前端拦截器自动加的；少了它会当成普通页面请求 |
 * | `Content-Type: x-www-form-urlencoded` | 不是 JSON。用 URLSearchParams 编码 |
 * | 成功判定 `status === 1 \|\| success === 1` | 业务失败也返回 HTTP 200，必须看 envelope |
 * | **需登录的接口还要带 `token`** | 只带 Cookie 会拿到 `{status:0, info:"no token"}` |
 *
 * ## token 从哪来（实测确认）
 *
 * 只带 Cookie 打 `/WhiteHat/Center/spaceData` 会返回 `{"status":0,"info":"no token"}`。
 * 这个 `token` 既不是 Cookie、也不在 localStorage —— 它是服务端**内联渲染进
 * `/WhiteHat/Center` 页面 HTML** 里的一个 Vue data 字段：
 *
 * ```html
 * <script>
 *   var vm = new Vue({ el: "#whitehatIndex", data: function () {
 *     return { token: "4bcbb932cb35441b2a8f2c4d6201d7fe1de600ee", ... }
 *   }});
 * </script>
 * ```
 *
 * 所以 {@link authToken} 的做法是：带 Cookie 拉一次个人中心页，正则抠出这个 40 位
 * hex，并按 Cookie 缓存（{@link tokenCache}）。需登录的接口（个人中心 / 任务 /
 * 关注列表 / 签到天数）都必须把它塞进参数里。
 *
 * `token` 会随会话轮换：真过期时接口仍回 `no token`，此时 {@link callApi} 会清掉
 * 缓存并归类成 `auth` 错误，下一次调用就会自动重新抓一个。
 *
 * @module YuanMy/mcp/butian/client
 */

/** 站点根。所有接口路径都相对它。 */
const BASE = 'https://www.butian.net'

/** 单次请求超时（毫秒）。补天偶发慢响应，给宽一点但别挂死。 */
const TIMEOUT_MS = 20_000

/** 统一 UA。补天对空 UA / 明显脚本 UA 偶发拦截，带一个正常的。 */
const USER_AGENT = 'YuanMy-Agent/0.1 (+https://github.com/) butian-mcp'

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
 * 判断一条业务错误是不是「没登录 / 登录过期」。
 *
 * 补天对未登录的 POST 有时返回 302（fetch 会跟到登录页得到一个 HTML），
 * 有时返回 `{status:0, info:'请先登录'}` —— 两种都要认出来，
 * 否则用户看到的会是「解析失败」这种没用的提示。
 */
function looksLikeAuthError(text: string): boolean {
  // `no token` 也要算：它是「token 过期/没带上」的形态，属于登录态问题而不是业务失败。
  return /登录|登陆|login|未授权|无权限|请先|no token/i.test(text)
}

/** 组装请求头。Referer 是必要的：部分接口校验来源页。 */
function headersFor(path: string, cookie: string | undefined, referer: string): Record<string, string> {
  const headers: Record<string, string> = {
    // 补天的前端带这个头；带上它才是「ajax 请求」的身份
    'X-Requested-With': 'XMLHttpRequest',
    Referer: referer,
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/javascript, */*; q=0.01',
  }
  if (cookie !== undefined && cookie !== '') headers['Cookie'] = cookie
  // 让 path 参与签名计算没意义，但保留参数方便以后按路径加特例头。
  void path
  return headers
}

// ─────────────────────────────────────────────────────────────────────────────
// token：需登录的接口都要带，来源是个人中心页面的内联 Vue data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从个人中心页 HTML 里抠 token 的正则。
 *
 * 页面里长这样：`token: "4bcb…"`（Vue 的 data 字段）。只认「冒号 + 引号包着的长
 * hex」，这样 bundle 里的 `token: t.token,` 这类变量引用不会被误匹配。
 */
const TOKEN_RE = /\btoken\s*:\s*"([0-9a-fA-F]{16,})"/

/** 登录后个人中心页的 Vue 挂载点；用它区分「个人中心页」和「被踢回登录页」。 */
const CENTER_MARKER = 'whitehatIndex'

/**
 * token 缓存。
 *
 * token 与登录态一一对应，所以键直接用 Cookie 串：用户中途换 Cookie（重新登录）时，
 * 旧 token 不会串到新会话上。
 */
let tokenCache: { cookie: string; token: string } | undefined

/** 丢掉缓存的 token；接口报 `no token` 时调用，让下次调用重新抓。 */
function clearTokenCache(): void {
  tokenCache = undefined
}

/**
 * 取当前登录态对应的 `token`。
 *
 * 只带 Cookie 调需登录的接口，补天会回 `{status:0, info:"no token"}` —— 因为前端是
 * 把 token 渲染进个人中心页再由 JS 带上的。这里照做：带 Cookie 拉一次
 * `/WhiteHat/Center`，从 HTML 里抠出内联的 token，然后按 Cookie 缓存。
 *
 * @param cookie - 登录 Cookie（调用方需确保非空）。
 * @returns 40 位 hex 的 token。
 * @throws {ButianError} Cookie 失效（`auth`）/ 前端改版抠不到（`api`）/ 网络失败（`http`）。
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
 * 发一次请求并解包 envelope。
 *
 * @param path - 接口路径（以 `/` 开头）。
 * @param method - `GET` 用 query，`POST` 用表单体（自动补 `ajax=1`）。
 * @param params - 参数；`undefined` 的键会被丢掉。
 * @param options - Cookie 等。
 * @param referer - 伪造的来源页；部分接口校验它。
 * @returns `envelope.data`（业务数据）。
 * @throws {ButianError} 网络 / HTTP / 业务 / 凭据问题，都带 `kind`。
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

/** 站点根地址（给工具的输出里附「原文链接」用）。 */
export function site(): string {
  return BASE
}
