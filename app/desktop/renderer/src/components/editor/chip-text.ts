/**
 * 每种 chip「显示什么、落库什么」—— 四行规则，只此一处。
 *
 * 命令与文件 chip 的 label 与 text 相同；技能 chip 落 `用 skill 工具加载 <名字> 后按它执行：`，
 * 工具 chip 落 `用 <原名> 工具：`，而显示的是中文功能名（见 `tool-names.ts`）—— 那是说给
 * 模型听的明确指令，模型只认原名。这两种句式同时被 `rich-text-tokens.ts` 认出来染色。
 * 只 `import type`，不 import `@tiptap/core`，真值表脚本才能在 Node 里直接引用它。
 *
 * @module Memento/desktop/renderer/src/components/editor/chip-text
 */

import type { ChipAttrs } from './chip.ts'

/**
 * 命令 chip；`name` 不含 `/`。
 */
export function commandChip(name: string): ChipAttrs {
  // 命令就是「整条消息以 /名字 开头」，显示与落库一致。
  return { kind: 'command', label: `/${name}`, text: `/${name}` }
}

/**
 * 技能 chip。
 */
export function skillChip(name: string): ChipAttrs {
  return { kind: 'skill', label: name, text: `用 skill 工具加载 ${name} 后按它执行：` }
}

/**
 * MCP 工具 chip：`label` 显示中文功能名（「补天 · 项目大厅」），`text` 落原名加一句指令 ——
 * 模型只认原名；`label` 省略时退回 `name`。
 */
export function toolChip(name: string, label?: string): ChipAttrs {
  return { kind: 'tool', label: label ?? name, text: `用 ${name} 工具：` }
}

/**
 * 文件 chip；`path` 是工作目录相对路径。
 */
export function fileChip(path: string): ChipAttrs {
  // agent 的 read / 文件卡片都认相对路径，直接落相对路径。
  return { kind: 'file', label: path, text: path }
}
