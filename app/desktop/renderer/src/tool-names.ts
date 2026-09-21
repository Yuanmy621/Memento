/**
 * 工具 → 「实际功能的中文名」。
 *
 * 界面里**不展示工具本身的变量名**（`mcp__butian__butian_rank` 这种是给模型看的），
 * 而是给每个工具一个中文功能名与一句话说明。模型侧一切照旧：真正发给模型的仍然是原名。
 * 这里只影响**输入框 `@` 弹出的 MCP 候选菜单**（以及插进输入框的 chip 上显示的字 ——
 * 落库文本仍是 `用 <原名> 工具：`，见 `chip-text.ts`）。
 *
 * ## 认不出来怎么办
 *
 * 认不出来（用户自己挂了别的 MCP server、或内核换了工具名）时**不编**：
 *   - 名字仍显示原名（宁可露出变量名，也不能瞎起一个错的中文名）；
 *   - 说明优先用服务端给的中文描述（很多 MCP server 会写中文 description，比如补天）；
 *     描述是英文就留空，免得菜单里中英混杂。
 *
 * 纯逻辑：没有 JSX、没有 DOM，Node 里能直接 import 跑真值表。
 *
 * @module YuanMy/desktop/renderer/src/tool-names
 */

/** 一个工具在界面上的样子。 */
export interface ToolDisplay {
  /** 中文功能名（菜单主文案，例如「读取文件」）。 */
  readonly label: string
  /** 一句话说明（中文；拿不到就是空串）。 */
  readonly note: string
  /** 分组名（MCP server 的中文名，例如「补天」）。 */
  readonly group: string
  /** 是否是 MCP 工具（真正的名字形如 `mcp__<server>__<tool>`）。 */
  readonly mcp: boolean
}

/**
 * 内置工具表：**按功能分组写死**，顺序就是菜单里的顺序（读 → 写 → 改 → 跑 → 找 → 抓 →
 * 看图 → 技能 → 后台任务）。这份顺序是刻意排的：SRC 场景下最常用的读/写/跑排在上面，
 * 比按字典序排「bash、edit、fetch_url…」好找得多。
 */
const BUILTIN: Readonly<Record<string, { readonly label: string; readonly note: string; readonly order: number }>> = {
  read: { label: '读取文件', note: '读 UTF-8 文本，返回带行号的内容', order: 10 },
  write: { label: '写文件', note: '新建或整份覆盖一个文本文件', order: 11 },
  edit: { label: '改文件', note: '按字面文本替换，改动已有文件', order: 12 },
  bash: { label: '执行命令', note: '跑一条 bash 命令，每次都是新的 shell', order: 20 },
  glob: { label: '按路径找文件', note: '通配符匹配文件路径（只返回文件）', order: 30 },
  grep: { label: '按内容搜代码', note: '用 ripgrep 正则搜文件内容，返回命中行', order: 31 },
  tree: { label: '看目录结构', note: '把目录画成缩进树，快速熟悉项目', order: 32 },
  fetch_url: { label: '抓网页', note: '抓一个 URL，返回正文文本', order: 40 },
  web_search: { label: '联网搜索', note: '按关键词搜索，返回结果与来源链接', order: 41 },
  web_fetch: { label: '抓网页', note: '抓一个 URL，返回正文文本', order: 42 },
  read_image: { label: '看图', note: '读 PNG/JPEG/WebP/GIF 图片本身', order: 50 },
  skill: { label: '加载技能', note: '按名字加载一个技能的完整说明', order: 60 },
  job_list: { label: '后台任务列表', note: '列出后台任务（含已结束的）', order: 70 },
  job_output: { label: '读后台任务输出', note: '读一个后台任务的输出（流式任务只给新增部分）', order: 71 },
  job_kill: { label: '停掉后台任务', note: '取消一个还在跑的后台任务', order: 72 },
}

/**
 * MCP server 的中文名与展示顺序：认得出来就用中文（并排在前面），
 * 认不出来就显示 `MCP · <server id>` 并排到最后 —— **不替用户挂的 server 起中文名**。
 */
const MCP_SERVER: Readonly<Record<string, { readonly label: string; readonly order: number }>> = {
  butian: { label: '补天', order: 10 },
  agentmemory: { label: '记忆库', order: 20 },
}

/**
 * MCP 工具的中文名（按 server 分组写死）。
 *
 * 只列「这个仓库自己带的」那一个 server（补天，见 `app/mcp/butian/server.ts`）：
 * 它的 `title` 就是中文名，这里抄一份，顺便定菜单里的顺序（选目标 → 看别人 → 看自己）。
 */
const MCP_TOOLS: Readonly<Record<string, Readonly<Record<string, { readonly label: string; readonly order: number }>>>> = {
  butian: {
    butian_project_hall: { label: '项目大厅', order: 10 },
    butian_rank: { label: '白帽排行', order: 11 },
    butian_platform_stats: { label: '平台数字', order: 12 },
    butian_me: { label: '我的空间', order: 20 },
    butian_missions: { label: '我的任务', order: 21 },
    butian_my_follow: { label: '关注的项目', order: 22 },
    butian_doctor: { label: '连接自检', order: 30 },
  },
}

/** 文本里有没有中日韩字（用来判断「服务端给的描述是不是中文」）。 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}

/**
 * 拆开 MCP 工具名 `mcp__<server>__<tool>`。
 * @param name - 工具全名。
 * @returns server 与 tool；不是 MCP 工具时返回 `null`。
 */
export function mcpParts(name: string): { readonly server: string; readonly tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const at = rest.indexOf('__')
  if (at <= 0) return { server: rest, tool: '' }
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) }
}

/**
 * 取描述的第一句（中文才要，英文留空 —— 菜单里不中英混排）。
 *
 * MCP server 的描述是写给**模型**看的 markdown（比如补天的「（**需要登录 Cookie**）」），
 * 直接摆进菜单会把 `**` 一起显出来，所以先洗掉强调记号。
 */
function chineseNote(description: string | undefined): string {
  if (description === undefined) return ''
  const line = (description.split('\n')[0] ?? '')
    .replace(/\*\*|__|`/g, '')
    .trim()
  if (line === '' || !hasCjk(line)) return ''
  // 服务端的描述常常很长：截到第一个句号 / 分号，最多 46 字
  const cut = line.split(/[。；;]/)[0] ?? line
  return cut.length > 46 ? `${cut.slice(0, 46)}…` : cut
}

/**
 * 一个工具在界面上该怎么显示。
 * @param name - 工具全名（`read` / `mcp__butian__butian_rank`）。
 * @param description - 内核给的描述（可选；只在认不出这个工具时用作兜底说明）。
 * @returns 中文功能名 + 说明 + 分组 + 图标类别。
 */
export function toolDisplay(name: string, description?: string): ToolDisplay {
  const mcp = mcpParts(name)
  if (mcp !== null) {
    const group = MCP_SERVER[mcp.server]?.label ?? `MCP · ${mcp.server}`
    const known = MCP_TOOLS[mcp.server]?.[mcp.tool]
    return {
      label: known?.label ?? (mcp.tool === '' ? mcp.server : mcp.tool),
      note: chineseNote(description),
      group,
      mcp: true,
    }
  }
  const known = BUILTIN[name]
  if (known !== undefined) {
    return { label: known.label, note: known.note, group: '内置工具', mcp: false }
  }
  // 认不出来：名字保持原名（不编），说明尽量用中文描述
  return { label: name, note: chineseNote(description), group: '其它工具', mcp: false }
}

/**
 * 取一段文本的**首行**（界面上到处都是「一行预览」：工具行尾的灰字、轨迹行的摘要）。
 *
 * 刻意不用 `split('\n')`：工具输出动辄几十 KB，切一遍就是一次整串复制，
 * 而消息流每来一个 delta 都要重算一次预览 —— 用 `indexOf` + 一次 `slice` 是 O(首行)。
 * @param text - 原文（可能多行）。
 * @param max - 首行最长多少字（超了加省略号）。
 * @returns 首行（已去首尾空白）。
 */
export function firstLine(text: string, max = 200): string {
  const end = text.indexOf('\n')
  const line = (end === -1 ? text : text.slice(0, end)).trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * 工具参数在明细里该叫什么。
 *
 * 「参数：ls -la」这种写法在 bash 上很别扭（那是**命令**不是参数），
 * 所以按工具类别给一个准确的抬头；认不出来的一律叫「参数」，不硬编。
 * @param name - 工具全名。
 * @returns 明细里参数行的抬头（不含冒号）。
 */
export function argsLabel(name: string): string {
  if (name === 'bash' || name.startsWith('job_')) return '命令'
  if (name === 'read' || name === 'write' || name === 'edit' || name === 'read_image') return '路径'
  return '参数'
}

/**
 * 一个工具在同类里的展示顺序（`@` 候选菜单按它排）。
 *
 * 表里排过序的用表里的 order；没排过的（用户自己挂的 server）统一给 500，
 * 由调用方再用名字做稳定排序 —— 不这么排的话，「项目大厅」这种该排第一的入口
 * 会按英文字母序沉到列表最后。
 * @param name - 工具全名。
 * @returns 排序权重（越小越前）。
 */
export function toolOrder(name: string): number {
  const mcp = mcpParts(name)
  if (mcp !== null) return MCP_TOOLS[mcp.server]?.[mcp.tool]?.order ?? 500
  return BUILTIN[name]?.order ?? 500
}
