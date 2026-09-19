/**
 * 会话条目的渲染：用户气泡、系统提示、助手消息（推理 + 正文 + 工具/文件卡片 + 结论）。
 *
 * 助手消息的 blocks 是**有序**的，这里就按顺序渲染，
 * 于是「先说话 → 调工具 → 再说话」的结构被如实还原。
 *
 * 工具块分两种渲染：
 *   - 碰到文件的工具（read/write/edit）→ 文件卡片（图标 + 文件名 + 打开）；
 *   - 其余 → 普通工具行。
 * 认不认得出来由 `fileActionOf()` 决定，认不出就退回普通行，不会硬编卡片。
 *
 * @module YuanMy/desktop/renderer/components/message
 */

import { memo, type ReactElement } from 'react'
import { Markdown } from '../markdown.tsx'
import { ToolCard } from './tool-card.tsx'
import { FileCard } from './file-card.tsx'
import { fileActionOf, type AssistantItem, type Item, type ToolBlock, type TurnMeta, type TurnOutcome } from '../use-agent.ts'

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

/** 一个工具块：认得出文件就画文件卡片，否则画普通工具行。 */
function ToolBlockView({ block, onOpenPath }: {
  readonly block: ToolBlock
  readonly onOpenPath: (path: string) => void
}): ReactElement {
  const file = fileActionOf(block.name, block.args)
  if (file === undefined) return <ToolCard block={block} />
  return (
    <div className="tool-file">
      <FileCard path={file.path} action={file.action} onOpen={onOpenPath} />
      {/* 文件卡片已经表达了「读了哪个文件」；只有失败时才需要把结果露出来 */}
      {block.isError && block.result !== null && (
        <div className="tool-card__result tool-card__result--error">{block.result}</div>
      )}
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({ item, onOpenPath }: {
  readonly item: AssistantItem
  readonly onOpenPath: (path: string) => void
}): ReactElement {
  const streaming = item.meta === null
  return (
    <div className="msg--assistant">
      {item.reasoning !== '' && (
        // 回合进行中加 `reasoning--running`：表示「模型还在想」，样式里挂状态色。
        <details className={`reasoning${streaming ? ' reasoning--running' : ''}`}>
          <summary>推理过程</summary>
          <div className="reasoning__body">
            {item.reasoning}
          </div>
        </details>
      )}

      {item.blocks.map((block, index) => (
        block.type === 'tool'
          ? (
            <ToolBlockView
              key={block.callId === '' ? `tool-${String(index)}` : block.callId}
              block={block}
              onOpenPath={onOpenPath}
            />
          )
          : <Markdown key={`text-${String(index)}`}>{block.text}</Markdown>
      ))}

      <div
        className={`msg__meta${item.meta?.outcome === 'error' ? ' msg__meta--error' : ''}`}
      >
        {metaText(item.meta)}
        {streaming && item.blocks.length === 0 && item.reasoning === '' && ' …'}
      </div>
    </div>
  )
})

export interface MessageItemProps {
  readonly item: Item
  /** 打开文件（文件卡片用）。 */
  readonly onOpenPath: (path: string) => void
}

export const MessageItem = memo(function MessageItem({ item, onOpenPath }: MessageItemProps): ReactElement {
  if (item.kind === 'user') {
    return <div className="msg--user">{item.text}</div>
  }
  if (item.kind === 'note') {
    return (
      <div className={`msg__note${item.level === 'info' ? '' : ` msg__note--${item.level}`}`}>
        {item.text}
      </div>
    )
  }
  return <AssistantMessage item={item} onOpenPath={onOpenPath} />
})
