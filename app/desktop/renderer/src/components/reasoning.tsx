/**
 * 一段思考（推理）的渲染：折叠成一行，需要时展开，流式期间不撑爆版面。
 *
 * 流式期间限高（`--reasoning-max-live`）并自动滚到底，只露最近几行；结束后收起成
 * 「思考了 N 字」，点一下展开全文。文本节点的 key 按块的位置保持稳定，增量只让文本变长 ——
 * key 跟着文本变会让 React 每帧重建元素，`fade-up` 反复从 `opacity: 0` 重播，整块看着是空白。
 *
 * @module Memento/desktop/renderer/components/reasoning
 */

import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Shimmer } from '../ui/beautifului/atoms/Shimmer.tsx'
import { IconSparkle } from '../icons.tsx'

/** 流式期间的限高（px）：大约 6 行，够看清「它在想什么」，又不占版面。 */
const LIVE_MAX_PX = 132
/** 展开历史思考时的限高（px）：更宽松，但也不是无限长。 */
const OPEN_MAX_PX = 320

/** 按字符数给一句人话（中文为主，粗算即可）。 */
function sizeLabel(text: string): string {
  const chars = text.replace(/\s+/g, '').length
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k 字` : `${String(chars)} 字`
}

/** 一行预览：折叠时露出的那半句（首行，过长省略）。 */
function previewOf(text: string): string {
  const end = text.indexOf('\n')
  const line = (end === -1 ? text : text.slice(0, end)).trim()
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

export interface ReasoningProps {
  /** 这一段思考的全文（流式期间会持续变长）。 */
  readonly text: string
  /** 这一段是不是还在流式接收增量（只有最后一段会为 true）。 */
  readonly live: boolean
}

export const Reasoning = memo(function Reasoning({ text, live }: ReasoningProps): ReactElement {
  /**
   * `null` = 跟随流式状态自动开合：流式期间展开（限高、滚到底），一结束自动收起成一行；
   * 用户点过之后就听 `manual`。
   */
  const [manual, setManual] = useState<boolean | null>(null)
  const [everOpen, setEverOpen] = useState(live)
  const open = manual ?? live
  const bodyRef = useRef<HTMLDivElement>(null)
  /** 正文首次展开才挂载（历史思考可能很多，不把长文本全堆进 DOM）。 */
  const mountBody = everOpen || open

  /** 流式时把视口钉在最新一行：思考是从下往上长的，不能让人自己追。 */
  useEffect(() => {
    if (!live || !open) return
    const el = bodyRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [text, live, open])

  const preview = useMemo(() => previewOf(text), [text])
  const maxHeight = live ? LIVE_MAX_PX : OPEN_MAX_PX

  return (
    <div className="reasoning">
      <button
        type="button"
        className="reasoning__head"
        aria-expanded={open}
        title={open ? '收起这段思考' : '展开这段思考'}
        onClick={() => {
          setManual(!open)
          setEverOpen(true)
        }}
      >
        <span className={`reasoning__icon${live ? ' reasoning__icon--live' : ''}`} aria-hidden="true">
          <IconSparkle size={13} />
        </span>
        {live ? (
          <Shimmer className="reasoning__title">正在思考…</Shimmer>
        ) : (
          <span className="reasoning__title reasoning__title--done">思考了 {sizeLabel(text)}</span>
        )}
        {/* 折叠时露一行原文（不完全展示），展开后这一行让位给正文 */}
        {!open && <span className="reasoning__preview">{preview}</span>}
        <span className={`reasoning__chevron${open ? ' reasoning__chevron--open' : ''}`} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      <div
        className="reasoning__grid"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="reasoning__clip">
          {mountBody && (
            <div ref={bodyRef} className="reasoning__body" style={{ maxHeight: `${String(maxHeight)}px` }}>
              {text}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
