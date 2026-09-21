/**
 * 轨迹视图：一个回合里 agent 做过的每一步（顺序 + 状态 + 明细）。
 *
 * ## 为什么不用官方构件了
 *
 * 这里原本摆的是 Beautiful UI 的 `TaskRows`（它的「任务清单」构件）。功能上对得上，
 * 但画出来不对味，用户一眼就点了出来：
 *   - 左边一枚**绿色对勾徽章** + 绿色「完成」药丸 —— 那是 TODO 清单的语汇，
 *     而这个界面里绿色只表示「diff 新增行」，突然冒出绿勾像是另一个 App 塞进来的；
 *   - 一行 44px 的 surface 卡片，图标 + 标题 + 数字 + 药丸 + 箭头全挤在一行里，
 *     和消息流的行高（24 / 28px）差了一倍，一屏看不了几步，格式也不统一。
 *
 * 现在改成**自绘时间线**，语汇和消息流里完全一致：
 *   - 左侧一条竖轨 + 6px 圆点表状态（灰=已完成、紫=进行中、红=失败），不要徽章不要药丸；
 *   - 行高 28px、字号 12.5px、圆角 `--radius-control`，与工具行一模一样；
 *   - 角色、名称、参数、结果各占一列，列的宽度固定 —— 上下对齐，扫读不跳；
 *   - 点一行展开**完整输出**（不截断、按原文换行、超长自己滚），首次展开才挂载。
 *
 * 入场动画保留：每行 `fade-up` 依次浮现，展开仍是 `grid-template-rows` 的 0fr→1fr。
 *
 * @module YuanMy/desktop/renderer/components/trace
 */

import { memo, useState, type ReactElement } from 'react'
import { toolDisplay } from '../tool-names.ts'
import type { TraceStep } from '../use-agent.ts'

/** 每一步在左列显示的**角色**（工具步骤另有中文功能名，见 `title()`）。 */
const KIND_LABEL: Record<TraceStep['kind'], string> = {
  user: '你',
  reasoning: '推理',
  text: '回复',
  tool: '工具',
  note: '提示',
  // 中途的目标调整：单独一类，别和「提示」混在一起
  steer: '目标调整',
}

/**
 * 一行的主文案：工具步骤给中文功能名（原始工具名留在明细里）。
 *
 * 其余步骤返回空串 —— 角色已经在左边那一列说了（「你」「回复」「推理」），
 * 再来一个同样的词就是重复（第一版就是这么写的，量出来是「你 | 你 | …」）。
 */
function title(step: TraceStep): string {
  if (step.kind !== 'tool') return ''
  return toolDisplay(step.label).label
}

/** 无障碍与 hover 文案：非工具步骤没有主文案，退回角色名。 */
function nameOf(step: TraceStep): string {
  return title(step) === '' ? KIND_LABEL[step.kind] : title(step)
}

/** 状态位的语义（决定圆点颜色与呼吸动画）。 */
function tone(step: TraceStep, index: number, total: number, busy: boolean): 'done' | 'running' | 'failed' {
  if (step.isError) return 'failed'
  return busy && index === total - 1 ? 'running' : 'done'
}

const Chevron = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
)

/** 一行轨迹：`key` 用步骤 id（同一回合里可能出现两个同名工具）。 */
const TraceRow = memo(function TraceRow({
  step,
  index,
  total,
  busy,
}: {
  readonly step: TraceStep
  readonly index: number
  readonly total: number
  readonly busy: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  /* 首次展开才把明细挂进 DOM：轨迹可能有上百步、每步几十 KB 输出，
     全量渲染会让切到轨迹页明显卡一下。 */
  const [everOpen, setEverOpen] = useState(false)
  const state = tone(step, index, total, busy)
  return (
    <div className="trace__row" style={{ animation: `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${String(Math.min(index, 12) * 40)}ms both` }}>
      <button
        type="button"
        className="trace__head"
        aria-expanded={open}
        aria-label={open ? `收起「${nameOf(step)}」的明细` : `展开「${nameOf(step)}」的明细`}
        onClick={() => {
          setOpen((current) => !current)
          setEverOpen(true)
        }}
      >
        <span className="trace__rail" aria-hidden="true">
          <span className={`trace__dot trace__dot--${state}`} />
        </span>
        <span className="trace__kind">{KIND_LABEL[step.kind]}</span>
        {title(step) !== '' && <span className="trace__label">{title(step)}</span>}
        {step.token !== '' && (
          <span className="trace__chip" title={step.token}>
            {step.token}
          </span>
        )}
        <span className={`trace__summary${state === 'failed' ? ' trace__summary--failed' : ''}`} title={step.preview}>
          {step.preview}
        </span>
        <span className="trace__chevron" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          {Chevron}
        </span>
      </button>
      <div
        className="trace__detail-grid"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="trace__detail-clip">
          {everOpen && <div className="trace__detail">{step.detail}</div>}
        </div>
      </div>
    </div>
  )
})

export interface TraceViewProps {
  readonly steps: readonly TraceStep[]
  /** 会话是否为空（空态文案不同）。 */
  readonly empty: boolean
  /** 这一回合是否还在跑（最后一步显示进行中）。 */
  readonly busy: boolean
}

export const TraceView = memo(function TraceView({ steps, empty, busy }: TraceViewProps): ReactElement {
  if (empty) {
    return <div className="trace__empty">还没有轨迹：发一条消息，这里会按顺序列出 agent 的每一步。</div>
  }
  return (
    <div className="trace">
      {steps.map((step, index) => (
        <TraceRow key={step.id} step={step} index={index} total={steps.length} busy={busy} />
      ))}
    </div>
  )
})
