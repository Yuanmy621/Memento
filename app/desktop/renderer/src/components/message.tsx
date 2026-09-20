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
 * @module YuanMy/desktop/renderer/components/message
 */

import { memo, type ReactElement } from 'react'
import { RichText } from './rich-text.tsx'
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
function ToolBlockView({ block, onOpenPath, onPreview }: {
  readonly block: ToolBlock
  readonly onOpenPath: (path: string) => void
  readonly onPreview: (path: string) => void
}): ReactElement {
  const file = fileActionOf(block.name, block.args)
  if (file === undefined) return <ToolCard block={block} />
  return (
    <div className="tool-file">
      <FileCard path={file.path} action={file.action} onOpen={onOpenPath} onPreview={onPreview} />
      {/* 文件卡片已经表达了「读了哪个文件」；只有失败时才需要把结果露出来 */}
      {block.isError && block.result !== null && (
        <div className="tool-card__result tool-card__result--error"><RichText text={block.result} /></div>
      )}
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({ item, onOpenPath, onPreview }: {
  readonly item: AssistantItem
  readonly onOpenPath: (path: string) => void
  readonly onPreview: (path: string) => void
}): ReactElement {
  const streaming = item.meta === null
  return (
    <div className="msg--assistant" data-item-id={item.id}>
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
              onPreview={onPreview}
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
  /** 用系统默认程序打开文件（文件卡片的「打开」）。 */
  readonly onOpenPath: (path: string) => void
  /** 在右侧预览面板里看文件（文件卡片主体）。 */
  readonly onPreview: (path: string) => void
}

export const MessageItem = memo(function MessageItem({ item, onOpenPath, onPreview }: MessageItemProps): ReactElement {
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
  return <AssistantMessage item={item} onOpenPath={onOpenPath} onPreview={onPreview} />
})
