/**
 * 轨迹视图：把会话摊平成「agent 做过的每一步」。
 *
 * 这是给调试看的tab，和「对话」的差别在于**不追求好看**：按发生顺序列出
 * 用户输入 / 推理 / 工具调用（含参数与结果）/ 回复 / 异常，等宽字体、
 * 单行截断、失败标红。定位「它到底读了哪个文件、哪一步开始跑偏」比翻气泡快。
 *
 * 数据由 `use-agent.ts` 的 `traceSteps()` 纯函数产出（可单测）。
 *
 * @module YuanMy/desktop/renderer/components/trace
 */

import { memo, type ReactElement } from 'react'
import type { TraceStep } from '../use-agent.ts'

/** 每一步左侧的类型标签。 */
const KIND_LABEL: Record<TraceStep['kind'], string> = {
  user: 'USER',
  reasoning: 'THINK',
  text: 'REPLY',
  tool: 'TOOL',
  note: 'NOTE',
}

export interface TraceViewProps {
  readonly steps: readonly TraceStep[]
  /** 会话是否为空（空态文案不同）。 */
  readonly empty: boolean
}

export const TraceView = memo(function TraceView({ steps, empty }: TraceViewProps): ReactElement {
  if (empty) {
    return <div className="trace__empty">还没有轨迹：发一条消息，这里会按顺序列出 agent 的每一步。</div>
  }
  return (
    <div className="trace">
      {steps.map((step) => (
        <div
          key={step.id}
          className={`trace__step${step.isError ? ' trace__step--error' : ''}`}
        >
          <span className={`trace__kind trace__kind--${step.kind}`}>{KIND_LABEL[step.kind]}</span>
          <span className="trace__body">
            <span className="trace__label">{step.label}</span>
            <span className="trace__detail">{step.detail}</span>
          </span>
        </div>
      ))}
    </div>
  )
})
