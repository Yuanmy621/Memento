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
 * ## 折叠一行、展开全文（改过一次）
 *
 * 早先折叠时行尾只显示参数的**第一个词**（`args.split(' ')[0]`，bash 上就是 `cd`），
 * 展开后又只有「首行摘要 + 省略号」—— 几十行的 bash 输出**哪里都看不到**。
 * 现在：
 *   - 行尾灰字 = 输出的**首行**（`preview`），一眼知道这一步干了什么、出了什么；
 *   - chip = **完整参数**（bash 就是整条命令，CSS 里超宽才省略，hover 有 title）；
 *   - 点行 = 展开**完整输出**（不截断、按原文换行、超过 320px 自己滚）。
 *
 * @module YuanMy/desktop/renderer/components/tool-run
 */

import { memo, useMemo, type ReactElement } from 'react'
import ToolChips, { type ToolDetailLine, type ToolStep } from '../ui/beautifului/primitives/ToolChips.tsx'
import { argsLabel, firstLine, toolDisplay } from '../tool-names.ts'
import { fileActionOf } from '../use-agent.ts'
import type { ToolBlock } from '../use-agent.ts'

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

/** 取一段文本的第一行非空内容（行尾那一行预览用它）。 */
function previewOf(block: ToolBlock): string {
  if (block.result === null) return ''
  const output = (block.output ?? '').trim()
  return firstLine(output === '' ? block.result : output)
}

/**
 * 把一个工具块映射成 ToolChips 的一行。
 * @param block - 会话里的工具块。
 * @returns 行数据。
 */
function toStep(block: ToolBlock): ToolStep {
  const display = toolDisplay(block.name)
  const args = block.args.trim()
  const output = (block.output ?? '').trim()
  const detail: ToolDetailLine[] = []
  // 参数行：chip 里宽度有限，这里给完整的一条（bash 的多行命令按原文换行显示）
  if (args !== '') detail.push({ text: `${argsLabel(block.name)}：${args}` })
  if (block.result === null) {
    detail.push({ text: '（运行中…）' })
  } else if (output !== '') {
    // 完整输出：不切行、不截断，交给明细框自己滚
    detail.push({ text: output })
  } else {
    detail.push({ text: block.result })
  }
  return {
    icon: iconOf(block.name),
    // 主文案：中文功能名（界面不该出现 `mcp__butian__butian_rank` 这种变量名）
    label: display.label,
    // chip：这一行「动了什么」——命令 / 路径 / 查询，等宽显示。
    // 多行参数（bash 里的 heredoc、带续行的命令）只取第一行：chip 是一行的高度，
    // 塞下整段会变成一团糊；完整的那份在明细的「命令：」里。
    chip: args === '' ? block.name : firstLine(args),
    mono: isMonoTool(block.name),
    detailMono: true,
    detail,
    // 行尾预览：输出的首行（`(N 行) exit 0` 这类摘要留在明细里看）
    preview: previewOf(block),
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
