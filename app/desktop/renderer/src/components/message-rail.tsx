/**
 * 右侧刻度尺：把整段会话摊成一把**等距短横线**的竖尺，用来跳转。
 *
 * 它解决的问题是**长会话里没法快速回看**：翻聊天记录只能滚轮子，想知道
 * 「我刚才让它写的那份报告在哪」要滚半天。这里一条条目 = 一道刻度：
 *
 *   ────        普通刻度（一短横，按角色微调颜色）
 *   ────────    当前刻度（**白色长横条**，最长最亮）
 *
 * 三条交互（都为了「一眼定位、一下跳过去」）：
 *   1. **滚轮**在尺子上滚 → 一格一格选（选择即跳转），这就是「可滚动选择的刻度尺」；
 *   2. **点**某一道刻度 → 平滑滚到那一条；
 *   3. 在尺子上**拖** → 连续选；鼠标滚消息时尺子自动跟着走（当前那一条滑到中间）。
 *
 * 实现上有两个关键取舍：
 *   - 刻度的**间距等距**（不按内容长度成比例）：等距才像一把尺子，「第几条」一眼可数；
 *     内容高度只用来算「现在读到第几条」（见 `measure()`）。
 *   - 尺子用 `translateY` **整体滑动**，外面套一层 `overflow: hidden` 的窗口 ——
 *     于是条目再多也只是「尺子更长」，刻度密度始终不变。
 *
 * 性能上的两条硬要求（都踩过）：
 *   1. 滚动只更新本组件自己的 state，**不要**往上冒到 `App`（否则每个滚动像素
 *      都重渲染整个消息流）；
 *   2. 重新测量的触发条件必须苛刻（内容总高变了 / 条目数变了 / 窗口尺寸变了），
 *      不然流式输出时每一帧都量一遍几百个元素。
 *
 * @module YuanMy/desktop/renderer/components/message-rail
 */

import {
  memo, useCallback, useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
  type ReactElement, type RefObject,
} from 'react'
import type { RailMark } from '../use-agent.ts'
import { STEP, WHEEL_STEP, anchorOf, indexAt, jumpTop, rulerShift, type Span } from './message-rail-model.ts'

/**
 * 提示框渐隐时长（毫秒）。
 *
 * 必须与 CSS 里 `.rail__tip` 的过渡时长一致：这里只负责「动画放完再卸载节点」，
 * 真正的淡出是 CSS 干的 —— React 一卸载就没有过渡可言了。
 */
const TIP_FADE = 160

export interface MessageRailProps {
  /** 滚动容器（`.messages`）。几何与滚动都从它身上量。 */
  readonly scrollRef: RefObject<HTMLDivElement | null>
  /** 刻度列表（`railMarks()` 的产物，与消息条目一一对应）。 */
  readonly marks: readonly RailMark[]
  /**
   * 重新测量的触发值。
   *
   * 传 `state.items` 就行：流式输出时它每帧都换新引用，但那不要紧 ——
   * 真正的测量被 `scrollHeight` 变化挡住了（见 `measure()`）。
   */
  readonly revision: unknown
}

export const MessageRail = memo(function MessageRail({ scrollRef, marks, revision }: MessageRailProps): ReactElement | null {
  const scaleRef = useRef<HTMLDivElement>(null)
  /**
   * 各条目的位置（量出来的），只用来算「现在读到第几条」。
   *
   * 「跳到第几条」不用它 —— 那次跳转每次都现问 DOM（条目会长高，缓存会过期）。
   */
  const spansRef = useRef<readonly Span[]>([])
  const [selected, setSelected] = useState(0)
  /** 窗口（`.rail__scale`）高度，用来算尺子的位移。 */
  const [viewHeight, setViewHeight] = useState(0)
  /**
   * 悬停提示框：`hover` 是内容（渐隐期间也留着），`tipVisible` 才是「该不该亮着」。
   *
   * 分两份状态是为了**渐隐**：移开鼠标先把 `tipVisible` 置 false 让 CSS 淡出，
   * 等动画放完（`TIP_FADE`）再清内容、卸载节点 —— 直接卸载就没有过渡了。
   * `y` 是提示框中心的像素位置（相对窗口顶边）。
   */
  const [hover, setHover] = useState<{ id: string; y: number } | null>(null)
  const [tipVisible, setTipVisible] = useState(false)
  /** 渐隐的定时器（同一时间只该有一个）。 */
  const tipTimerRef = useRef(0)
  /** 上一次测量时的内容总高：没变就不重量（流式输出时的关键拦截）。 */
  const lastTotalRef = useRef(-1)
  const lastCountRef = useRef(-1)
  /** 当前选中的下标（给事件回调用，避免闭包读到旧值）。 */
  const selectedRef = useRef(0)
  /**
   * 程序性跳转的落点（-1 = 没锁）。
   *
   * 跳转是平滑动画，中途会经过别的条目 —— 那些中间帧不该改写「选中项」，
   * 否则用户点了第 10 条，尺子却一路抖动最后停在别处。动画期间锁住，之后解锁。
   */
  const lockRef = useRef(-1)

  const commit = useCallback((index: number): void => {
    selectedRef.current = index
    setSelected(index)
  }, [])

  /**
   * 亮出提示框。
   *
   * 先撤掉未完成的渐隐定时器：从一道刻度划到相邻那道时，两条刻度的 leave/enter
   * 会先后触发，不撤的话就成了「刚淡出一点又被点亮」，看着像闪。
   */
  const showTip = useCallback((id: string, y: number): void => {
    window.clearTimeout(tipTimerRef.current)
    tipTimerRef.current = 0
    setHover({ id, y })
    setTipVisible(true)
  }, [])

  /** 移开：先淡出，动画放完再卸载。 */
  const hideTip = useCallback((): void => {
    window.clearTimeout(tipTimerRef.current)
    setTipVisible(false)
    tipTimerRef.current = window.setTimeout(() => { setHover(null) }, TIP_FADE)
  }, [])

  // 卸载时别把定时器留下（它会对一个已经没了的组件 setState）
  useEffect(() => () => { window.clearTimeout(tipTimerRef.current) }, [])

  /** 量一次：各条目的位置 + 窗口高度。 */
  const measure = useCallback((): void => {
    const container = scrollRef.current
    const scale = scaleRef.current
    if (container === null || scale === null) return
    setViewHeight(scale.clientHeight)
    const total = container.scrollHeight
    const count = marks.length
    if (total <= 0) return
    if (total === lastTotalRef.current && count === lastCountRef.current) return
    lastTotalRef.current = total
    lastCountRef.current = count

    // 内容坐标的零点：容器顶边在「未滚动」时的位置。
    const base = container.getBoundingClientRect().top - container.scrollTop
    const spans: Span[] = []
    for (const node of container.querySelectorAll<HTMLElement>('[data-item-id]')) {
      spans.push({ id: node.dataset['itemId'] ?? '', top: node.getBoundingClientRect().top - base })
    }
    spansRef.current = spans
    if (lockRef.current < 0) commit(indexAt(spans, anchorOf(container.scrollTop, container.clientHeight)))
  }, [commit, marks.length, scrollRef])

  /*
   * 条目变了 / 窗口尺寸变了 → 重量一次。
   *
   * ⚠️ 首次测量**必须同步做**，不能丢给 `requestAnimationFrame`：窗口被遮挡
   * （切到别的应用、最小化）时 rAF 会被暂停，量不到的后果是「尺子停在 0 位置、
   * 点什么都没反应」—— 而不是「稍微晚一点」。变尺寸那一路才用 rAF 合并。
   */
  useEffect(() => {
    measure()
    let frame = 0
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => { frame = 0; measure() })
    }
    const scale = scaleRef.current
    const container = scrollRef.current
    const observer = new ResizeObserver(schedule)
    if (scale !== null) observer.observe(scale)
    if (container !== null) observer.observe(container)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [measure, revision, scrollRef])

  /*
   * 滚动：更新选中项，并顺手看看内容总高有没有变。
   *
   * 两条路刻意分开：
   *   - **换选中项**是纯计算（查缓存的位置表，一旦选中项没变就直接返回），
   *     所以同步做 —— 不欠 rAF 的债。窗口被遮挡时 rAF 会被暂停，
   *     那时「尺子不动」会让人以为坏了；同步算的话它照样跟手。
   *   - **重新测量**要读几百个 `getBoundingClientRect`，那可是重活，交给 rAF 合并。
   *     它只在内容总高变化时才发生（流式输出时会被滚动事件带着触发），
   *     所以这里补一句就够了 —— 不需要 MutationObserver 那种重家伙。
   */
  useEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    let frame = 0
    const onScroll = (): void => {
      // 内容长高了 → 排队重量（重活）；但**不 return**：先用手上这份位置表把选中项更新了，
      // 否则 rAF 一被暂停（窗口被遮挡时）尺子就整个卡住不动，看着像坏了。
      if (container.scrollHeight !== lastTotalRef.current && frame === 0) {
        frame = requestAnimationFrame(() => { frame = 0; measure() })
      }
      if (lockRef.current >= 0) return
      const next = indexAt(spansRef.current, anchorOf(container.scrollTop, container.clientHeight))
      if (next !== selectedRef.current) commit(next)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      container.removeEventListener('scroll', onScroll)
    }
  }, [commit, measure, scrollRef])

  /**
   * 滚到第 `index` 条。
   *
   * 位置**每次都现问 DOM**（不查缓存）：条目随时可能变高（图片加载、markdown 渲染完），
   * 缓存里的位置一旦过期就会「跳偏一点」。一次 `getBoundingClientRect` 换一次准确跳转，值。
   *
   * 落点不是简单的「条目顶到视口顶」：当前刻度取的是**屏幕里最后那条**，
   * 所以短的条目要让它的底边贴住判定线 —— 否则点第 10 条、高亮会落到第 13 条
   * （细节与推导见 `message-rail-model.ts` 的 `jumpTop`）。
   *
   * `smooth` 只给「点击」用：滚轮/拖动是连续动作，每一格都做动画会排队、发黏。
   * 跳转期间上锁，动画结束（或超时）解锁。
   */
  const goTo = useCallback((index: number, smooth: boolean): void => {
    const container = scrollRef.current
    if (container === null) return
    const nodes = container.querySelectorAll<HTMLElement>('[data-item-id]')
    if (nodes.length === 0) return
    const clamped = Math.min(Math.max(index, 0), nodes.length - 1)
    const node = nodes[clamped]
    if (node === undefined) return
    // 内容坐标的零点：容器顶边在「未滚动」时的位置。
    const base = container.getBoundingClientRect().top - container.scrollTop
    const rect = node.getBoundingClientRect()
    const max = Math.max(container.scrollHeight - container.clientHeight, 0)
    // 落点由纯函数算：保证跳完「屏幕上最后那条」正好是点中的这条（见 jumpTop）
    const top = Math.min(Math.max(jumpTop(rect.top - base, rect.height, container.clientHeight), 0), max)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    lockRef.current = clamped
    commit(clamped)
    container.scrollTo({ top, behavior: smooth && !reduce ? 'smooth' : 'auto' })
    window.setTimeout(() => { lockRef.current = -1 }, smooth ? 700 : 90)
  }, [commit, scrollRef])

  /**
   * 滚轮在尺子上滚 = 一格一格选。
   *
   * 必须用原生的**非被动**监听：React 的 `onWheel` 挂在根节点上且是被动的，
   * 里面 `preventDefault()` 不生效（结果滚轮会把消息和尺子一起滚）。
   */
  useEffect(() => {
    const scale = scaleRef.current
    if (scale === null) return
    let acc = 0
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      acc += event.deltaY
      const steps = acc > 0 ? Math.floor(acc / WHEEL_STEP) : Math.ceil(acc / WHEEL_STEP)
      if (steps === 0) return
      acc -= steps * WHEEL_STEP
      goTo(selectedRef.current + steps, false)
    }
    scale.addEventListener('wheel', onWheel, { passive: false })
    return () => { scale.removeEventListener('wheel', onWheel) }
  }, [goTo])

  /** 在尺子的空白处按下拖动：每滑过一格就选一格。 */
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('.rail__tick') !== null) return
    event.preventDefault()
    const startY = event.clientY
    const startIndex = selectedRef.current
    let moved = false
    const onMove = (move: PointerEvent): void => {
      if (!moved && Math.abs(move.clientY - startY) < 4) return
      moved = true
      goTo(startIndex + Math.round((move.clientY - startY) / STEP), false)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [goTo])

  /** 焦点在刻度上时按上下键：换一条（键盘也能当尺子用）。 */
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    goTo(selectedRef.current + (event.key === 'ArrowDown' ? 1 : -1), true)
  }, [goTo])

  if (marks.length < 2) return null

  const markById = new Map(marks.map((mark) => [mark.id, mark]))
  const hovered = hover === null ? undefined : markById.get(hover.id)
  // 提示框按窗口高度夹一下，免得贴着上下边时被裁掉
  const tipY = hover === null ? 0 : Math.min(Math.max(hover.y, 76), Math.max(viewHeight - 76, 76))

  return (
    <div className="rail" role="group" aria-label="会话刻度尺">
      {hovered !== undefined && (
        <div
          className={`rail__tip${tipVisible ? '' : ' rail__tip--out'}`}
          style={{ top: `${String(tipY)}px` }}
          aria-hidden="true"
        >
          <div className="rail__tip-head">
            <span className={`rail__role rail__role--${hovered.kind}`}>{hovered.role}</span>
            {hovered.tools > 0 && <span className="rail__tip-tools">{hovered.tools} 次工具</span>}
            {hovered.running && <span className="rail__tip-running">运行中</span>}
          </div>
          <div className="rail__tip-text">{hovered.summary}</div>
        </div>
      )}
      <div
        className="rail__scale"
        ref={scaleRef}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        // 移开**整条尺子**才淡出：在刻度之间划过去时不闪（enter 会撤掉渐隐定时器）
        onMouseLeave={hideTip}
      >
        <div className="rail__ruler" style={{ transform: `translateY(${String(rulerShift(marks.length, selected, viewHeight))}px)` }}>
          {marks.map((mark, index) => (
            <button
              key={mark.id}
              type="button"
              className={`rail__tick rail__tick--${mark.kind}${index === selected ? ' rail__tick--current' : ''}${mark.running ? ' rail__tick--running' : ''}`}
              style={{ top: `${String(index * STEP)}px` }}
              title={`${mark.role}：${mark.summary}`}
              aria-label={`跳到第 ${String(index + 1)} 条：${mark.summary.slice(0, 40)}`}
              aria-current={index === selected}
              onMouseEnter={(event) => {
                const scale = scaleRef.current
                if (scale === null) return
                const rect = event.currentTarget.getBoundingClientRect()
                showTip(mark.id, rect.top - scale.getBoundingClientRect().top + rect.height / 2)
              }}
              onFocus={(event) => {
                const scale = scaleRef.current
                if (scale === null) return
                const rect = event.currentTarget.getBoundingClientRect()
                showTip(mark.id, rect.top - scale.getBoundingClientRect().top + rect.height / 2)
              }}
              onBlur={hideTip}
              // 离开这道刻度就开始淡出（划到相邻刻度时 enter 会立刻撤掉定时器，
              // 所以「一格一格扫过去」不会闪；停在刻度之间的空隙里则会淡掉）
              onMouseLeave={hideTip}
              onClick={() => { goTo(index, true) }}
            />
          ))}
        </div>
      </div>
    </div>
  )
})
