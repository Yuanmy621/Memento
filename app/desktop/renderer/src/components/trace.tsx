/**
 * 轨迹视图：一个回合里 agent 做过的每一步。
 *
 * 构件用 Beautiful UI 的 {@link TaskRows}（`primitives/TaskRows.tsx`）——它就是
 * 「带状态的步骤清单」：左边是一个状态位（转圈 / 绿勾 / 红叉）+ 右边的进度药丸，
 * 点一行展开细节。正好对上轨迹要的三件事：**顺序、状态、每步的明细**。
 *
 * 我们只做数据映射（`traceSteps()` 的产物 → TaskRow）：
 *   - `label` 前面带上角色（「工具 · bash」），因为 TaskRows 本身没有角色分色；
 *   - `status`：失败 → `failed`（红），进行中的最后一步 → `running`（转圈），其余 `done`；
 *   - `details`：把一步的明细按行拆开（每行截断，长内容留在对话/预览里看）。
 *
 * ⚠️ vendored 补丁加了 `failed` 状态与 `live`（关演示时序）两个开关，见那个文件顶部。
 *
 * @module YuanMy/desktop/renderer/components/trace
 */

import { memo, type ReactElement } from 'react'
import TaskRows, { type TaskRow } from '../ui/beautifului/primitives/TaskRows.tsx'
import type { TraceStep } from '../use-agent.ts'

/** 每一步的角色标签。 */
const KIND_LABEL: Record<TraceStep['kind'], string> = {
  user: '你',
  reasoning: '推理',
  text: '助手',
  tool: '工具',
  note: '提示',
  // 中途的目标调整：单独一类，别和 NOTE（系统提示）混在一起
  steer: '目标调整',
}

/** 明细最多拆几行、每行留多长（再多就去看对话或右侧预览）。 */
const DETAIL_LINES = 6
const DETAIL_CHARS = 160

/**
 * 一步 → 一行 TaskRow。
 * @param step - 轨迹步骤。
 * @param index - 它在整段轨迹里的下标（决定「是不是最后一步」）。
 * @param total - 总步数。
 * @param busy - 这一回合是不是还在跑。
 * @returns TaskRows 的行数据。
 */
function toRow(step: TraceStep, index: number, total: number, busy: boolean): TaskRow {
  const flat = step.detail.replace(/\s+/g, ' ').trim()
  const lines = step.detail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, DETAIL_LINES)
    .map((line) => ({ label: line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS)}…` : line, meta: '' }))
  return {
    key: step.id,
    // 角色 + 标签：TaskRows 没有角色分色，所以把角色写进文案里
    label: `${KIND_LABEL[step.kind]} · ${step.label}`,
    amount: flat.length > 52 ? `${flat.slice(0, 52)}…` : flat,
    status: step.isError ? 'failed' : busy && index === total - 1 ? 'running' : 'done',
    step: index + 1,
    details: lines,
  }
}

export interface TraceViewProps {
  readonly steps: readonly TraceStep[]
  /** 会话是否为空（空态文案不同）。 */
  readonly empty: boolean
  /** 这一回合是否还在跑（最后一步显示转圈）。 */
  readonly busy: boolean
}

export const TraceView = memo(function TraceView({ steps, empty, busy }: TraceViewProps): ReactElement {
  if (empty) {
    return <div className="trace__empty">还没有轨迹：发一条消息，这里会按顺序列出 agent 的每一步。</div>
  }
  const rows = steps.map((step, index) => toRow(step, index, steps.length, busy))
  return (
    <div className="trace">
      <TaskRows
        live
        variant="List"
        rows={rows}
        className="trace__tasks"
        labels={{ completed: '完成', failed: '失败' }}
      />
    </div>
  )
})
