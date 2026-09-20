/**
 * 刻度尺的纯逻辑：**没有 DOM、没有 React**，所以能在 Node 里直接 import 跑真值表
 * （`.tsx` 带 JSX，纯 Node 加载不了 —— 与 `rich-text-tokens.ts` / `sidebar-cylinder.ts`
 * 同一个约定）。
 *
 * 这里有四个函数：
 *   - {@link anchorOf}：判定线（= 屏幕上**最后一条可见条目**所在的位置）；
 *   - {@link indexAt}：这条判定线落在第几条上；
 *   - {@link rulerShift}：尺子该往上移多少，才能让当前刻度落在窗口中间；
 *   - {@link jumpTop}：点某道刻度时，视口顶边该滚到哪（保证跳完当前刻度就是它）。
 *
 * @module YuanMy/desktop/renderer/components/message-rail-model
 */

/** 刻度间距（像素）：一道 2px 短横 + 8px 空隙。 */
export const STEP = 10
/** 滚轮滚多少像素算「一格」。 */
export const WHEEL_STEP = 26
/**
 * 判定线离**视口底边**的距离（像素）。
 *
 * ⚠️ 判定线取的是「底边往上 ANCHOR」而不是顶边往下 —— 用户眼睛停在屏幕里
 * **最后那一条**上：滚到会话末尾时当前刻度就该是末尾那条，用顶边的话它会停在
 * 屏幕中间某条，跟看到的东西对不上。
 */
export const ANCHOR = 8

/**
 * 判定线在内容坐标里的位置 —— 纯函数。
 * @param scrollTop - 视口顶边在内容里的位置。
 * @param viewport - 视口高度。
 * @returns 内容坐标（像素）：屏幕上最后那条可见条目的所在地。
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
 * 判定「判定线落在第几条上」。
 * @param spans - 各条目的位置（按顺序）。
 * @param anchor - 判定线（内容坐标，像素）。
 * @returns 条目下标（越界时收到两端）。
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
 * 点某道刻度时要滚到哪 —— 纯函数。
 *
 * 目的：**跳完之后「最后一条可见」正好是它**。不做这件事的话，点第 10 条、
 * 高亮却会跑到第 13 条（条目只有半屏高，屏幕里最后那条是别的一条）。
 *   - 条目比视口还高：把它顶到视口上方（它的范围本来就盖住了判定线）；
 *   - 否则：让它**底边**贴住判定线，下方留一点余量。
 * 返回的是「视口顶边」的内容坐标，越界由调用方夹到 `[0, max]`。
 * @param itemTop - 条目顶边（内容坐标）。
 * @param itemHeight - 条目高度。
 * @param viewport - 视口高度。
 * @returns 目标 `scrollTop`（未夹取）。
 */
export function jumpTop(itemTop: number, itemHeight: number, viewport: number): number {
  const tall = itemHeight >= viewport - 2 * ANCHOR
  return tall ? itemTop - ANCHOR : itemTop + itemHeight - viewport + ANCHOR
}

/**
 * 尺子该往上移多少，才能让当前刻度落在窗口中间 —— 纯函数。
 *
 * 两种情况：尺子比窗口短就整条居中；比窗口长就让当前刻度居中，
 * 并且**两端不越界**（选第一条时尺子顶到窗口顶，最后一条时底到窗口底）。
 * @param count - 刻度总数。
 * @param index - 当前刻度下标。
 * @param viewHeight - 窗口高度（像素）。
 * @returns `translateY` 的像素值（≤ 0）。
 */
export function rulerShift(count: number, index: number, viewHeight: number): number {
  const ruler = count * STEP
  if (viewHeight <= 0) return 0
  if (ruler <= viewHeight) return (viewHeight - ruler) / 2
  const centered = viewHeight / 2 - (index + 0.5) * STEP
  return Math.min(Math.max(centered, viewHeight - ruler), 0)
}
