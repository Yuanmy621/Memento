/**
 * 把「指令文本」渲染成带类型的片段：命令 `/名字`、工具 `mcp__<server>__<tool>`、
 * 文件 `#路径` 或看起来像路径的裸词、技能名。
 *
 * 判定只做有把握的部分：`#` 前缀一律认，裸词要含 `/` 且末段带扩展名才算路径，否则
 * `and/or`、`HTTP/2` 也会被染色。词首可以紧跟中日韩文字 —— 中文不用空格分词，「前面是个
 * 汉字」正说明这里起了一个新词（见 {@link isBoundaryChar}）。只处理纯文本，不碰 Markdown。
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
 * 裸词是否看起来像路径：含 `/`，且最后一段带扩展名，或以 `/` 结尾的目录。
 * 这样 `app/cli/main.ts`、`./scripts/build.js` 会被认出来，而 `and/or`、`HTTP/2` 不会。
 */
export function looksLikePath(word: string): boolean {
  if (!word.includes('/')) return false
  if (!/^[A-Za-z0-9._@/-]+$/.test(word)) return false
  const tail = word.split('/').pop() ?? ''
  // 末尾一段有扩展名（`main.ts`），或者整词以 `/` 结尾（目录）
  return /\.[A-Za-z0-9]{1,8}$/.test(tail) || word.endsWith('/')
}

/**
 * 词边界字符：这些字符后面可以起一个新词；空串按非边界处理。
 *
 * 含空白、括号引号、中英标点与中日韩文字；不含 `:` `/` `#` `-`。
 * 输入框触发符规则（`editor/triggers.ts`）与消息记录染色共用这一份判据，改这里等于两边一起改。
 */
export function isBoundaryChar(char: string): boolean {
  if (char === '') return false
  return BOUNDARY_RE.test(char)
}

/** 见 {@link isBoundaryChar} 的三类。 */
const BOUNDARY_RE = /[\s([{（「【《〈"'`，。、；：！？…—·]|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * 这个位置是不是一个词的真正开头：行首，或前一个字符是边界字符。
 *
 * 扫描是逐字符推进的，中途会停在词内部（`https://example.com/x.md` 里的 `xample.com/x.md`），
 * 不作词首判定就会把 URL 吃掉一截染成文件 chip。
 */
export function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  return isBoundaryChar(text[index - 1] ?? '\n')
}

/**
 * 把纯文本切成带类型的片段：一次线性扫描，在每个位置按优先级试四种规则。
 * 比多轮正则替换好推理 —— 不会出现「替换出来的内容又被下一条规则匹配一次」。
 * 相邻的普通文本会合并，空输入返回空数组。
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

    // 技能触发句整句识别，避免名字被别的规则抢走
    const skill = SKILL_RE.exec(rest)
    if (skill !== null && skill.index === 0 && skill[1] !== undefined) {
      flush()
      const whole = skill[0]
      // 前半句保持普通文本，只把技能名做成 chip
      const nameAt = whole.lastIndexOf(skill[1])
      if (nameAt > 0) tokens.push({ kind: 'text', value: whole.slice(0, nameAt) })
      tokens.push({ kind: 'skill', value: skill[1] })
      index += whole.length
      continue
    }

    // MCP 工具名
    const tool = TOOL_RE.exec(rest)
    if (tool !== null && tool.index === 0 && isWordBoundary(text, index)) {
      flush()
      tokens.push({ kind: 'tool', value: tool[0] })
      index += tool[0].length
      continue
    }

    // `/命令`：词首或空白之后（与输入框触发规则一致）
    if (rest[0] === '/' && isWordBoundary(text, index) && /^\/[a-z0-9]/.test(rest)) {
      const matched = /^\/[a-z0-9][a-z0-9-]{0,40}/.exec(rest)
      if (matched !== null) {
        flush()
        tokens.push({ kind: 'command', value: matched[0] })
        index += matched[0].length
        continue
      }
    }

    // `#路径`：同样要求词首，`C#code` 里的 `#code` 不是引用
    if (rest[0] === '#' && isWordBoundary(text, index)) {
      const matched = /^#[A-Za-z0-9._@/-]{2,200}/.exec(rest)
      if (matched !== null) {
        flush()
        tokens.push({ kind: 'file', value: matched[0] })
        index += matched[0].length
        continue
      }
    }

    // 裸词里看起来像路径的（工具参数摘要、粘贴进来的路径）。
    // 要求词首（{@link isWordBoundary}），否则 `https://example.com/x.md` 中间切出来的
    // `xample.com/x.md` 也会被当成路径。
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
