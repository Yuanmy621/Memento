/**
 * 输入框里的三种「触发符」候选：菜单长什么样 + 候选从哪来。
 *
 * | 触发符 | 选什么 | chip 上显示 | 落库文本 |
 * | --- | --- | --- | --- |
 * | `/` | 用户命令 + 技能 | `/名字` / 技能名 | `/名字` / 「用 skill 工具加载 …」 |
 * | `@` | MCP 工具（按 server 分组） | 中文功能名（`补天 · 白帽排行`） | 「用 `mcp__butian__butian_rank` 工具：」 |
 * | `#` | 工作目录里的文件 | 相对路径 | 相对路径 |
 *
 * ## 分工
 *
 * - **触发与键盘**：交给 Tiptap 的 suggestion 插件（`editor/suggestions.ts`）。
 *   本模块只管「给一个触发符 + 查询词，返回候选」这件事，是纯函数。
 * - **选中后插什么**：候选自带 `kind` 与 `text`（`Mention`），由 composer 插成
 *   chip —— 不再往输入框里塞一段文本。所以这里**没有** `insert` 字段了：
 *   「显示什么」是 `label`，「落库什么」是 `text`。
 * - 「用 … 工具：」「用 skill 工具加载 …」这两句话是刻意保留的：它们是给**模型**
 *   看的明确指令（会话记录里的 token 染色也认这两种句式，见 rich-text-tokens.ts）。
 *
 * @module YuanMy/desktop/renderer/src/components/mention-menu
 */

import type { ReactElement } from 'react'
import type { ChipAttrs } from './editor/chip.ts'
import { commandChip, fileChip, skillChip, toolChip } from './editor/chip-text.ts'
import { toolDisplay, toolOrder } from '../tool-names.ts'
import type { Trigger } from './editor/triggers.ts'
import type { CommandBrief, FileBrief, HostToolInfo, SkillBrief } from '../use-agent.ts'

/** 一条候选 —— 它就是「还没插进输入框的那个 chip」，加上菜单要用的说明文字。 */
export interface Mention {
  /** 稳定 key。 */
  readonly key: string
  /** 选中后插进输入框的 chip（显示文字与落库文字都在里面）。 */
  readonly chip: ChipAttrs
  /** 菜单里显示的名字（省略则用 `chip.label`）。 */
  readonly label?: string
  /** 右侧说明。 */
  readonly hint: string
  /** 分组名（`@` 按 MCP server 分组时用）。 */
  readonly group?: string
}

/** 候选的四个数据源。 */
export interface MentionsData {
  readonly commands: readonly CommandBrief[]
  readonly skills: readonly SkillBrief[]
  readonly tools: readonly HostToolInfo[]
  readonly files: readonly FileBrief[]
}

/**
 * 按触发符组装候选列表。
 *
 * @param trigger - 触发符。
 * @param query - 已输入的部分。
 * @param data - 四类数据源。
 * @param limit - 最多返回多少条（菜单不做虚拟滚动，多了反而难找）。
 * @returns 过滤后的候选。
 */
export function buildMentions(
  trigger: Trigger,
  query: string,
  data: MentionsData,
  limit = 24,
): Mention[] {
  const needle = query.toLowerCase()
  const hit = (text: string): boolean => needle === '' || text.toLowerCase().includes(needle)

  if (trigger === '/') {
    const commands = data.commands
      .filter(item => hit(item.name) || hit(item.description))
      .map(item => ({
        key: `cmd:${item.name}`,
        chip: commandChip(item.name),
        hint: item.description === '' ? '命令' : item.description,
        group: '命令',
      }))
    const skills = data.skills
      .filter(item => hit(item.name) || hit(item.description))
      .map(item => ({
        key: `skill:${item.name}`,
        chip: skillChip(item.name),
        hint: `${item.invocation === 'command' ? '命令专用技能' : '全局技能'} · ${item.description}`,
        group: '技能',
      }))
    return [...commands, ...skills].slice(0, limit)
  }

  if (trigger === '@') {
    return data.tools
      .filter(item => item.name.startsWith('mcp__'))
      .map((item) => ({ item, display: toolDisplay(item.name, item.description) }))
      // 匹配三种写法：原名（`butian`）、中文名（`排行`）、说明里的词
      .filter(({ item, display }) => hit(item.name) || hit(display.label) || hit(display.note))
      // 与侧栏工具清单同一套顺序（否则同一条工具在两处的名次不一样）
      .sort((a, b) => toolOrder(a.item.name) - toolOrder(b.item.name) || a.item.name.localeCompare(b.item.name))
      .map(({ item, display }) => ({
        key: `tool:${item.name}`,
        // 菜单里挂在「补天」分组下，所以只显示功能名；chip 插进输入框后会离开分组，
        // 那时才需要带上 server 前缀（见下面 chip 的 label）
        label: display.label,
        chip: toolChip(item.name, `${display.group} · ${display.label}`),
        // 说明用中文描述（服务端没给中文就留空，不硬塞英文）
        hint: display.note,
        group: display.group,
      }))
      .slice(0, limit)
  }

  return data.files
    .filter(item => hit(item.path))
    .map(item => ({
      key: `file:${item.path}`,
      chip: fileChip(item.path),
      hint: '文件',
      group: '文件',
    }))
    .slice(0, limit)
}

export interface MentionMenuProps {
  /** 菜单顶部的一行说明（触发符名字 + 键盘提示）。 */
  readonly title: string
  readonly mentions: readonly Mention[]
  readonly active: number
  readonly onPick: (mention: Mention) => void
  readonly onHover: (index: number) => void
}

/** 候选菜单本体（纯展示，状态在 `SuggestController` 里）。 */
export function MentionMenu(props: MentionMenuProps): ReactElement | null {
  if (props.mentions.length === 0) return null
  let lastGroup = ''
  return (
    <div className="mention" role="listbox">
      <div className="mention__title">{props.title}</div>
      {props.mentions.map((mention, index) => {
        const header = mention.group !== undefined && mention.group !== lastGroup ? mention.group : null
        lastGroup = mention.group ?? lastGroup
        return (
          <div key={mention.key}>
            {header !== null && <div className="mention__group">{header}</div>}
            <button
              type="button"
              role="option"
              aria-selected={index === props.active}
              data-kind={mention.chip.kind}
              className={`mention__item${index === props.active ? ' mention__item--active' : ''}`}
              onMouseEnter={() => { props.onHover(index) }}
              // onMouseDown 而不是 onClick：click 之前编辑器会先失焦，光标位置就丢了
              onMouseDown={(event) => { event.preventDefault(); props.onPick(mention) }}
            >
              <span className="mention__label">{mention.label ?? mention.chip.label}</span>
              <span className="mention__hint">{mention.hint}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
