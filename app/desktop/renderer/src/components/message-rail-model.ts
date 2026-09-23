/**
 * 刻度尺的纯逻辑：没有 DOM、没有 React，能在 Node 里直接 import 跑真值表
 * （与 `rich-text-tokens.ts` / `sidebar-cylinder.ts` 同一个约定）。
 *
 * `anchorOf` 算判定线（屏幕最后一条可见条目的位置），`indexAt` 算它落在第几条，
 * `rulerShift` 算尺子该上移多少，`jumpTop` 算点某道刻度后视口顶边该滚到哪。
 *
 * @module Memento/desktop/renderer/components/message-rail-model
 */

/** 刻度间距（像素）：一道 2px 短横 + 8px 空隙。 */
export const STEP = 10
/** 滚轮滚多少像素算「一格」。 */
export const WHEEL_STEP = 26
/**
 * 判定线离视口底边的距离（像素）：取底边往上而不是顶边往下 —— 眼睛停在屏幕里最后
 * 那一条上，用顶边的话滚到会话末尾时刻度会停在屏幕中间，与看到的东西对不上。
 */
export const ANCHOR = 8

/**
 * 判定线在内容坐标里的位置（像素），即屏幕上最后那条可见条目的所在地 —— 纯函数。
 */
export function anchorOf(scrollTop: number, viewport: number): number {
  return scrollTop + viewport - ANCHOR
}

/** 一条刻度的位置（内容坐标，像素）。 */
export interface Span {
  /** 条目 id（只用于日志/调试，判定位置只认 `top`）。 */
  readonly id: string
  /** 顶边在滚动内容里的位置（已含容器内边距）。 */
  readonly top: number
}

/**
 * 判定「判定线落在第几条上」，返回条目下标，越界时收到两端。
 */
export function indexAt(spans: readonly Span[], anchor: number): number {
  if (spans.length === 0) return 0
  let index = 0
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]
    if (span === undefined || span.top > anchor) break
    index = i
  }
  return index
}

/**
 * 点某道刻度时要滚到哪 —— 纯函数，目标是跳完之后「最后一条可见」正好是它。
 *
 * 条目比视口高就把它顶到视口上方（它的范围本来就盖住了判定线），否则让它底边贴住判定线。
 * 返回的是视口顶边的内容坐标（像素），越界由调用方夹到 `[0, max]`。
 */
export function jumpTop(itemTop: number, itemHeight: number, viewport: number): number {
  const tall = itemHeight >= viewport - 2 * ANCHOR
  return tall ? itemTop - ANCHOR : itemTop + itemHeight - viewport + ANCHOR
}

/**
 * 尺子该往上移多少，才能让当前刻度落在窗口中间 —— 纯函数，返回值 ≤ 0。
 * 尺子比窗口短就整条居中，否则让当前刻度居中且两端不越界。
 */
export function rulerShift(count: number, index: number, viewHeight: number): number {
  const ruler = count * STEP
  if (viewHeight <= 0) return 0
  if (ruler <= viewHeight) return (viewHeight - ruler) / 2
  const centered = viewHeight / 2 - (index + 0.5) * STEP
  return Math.min(Math.max(centered, viewHeight - ruler), 0)
}
