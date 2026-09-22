/**
 * 把「指令文本」渲染成带类型的片段（不同指令不同样式）。
 *
 * ## 为什么需要它
 *
 * 输入框里用 `/` `@` `#` 选出来的东西，落到会话记录里目前全是**一样的灰字**：
 * `/report`、`mcp__butian__butian_rank`、`app/cli/main.ts` 混在一句话里，
 * 扫一眼分不出哪个是命令、哪个是工具、哪个是文件 —— 而这些恰恰是「这条消息
 * 让 agent 干了什么」的关键信息。
 *
 * 所以这里做一件事：**识别文本里的指令 token，交给不同的样式渲染**。
 *
 * | 类型 | 识别规则 | 例子 |
 * | --- | --- | --- |
 * | 命令 | 词首的 `/名字`（词首见 {@link isBoundaryChar}） | `/report 某厂商` |
 * | 工具 | `mcp__<server>__<tool>`（也认裸的 `mcp__x`） | `mcp__butian__butian_rank` |
 * | 文件 | `#路径`，或**看起来像路径**的裸词 | `#app/cli/main.ts`、`app/desktop/host/index.ts` |
 * | 技能 | 「用 skill 工具加载 `<名字>`」里的名字 | 用 skill 工具加载 report |
 *
 * ## 两条刻意的判断
 *
 * 1. **只做「有把握」的识别**：`#` 前缀一律认；裸词必须**带扩展名且含 `/`**
 *    才当路径 —— 否则 `and/or`、`HTTP/2` 这种也会被染色，反而更乱。
 * 2. **不碰 Markdown**：助手正文走 Markdown 渲染（模型自己会用 `` ` `` 包住工具名）。
 *    这里只处理**纯文本**的地方：用户消息、目标调整、工具参数摘要、轨迹明细。
 *
 * @module Memento/desktop/renderer/src/components/rich-text-tokens
 */

/** 一个片段的类型。 */
export type TokenKind = 'text' | 'command' | 'tool' | 'file' | 'skill'

/** 切出来的一段。 */
export interface Token {
  readonly kind: TokenKind
  readonly value: string
}

/** 技能触发句：输入框选技能时插入的就是这个形态。 */
const SKILL_RE = /用\s*skill\s*工具加载\s+([A-Za-z0-9_-]{1,64})/

/** MCP 工具名（`mcp__server__tool`，server/tool 允许缺省）。 */
const TOOL_RE = /mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)?/

/**
 * 裸词是否**看起来像路径**。
 *
 * 判据：含 `/`、且最后一段带扩展名（或者以 `/` 结尾的目录）。
 * 这样 `app/cli/main.ts`、`./scripts/build.js` 会被认出来，
 * 而 `and/or`、`HTTP/2`、`24/7` 不会。
 * @param word - 候选词。
 * @returns 像路径就返回 `true`。
 */
export function looksLikePath(word: string): boolean {
  if (!word.includes('/')) return false
  if (!/^[A-Za-z0-9._@/-]+$/.test(word)) return false
  const tail = word.split('/').pop() ?? ''
  // 末尾一段有扩展名（`main.ts`），或者整词以 `/` 结尾（目录）
  return /\.[A-Za-z0-9]{1,8}$/.test(tail) || word.endsWith('/')
}

/**
 * 词边界字符：这些字符**后面**可以起一个新词。
 *
 * 三类：
 *   ① 空白 / 左右括号引号（`(` `[` `{` `「` `【` `《` `"` `'` `\``）
 *   ② 中英标点（`，` `。` `、` `；` `：` `！` `？` `…` `—` `·`）
 *   ③ **中日韩文字** —— 这一条是必须的：中文/日文/韩文**不用空格分词**，
 *      所以「前面是个汉字」恰恰说明这里是一个新词的开始。最早漏了这条，
 *      结果 `帮我把#composer` 里的 `#` 永远弹不出菜单（用户就是这么打字的），
 *      会话记录里的 `见app/cli/main.ts` 也不会染色 —— 真踩过。
 *
 * 刻意**不含** `:` `/` `#` `-` 这些「看着像分隔符」的字符：`https://x.com/a.md`
 * 里的 `/a.md`、`C#code` 里的 `#code` 都紧跟在非边界字符后面，正是要被排除的情形。
 *
 * ⚠️ 这份判据同时被**输入框的触发符规则**（`editor/triggers.ts`）和**消息记录的
 * token 染色**（本模块 {@link tokenizeRichText}）使用：输入框里认出来的东西，落到
 * 会话记录里必须还是同一种颜色。改这里等于两边一起改，别只改一边。
 *
 * @param char - 待判定的单个字符（空串视为非边界）。
 * @returns 是边界返回 `true`。
 */
export function isBoundaryChar(char: string): boolean {
  if (char === '') return false
  return BOUNDARY_RE.test(char)
}

/** 见 {@link isBoundaryChar} 的三类。 */
const BOUNDARY_RE = /[\s([{（「【《〈"'`，。、；：！？…—·]|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * 这个位置是不是**一个词的真正开头**。
 *
 * 为什么必须有这条：扫描是逐字符推进的，中途会停在词内部（例如
 * `https://example.com/x.md` 里的 `xample.com/x.md`），那时「词前不是 `:` 也不是 `/`」
 * 这类宽松条件照样成立 —— 结果就是把 URL 吃掉一截染成文件 chip（真踩过）。
 * 所以判据收紧成「行首 / 空白 / 左括号引号」这三类真边界。
 *
 * @param text - 全文。
 * @param index - 当前位置。
 * @returns 是词首返回 `true`。
 */
export function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  return isBoundaryChar(text[index - 1] ?? '\n')
}

/**
 * 把纯文本切成带类型的片段。
 *
 * 实现是「一次线性扫描」：在每个位置按优先级试四种规则，命中就产出一个 token，
 * 否则累积到普通文本里。这样比多轮正则替换好推理 —— 也不会出现
 * 「替换出来的内容又被下一条规则匹配一次」的连锁问题。
 *
 * @param text - 原始纯文本。
 * @returns 片段数组（相邻的普通文本会合并；空输入返回空数组）。
 */
export function tokenizeRichText(text: string): Token[] {
  const tokens: Token[] = []
  let plain = ''
  /** 把累积的普通文本收尾。 */
  const flush = (): void => {
    if (plain !== '') {
      tokens.push({ kind: 'text', value: plain })
      plain = ''
    }
  }
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)

    // ① 技能触发句（整句识别，避免名字被别的规则抢走）
    const skill = SKILL_RE.exec(rest)
    if (skill !== null && skill.index === 0 && skill[1] !== undefined) {
      flush()
      const whole = skill[0]
      // 前半句（「用 skill 工具加载 」）保持普通文本，只把技能名做成 chip
      const nameAt = whole.lastIndexOf(skill[1])
      if (nameAt > 0) tokens.push({ kind: 'text', value: whole.slice(0, nameAt) })
      tokens.push({ kind: 'skill', value: skill[1] })
      index += whole.length
      continue
    }

    // ② MCP 工具名
    const tool = TOOL_RE.exec(rest)
    if (tool !== null && tool.index === 0 && isWordBoundary(text, index)) {
      flush()
      tokens.push({ kind: 'tool', value: tool[0] })
      index += tool[0].length
      continue
    }

    // ③ `/命令`：必须紧跟行首或空白（与输入框触发规则一致）
    if (rest[0] === '/' && isWordBoundary(text, index) && /^\/[a-z0-9]/.test(rest)) {
      const matched = /^\/[a-z0-9][a-z0-9-]{0,40}/.exec(rest)
      if (matched !== null) {
        flush()
        tokens.push({ kind: 'command', value: matched[0] })
        index += matched[0].length
        continue
      }
    }

    // ④ `#路径`（同样要求词首：`C#code` 里的 `#code` 不是引用）
    if (rest[0] === '#' && isWordBoundary(text, index)) {
      const matched = /^#[A-Za-z0-9._@/-]{2,200}/.exec(rest)
      if (matched !== null) {
        flush()
        tokens.push({ kind: 'file', value: matched[0] })
        index += matched[0].length
        continue
      }
    }

    // ⑤ 裸词里看起来像路径的（工具参数摘要、粘贴进来的路径）
    //
    // ⚠️ 必须要求**词首**（{@link isWordBoundary}）：否则从 `https://example.com/x.md`
    // 中间切出来的 `xample.com/x.md` 也会被当成路径。
    if (isWordBoundary(text, index) && /[A-Za-z0-9._@/-]/.test(rest[0] ?? '')) {
      const word = /^[A-Za-z0-9._@/-]+/.exec(rest)?.[0] ?? ''
      if (word !== '' && looksLikePath(word)) {
        flush()
        tokens.push({ kind: 'file', value: word })
        index += word.length
        continue
      }
    }

    plain += rest[0] ?? ''
    index += 1
  }
  flush()
  return tokens
}
