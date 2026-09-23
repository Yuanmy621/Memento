/**
 * 会话条目的渲染：用户气泡、系统提示、助手消息（推理 + 正文 + 工具/文件卡片 + 结论）。
 *
 * 助手消息的 blocks 有序，这里按顺序渲染，「先说话 → 调工具 → 再说话」的结构被如实还原，
 * 连续的工具块合成一次 `ToolRun`。每个条目的根元素带 `data-item-id`，右侧刻度滑杆
 * （`message-rail.tsx`）靠它把刻度与真实 DOM 对上；因为 `.messages__inner` 是 flex 列，
 * 这个属性只能加在根元素上，多包一层会弄乱 `align-self` 对齐。
 *
 * @module Memento/desktop/renderer/components/message
 */

import { memo, type ReactElement } from 'react'
import { RichText } from './rich-text.tsx'
import { Markdown } from '../markdown.tsx'
import { ToolRun } from './tool-run.tsx'
import { Reasoning } from './reasoning.tsx'
import { Shimmer } from '../ui/beautifului/atoms/Shimmer.tsx'
import { type AssistantItem, type Item, type ToolBlock, type TurnMeta, type TurnOutcome } from '../use-agent.ts'

/** 把结束原因翻成中文。 */
function describeOutcome(outcome: TurnOutcome): string {
  switch (outcome) {
    case 'completed': return '完成'
    case 'aborted': return '已中断'
    case 'max-tokens': return '达到输出上限，回答被截断'
    case 'error': return '失败'
    default: return '已结束'
  }
}

/** 助手消息的结论行文本。 */
function metaText(meta: TurnMeta | null): string {
  if (meta === null) return '正在生成…'
  const label = describeOutcome(meta.outcome)
  const suffix = meta.toolCalls > 0 ? ` · ${String(meta.toolCalls)} 次工具调用` : ''
  return meta.error === undefined ? `${label}${suffix}` : `${label}：${meta.error}`
}

/**
 * 助手消息的渲染顺序严格按 blocks 走（推理 → 正文 → 工具 → 再推理…）。
 * 工具块连续出现时合成一次 `ToolRun`；推理按真实位置渲染，不统一上提到消息顶部。
 */
const AssistantMessage = memo(function AssistantMessage({ item, onPreview }: {
  readonly item: AssistantItem
  readonly onPreview: (path: string) => void
}): ReactElement {
  const streaming = item.meta === null
  /** 把 blocks 切成「推理段 / 正文段 / 工具 run 段」，保持原有顺序。 */
  type Segment =
    | { kind: 'reasoning'; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'tools'; blocks: ToolBlock[] }
  const segments: Segment[] = []
  for (const block of item.blocks) {
    if (block.type === 'reasoning') {
      segments.push({ kind: 'reasoning', text: block.text })
      continue
    }
    if (block.type === 'text') {
      segments.push({ kind: 'text', text: block.text })
      continue
    }
    const last = segments[segments.length - 1]
    if (last !== undefined && last.kind === 'tools') last.blocks.push(block)
    else segments.push({ kind: 'tools', blocks: [block] })
  }

  return (
    <div className="msg--assistant" data-item-id={item.id}>
      {segments.map((segment, index) => {
        if (segment.kind === 'reasoning') {
          /**
           * 只有最后一段且回合还在跑时才算「正在思考」，否则前面每一段思考都会显示成流式。
           */
          const live = streaming && index === segments.length - 1
          return <Reasoning key={`reasoning-${String(index)}`} text={segment.text} live={live} />
        }
        if (segment.kind === 'tools') {
          return (
            <ToolRun
              key={`tools-${String(index)}`}
              blocks={segment.blocks}
              running={streaming}
              onPreview={onPreview}
            />
          )
        }
        return <Markdown key={`text-${String(index)}`}>{segment.text}</Markdown>
      })}

      <div
        className={`msg__meta${item.meta?.outcome === 'error' ? ' msg__meta--error' : ''}`}
      >
        {/* 还没跑完：`Shimmer` 做「活的」文字，比一串静止的「正在生成…」更像在动 */}
        {item.meta === null ? <Shimmer>正在生成…</Shimmer> : metaText(item.meta)}
        {streaming && item.blocks.length === 0 && ' …'}
      </div>
    </div>
  )
})

export interface MessageItemProps {
  readonly item: Item
  /** 在右侧预览面板里看文件（工具 run 里点 chip）。 */
  readonly onPreview: (path: string) => void
}

export const MessageItem = memo(function MessageItem({ item, onPreview }: MessageItemProps): ReactElement {
  if (item.kind === 'user') {
    // 用户消息里可能带 `/命令`、`@工具`、`#文件`：按类型染色，一眼看出这条消息用了什么
    return <div className="msg--user" data-item-id={item.id}><RichText text={item.text} /></div>
  }
  if (item.kind === 'note') {
    return (
      <div className={`msg__note${item.level === 'info' ? '' : ` msg__note--${item.level}`}`} data-item-id={item.id}>
        {item.text}
      </div>
    )
  }
  /**
   * 中途的目标调整：长得像用户消息但更矮、更淡、靠右，并带一个「目标调整」标。
   * 它是往正在跑的那一轮里插的话，不是新一轮提问。
   */
  if (item.kind === 'steer') {
    return (
      <div className="msg--steer" data-item-id={item.id}>
        <span className="msg--steer__tag">目标调整</span>
        <span className="msg--steer__text"><RichText text={item.text} /></span>
      </div>
    )
  }
  return <AssistantMessage item={item} onPreview={onPreview} />
})
