/**
 * 工具调用卡片：一次 `tool/call` + 它的 `tool/result`。
 *
 * 视觉上是单色的（Codex 风格）：靠 1px 描边和结果区的一层底色区分结构，
 * 不用彩色左边框。只有「运行中 / 失败 / exit 码」三种状态带颜色。
 *
 * @module YuanMy/desktop/renderer/components/tool-card
 */

import { memo, type ReactElement } from 'react'
import type { ToolBlock } from '../use-agent.ts'
import { RichText } from './rich-text.tsx'

/** 从结果摘要末尾挑出 `exit N`，单独上色。 */
function splitExit(summary: string): [string, string | null] {
  const match = / exit (\d+)\s*$/.exec(summary)
  if (match === null || match[1] === undefined) return [summary, null]
  return [summary.slice(0, match.index), match[1]]
}

export interface ToolCardProps {
  readonly block: ToolBlock
}

export const ToolCard = memo(function ToolCard({ block }: ToolCardProps): ReactElement {
  const pending = block.result === null
  const [text, exitCode] = pending ? ['', null] : splitExit(block.result ?? '')

  return (
    <div className={`tool-card${pending ? ' tool-card--pending' : ''}`}>
      <div className="tool-card__head">
        <span className="tool-card__name">{block.name}</span>
        {block.args !== '' && <span className="tool-card__args"><RichText text={block.args} /></span>}
      </div>
      {!pending && (
        <div className={`tool-card__result${block.isError ? ' tool-card__result--error' : ''}`}>
          {text}
          {exitCode !== null && (
            <span className={exitCode === '0' ? 'tool-card__exit--ok' : 'tool-card__exit--bad'}>exit {exitCode}</span>
          )}
        </div>
      )}
    </div>
  )
})
