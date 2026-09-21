/**
 * 一次回合里的工具调用：Beautiful UI 的 {@link ToolChips} + 我们的数据映射。
 *
 * 上游那个构件是按演示数据写的（`step` 每 700ms 放一行、页脚永远是「+N more」），
 * 这里用它的 `live` / `compact` 开关（vendored 时加的补丁）把它变成**真实数据驱动**：
 *   - 行数、每行图标与文案都来自 `ToolBlock[]`；
 *   - 主文案用**中文功能名**（`toolDisplay()`），原来那种 `mcp__butian__butian_rank`
 *     只在展开的明细里出现（排查日志时还对得上）；
 *   - 点 chip = 打开右侧预览（文件类工具），行尾的箭头才是展开明细 ——
 *     原来文件卡片上「点主体预览」的能力因此没丢。
 *
 * @module YuanMy/desktop/renderer/components/tool-run
 */

import { memo, useMemo, type ReactElement } from 'react'
import ToolChips, { type ToolStep } from '../ui/beautifului/primitives/ToolChips.tsx'
import { toolDisplay } from '../tool-names.ts'
import { fileActionOf } from '../use-agent.ts'
import type { ToolBlock } from '../use-agent.ts'

/** 明细里最多展示多少行（多了会淹没消息流；要全文去右侧预览看）。 */
const DETAIL_LINES = 8

/**
 * 工具名 → ToolChips 的图标键（它只认 4 个内置图标：think / write / run / read）。
 * @param name - 工具原名。
 * @returns 图标键。
 */
function iconOf(name: string): string {
  if (name === 'write' || name === 'edit' || name.endsWith('_write') || name.endsWith('_edit')) return 'write'
  if (name === 'bash' || name.startsWith('job_')) return 'run'
  if (name === 'read' || name === 'read_image' || name === 'glob' || name === 'grep' || name === 'tree') return 'read'
  return 'think'
}

/** 用等宽字体的那几类工具（路径 / 命令 / 代码）。 */
function isMonoTool(name: string): boolean {
  return name === 'bash' || name === 'read' || name === 'write' || name === 'edit'
    || name === 'glob' || name === 'grep' || name === 'tree' || name === 'read_image'
}

/**
 * 把一个工具块映射成 ToolChips 的一行。
 * @param block - 会话里的工具块。
 * @param onPreview - 点 chip 的动作（文件类工具用它打开预览）。
 * @returns 行数据。
 */
function toStep(block: ToolBlock): ToolStep & { onActivate?: () => void } {
  const display = toolDisplay(block.name)
  const args = block.args.trim()
  const lines: { text: string; tone?: 'add' }[] = []
  if (args !== '') lines.push({ text: `参数：${args}` })
  if (block.result === null) {
    lines.push({ text: '（运行中…）' })
  } else {
    const rows = block.result.split('\n').filter((line) => line.trim() !== '')
    for (const line of rows.slice(0, DETAIL_LINES)) {
      lines.push(line.startsWith('+') ? { text: line, tone: 'add' } : { text: line })
    }
    if (rows.length > DETAIL_LINES) lines.push({ text: `…（还有 ${String(rows.length - DETAIL_LINES)} 行，打开右侧预览看全文）` })
  }
  return {
    icon: iconOf(block.name),
    // 主文案：中文功能名（界面不该出现 `mcp__butian__butian_rank` 这种变量名）
    label: display.label,
    // chip：这一行「动了什么」——路径 / 命令 / 查询，等宽显示
    chip: args === '' ? block.name : args.split(' ')[0] ?? block.name,
    mono: isMonoTool(block.name),
    detailMono: true,
    detail: lines,
  }
}

export interface ToolRunProps {
  readonly blocks: readonly ToolBlock[]
  /** 点 chip（对文件类工具就是「打开预览」）。 */
  readonly onPreview: (path: string) => void
  /** 这一回合是否还在跑（决定页眉文案）。 */
  readonly running: boolean
}

export const ToolRun = memo(function ToolRun({ blocks, onPreview, running }: ToolRunProps): ReactElement | null {
  const steps = useMemo(() => blocks.map(toStep), [blocks])
  if (blocks.length === 0) return null
  const pending = blocks.filter((block) => block.result === null).length
  return (
    <ToolChips
      live
      compact
      steps={steps}
      // diff 页脚要的是「文件 + 增删行数」，我们的数据里没有，整块不渲染
      diffs={[]}
      labels={{
        header: running && pending > 0
          ? `${String(blocks.length)} 次工具调用 · 正在跑 ${String(pending)} 个`
          : `${String(blocks.length)} 次工具调用`,
      }}
      // 点 chip：认得出文件路径就打开右侧预览（原来文件卡片「点主体预览」的能力）
      onChipActivate={(index) => {
        const block = blocks[index]
        if (block === undefined) return
        const file = fileActionOf(block.name, block.args)
        if (file !== undefined) onPreview(file.path)
      }}
      className="tool-run"
    />
  )
})
