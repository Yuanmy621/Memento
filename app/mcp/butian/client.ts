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
 *
 * ## 关于「未验证」
 *
 * 免登录的接口（项目大厅 / 排行 / 平台数字）已经真实调用并核对过返回结构。
 * **需要登录**的接口（个人中心 / 任务 / 签到）只能从 bundle 里读到「路径 + 方法 +
 * 参数名」，真正的返回结构要等你填上凭据才能确认 —— 所以它们统一走
 * {@link callApi}，把「凭据缺失 / 登录态过期 / 业务失败」区分开报，
 * 而不是抛一个看不懂的异常。填完凭据用 `butian_doctor` 工具看一遍即可。
 *
 * @module YuanMy/mcp/butian/client
 */

/** 站点根。所有接口路径都相对它。 */
const BASE = 'https://www.butian.net'

/** 单次请求超时（毫秒）。补天偶发慢响应，给宽一点但别挂死。 */
const TIMEOUT_MS = 20_000

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
  return /登录|登陆|login|未授权|无权限|请先/.test(text)
}

/** 组装请求头。Referer 是必要的：部分接口校验来源页。 */
function headersFor(path: string, cookie: string | undefined, referer: string): Record<string, string> {
  const headers: Record<string, string> = {
    // 补天的前端带这个头；带上它才是「ajax 请求」的身份
    'X-Requested-With': 'XMLHttpRequest',
    Referer: referer,
    'User-Agent': 'YuanMy-Agent/0.1 (+https://github.com/) butian-mcp',
    Accept: 'application/json, text/javascript, */*; q=0.01',
  }
  if (cookie !== undefined && cookie !== '') headers['Cookie'] = cookie
  // 让 path 参与签名计算没意义，但保留参数方便以后按路径加特例头。
  void path
  return headers
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
