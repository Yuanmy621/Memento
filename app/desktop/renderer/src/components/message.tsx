/**
 * 会话条目的渲染：用户气泡、系统提示、助手消息（推理 + 正文 + 工具卡片 + 结论）。
 *
 * 助手消息的 blocks 是**有序**的，这里就按顺序渲染，
 * 于是「先说话 → 调工具 → 再说话」的结构被如实还原。
 *
 * @module YuanMy/desktop/renderer/components/message
 */

import { memo, type ReactElement } from 'react'
import { Markdown } from '../markdown.tsx'
import { ToolCard } from './tool-card.tsx'
import type { AssistantItem, Item, TurnMeta, TurnOutcome } from '../use-agent.ts'

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

const AssistantMessage = memo(function AssistantMessage({ item }: { readonly item: AssistantItem }): ReactElement {
  const streaming = item.meta === null
  return (
    <div className="msg--assistant" data-testid="assistant-message">
      {item.reasoning !== '' && (
        <details className="reasoning">
          <summary>推理过程</summary>
          <div className="reasoning__body" data-testid="reasoning">
            {item.reasoning}
          </div>
        </details>
      )}

      {item.blocks.map((block, index) => (
        block.type === 'tool'
          ? <ToolCard key={block.callId === '' ? `tool-${String(index)}` : block.callId} block={block} />
          : <Markdown key={`text-${String(index)}`}>{block.text}</Markdown>
      ))}

      <div
        className={`msg__meta${item.meta?.outcome === 'error' ? ' msg__meta--error' : ''}`}
        data-testid="message-meta"
      >
        {metaText(item.meta)}
        {streaming && item.blocks.length === 0 && item.reasoning === '' && ' …'}
      </div>
    </div>
  )
})

export interface MessageItemProps {
  readonly item: Item
}

export const MessageItem = memo(function MessageItem({ item }: MessageItemProps): ReactElement {
  if (item.kind === 'user') {
    return <div className="msg--user" data-testid="user-message">{item.text}</div>
  }
  if (item.kind === 'note') {
    return (
      <div className={`msg__note${item.level === 'info' ? '' : ` msg__note--${item.level}`}`} data-testid="note">
        {item.text}
      </div>
    )
  }
  return <AssistantMessage item={item} />
})
