/**
 * 每种 chip「显示什么、落库什么」—— 四行规则，只此一处。
 *
 * | 类型 | 显示（label） | 落到会话记录（text） |
 * | --- | --- | --- |
 * | 命令 | `/report` | `/report` |
 * | 技能 | `report` | `用 skill 工具加载 report 后按它执行：` |
 * | 工具 | `补天 · 白帽排行`（中文功能名，见 `tool-names.ts`） | `用 mcp__butian__butian_rank 工具：` |
 * | 文件 | `app/cli/main.ts` | `app/cli/main.ts` |
 *
 * 技能与工具为什么要多那一句：它们是**说给模型听的**。只落一个名字，模型未必知道
 * 该去加载它/调用它；带上「用 … 工具：」这种句式，指令才明确。会话记录里的 token
 * 染色（`rich-text-tokens.ts`）也认这两种句式，所以颜色不会掉。
 *
 * 纯逻辑：只 `import type`，不 import `@tiptap/core`。这样真值表脚本（Node 直接跑）
 * 可以引用它，验证「chip 落库的文本，恰好会被记录端认成同一种颜色」。
 *
 * @module Memento/desktop/renderer/src/components/editor/chip-text
 */

import type { ChipAttrs } from './chip.ts'

/**
 * 命令 chip。
 * @param name - 命令名（不含 `/`）。
 * @returns chip 属性。
 */
export function commandChip(name: string): ChipAttrs {
  // 命令就是「整条消息以 /名字 开头」，显示与落库一致。
  return { kind: 'command', label: `/${name}`, text: `/${name}` }
}

/**
 * 技能 chip。
 * @param name - 技能名。
 * @returns chip 属性。
 */
export function skillChip(name: string): ChipAttrs {
  return { kind: 'skill', label: name, text: `用 skill 工具加载 ${name} 后按它执行：` }
}

/**
 * MCP 工具 chip。
 *
 * `label` 与 `text` 在这里是**故意分开**的典型例子：界面上显示中文功能名
 * （「补天 · 项目大厅」），落到会话记录里仍然是原名加一句指令 —— 模型只认原名。
 * @param name - 工具全名（`mcp__<server>__<tool>`）。
 * @param label - 界面上显示的名字（省略则退回原名）。
 * @returns chip 属性。
 */
export function toolChip(name: string, label?: string): ChipAttrs {
  return { kind: 'tool', label: label ?? name, text: `用 ${name} 工具：` }
}

/**
 * 文件 chip。
 * @param path - 工作目录相对路径。
 * @returns chip 属性。
 */
export function fileChip(path: string): ChipAttrs {
  // agent 的 read / 文件卡片都认相对路径，直接落相对路径。
  return { kind: 'file', label: path, text: path }
}
