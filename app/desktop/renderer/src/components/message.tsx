/**
 * 会话条目的渲染：用户气泡、系统提示、助手消息（推理 + 正文 + 工具/文件卡片 + 结论）。
 *
 * 助手消息的 blocks 是**有序**的，这里就按顺序渲染，
 * 于是「先说话 → 调工具 → 再说话」的结构被如实还原。
 *
 * 工具块分两种渲染：
 *   - 碰到文件的工具（read/write/edit）→ 文件卡片（图标 + 文件名 + 预览 + 打开）；
 *   - 其余 → 普通工具行。
 * 认不认得出来由 `fileActionOf()` 决定，认不出就退回普通行，不会硬编卡片。
 *
 * 每个条目的根元素上都有 `data-item-id`：右侧刻度滑杆（`message-rail.tsx`）靠它
 * 把「刻度」和真实 DOM 对上，点击才能滚到那一条。加在根元素上而不是包一层 div ——
 * `.messages__inner` 是 flex 列，多包一层会把 `align-self` 那套对齐弄乱。
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
 * 助手消息的渲染顺序：**严格按 blocks 的顺序**（推理 → 正文 → 工具 → 再推理…）。
 *
 * 两个刻意的设计：
 *   1. 工具块**连续出现时合成一次 run**（`ToolRun`）—— 上游的 ToolChips 就是「一次 run 的
 *      工具清单」，一个个单独渲染会把它的折叠页眉重复 N 遍；
 *   2. 推理**不再统一拎到消息最上方**（老实现如此）：它是 blocks 里的一种块，按真实位置
 *      渲染，于是「想一段 → 做一步 → 再想一段」的结构被如实还原，而不是顶部堆一大坨。
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
           * 只有**最后一段**且回合还在跑时才算「正在思考」—— 否则一个回合里
           * 历史上每一段思考都会显示成正在流式。
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
        {/* 还没跑完：用他们的 Shimmer 做「活的」文字，比一串静止的「正在生成…」更像在动 */}
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
   * 中途的目标调整。
   *
   * 长得像用户消息但**更矮、更淡、靠右**，并带一个「目标调整」标：它是往正在跑的
   * 那一轮里插的话，不是新一轮提问 —— 事后回看时这个区别很重要。
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
