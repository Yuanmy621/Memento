/**
 * 轨迹视图：把会话摊平成一条**按角色分色**的时间线。
 *
 * 和「对话」的分工：对话是给人读的结果，轨迹是给人查的过程 ——
 * 「它到底读了哪个文件、从哪一步开始跑偏」。所以这里不追求 Markdown 排版，
 * 而是追求**扫一眼就能分出谁在说话**：
 *
 *   你  ── 右侧、蓝色、引用块
 *   助手回复 ── 左侧、亮色正文
 *   推理   ── 更淡、斜体、默认折叠（思考过程读的人少，但丢了更麻烦）
 *   工具   ── 卡片 + 等宽参数，失败标红并露出错误
 *   提示 / 目标调整 ── 系统口吻的窄条
 *
 * 每一行左边是「轨道 + 节点」：一条竖线把整段过程串起来，节点里放该角色的图标
 * （图标来自 lucide，见 `icons.tsx`）。长内容默认截断，右上角一个「展开」按钮 ——
 * 一份 200 行的报告不该在轨迹里顶掉后面十几步。
 *
 * 数据由 `use-agent.ts` 的 `traceSteps()` 纯函数产出（可单测）。
 *
 * @module YuanMy/desktop/renderer/components/trace
 */

import { memo, useState, type ReactElement } from 'react'
import type { TraceStep } from '../use-agent.ts'
import { RichText } from './rich-text.tsx'
import {
  IconBug, IconGoal, IconNote, IconReasoning, IconReply, IconShell, IconTool, IconUser,
} from '../icons.tsx'

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

/**
 * 每个角色一个图标。
 *
 * 「工具」再多分一层：命令行类工具用终端图标，其它用扳手 —— 轨迹里
 * `shell` 和 `read_file` 差别很大，图标不同扫起来快得多。
 */
function iconFor(step: TraceStep): ReactElement {
  switch (step.kind) {
    case 'user': return <IconUser size={12} />
    case 'reasoning': return <IconReasoning size={12} />
    case 'text': return <IconReply size={12} />
    case 'note': return step.isError ? <IconBug size={12} /> : <IconNote size={12} />
    case 'steer': return <IconGoal size={12} />
    default: return step.label.startsWith('shell') ? <IconShell size={12} /> : <IconTool size={12} />
  }
}

/** 超过这个长度才给「展开」按钮：短的没必要多一次点击。 */
const CLAMP_AT = 220

/** 一步 = 一行。抽成子组件是为了让「展开」状态各自独立（不必在父层维护一张表）。 */
const TraceRow = memo(function TraceRow({ step, index }: {
  readonly step: TraceStep
  readonly index: number
}): ReactElement {
  const [open, setOpen] = useState(false)
  const long = step.detail.length > CLAMP_AT
  return (
    <li className={`trace__step trace__step--${step.kind}${step.isError ? ' trace__step--error' : ''}`}>
      <span className="trace__rail" aria-hidden="true">
        <span className="trace__node">{iconFor(step)}</span>
      </span>
      <div className="trace__card">
        <div className="trace__head">
          <span className="trace__role">{KIND_LABEL[step.kind]}</span>
          <span className="trace__label">{step.label}</span>
          {step.isError && <span className="trace__flag">失败</span>}
          <span className="trace__spacer" />
          <span className="trace__seq">#{String(index + 1)}</span>
          {long && (
            <button
              type="button"
              className="trace__toggle no-drag"
              aria-expanded={open}
              onClick={() => { setOpen(!open) }}
            >
              {open ? '收起' : '展开'}
            </button>
          )}
        </div>
        <div className={`trace__detail${long && !open ? ' trace__detail--clamp' : ''}`}>
          <RichText text={step.detail} />
        </div>
      </div>
    </li>
  )
})

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
    <ol className="trace">
      {steps.map((step, index) => (
        <TraceRow key={step.id} step={step} index={index} />
      ))}
    </ol>
  )
})
