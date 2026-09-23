/**
 * 侧栏背景的柱面粒子层：把 `sidebar-cylinder.ts` 的纯模拟画到一块 canvas 上。
 *
 * 这里只做 DOM 那半边（canvas / DPR / rAF 循环与帧率、暂停条件、颜色与绘制顺序），
 * 柱面投影、明暗与碎屑曲线在 `sidebar-cylinder.ts` 里。三条不做就会出事的规则：尊重
 * `prefers-reduced-motion`（命中时不启动循环并清空画布）、窗口不可见时停循环（`visibilitychange`）、
 * `dt` 要夹上限（见 {@link MAX_FRAME_MS}）。canvas 是 `pointer-events: none` + `aria-hidden`。
 *
 * @module Memento/desktop/renderer/src/components/sidebar-backdrop
 */

import { useEffect, useRef, type ReactElement } from 'react'
import {
  createField,
  resizeField,
  stepField,
  tileFrame,
  visibleRows,
  type Field,
  type TileFrame,
} from './sidebar-cylinder.ts'

/** 单帧最大步进（ms）：切回前台或系统卡顿后 `now - last` 可能是好几秒。 */
const MAX_FRAME_MS = 48

/**
 * 目标帧率：这是一层 5~20% 不透明度的背景，30fps 与 60fps 在观感上看不出差别，
 * 但渲染进程开销翻倍。
 */
const FRAME_INTERVAL_MS = 1000 / 30

/**
 * 画布像素上限倍率：纯色小方块（5~25% 不透明度）在 1.25 倍与 2 倍下肉眼没有区别，
 * 而光栅化开销几乎正比于覆盖的像素数。
 */
const MAX_DPR = 1.25

/** 系统「减弱动态效果」的媒体查询。 */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/**
 * 从 CSS 变量里取颜色：配色一律走令牌（见 `app.css` 的 `@theme`），粒子色也跟着主题变。
 * 读不到就给 `fallback` —— 它只是背景，看不见也不要报错；返回值可直接喂给 `fillStyle`。
 */
function cssColor(node: Element, name: string, fallback: string): string {
  const value = getComputedStyle(node).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/** 侧栏背景的柱面粒子层。放进 `.sidebar` 里当第一个子节点（见那里的注释）。 */
export function SidebarBackdrop(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const context = canvas.getContext('2d')
    if (context === null) return

    const motionQuery = window.matchMedia(REDUCED_MOTION)
    /** 场：尺寸变化时只改尺寸，不重建（重建会把正在滚的碎屑清掉）。 */
    let field: Field | null = null
    let frame = 0
    let last = 0
    /** 距上一帧画了多少 ms（用来把帧率压到 {@link FRAME_INTERVAL_MS}）。 */
    let accumulator = 0
    /** 停着的时候用来盯「系统减弱动态效果」有没有被关掉的定时器（0 = 没开）。 */
    let poll = 0
    /** 缓存的逻辑尺寸：每帧读 `clientWidth` 会强制布局。 */
    let size = { width: 0, height: 0 }
    /** 复用的 frame 对象：每帧要算上千次，不能每次 new。 */
    const scratch: TileFrame = {
      x: 0, y: 0, width: 0, height: 0, alpha: 0, detached: false, dx: 0, dy: 0, angle: 0, scale: 1,
    }
    /** 柱面与碎屑的颜色（从令牌读，见 {@link cssColor}）。 */
    let surfaceColor = 'rgba(255,255,255,0.5)'
    let shardColor = 'rgba(180,190,245,0.6)'

    /**
     * 按 CSS 尺寸 + DPR 调整画布，并把逻辑尺寸记进 {@link size}。
     * 只在挂载 / 尺寸变化 / 重新开始时调它，放进每帧循环会每帧强制一次布局。
     */
    const syncSize = (): { width: number; height: number } => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const pixelWidth = Math.max(1, Math.round(width * dpr))
      const pixelHeight = Math.max(1, Math.round(height * dpr))
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      size = { width, height }
      return size
    }

    /** 颜色只在「开始 / 尺寸变化」时读一次：`getComputedStyle` 会触发样式计算。 */
    const refreshColors = (): void => {
      surfaceColor = cssColor(canvas, '--ym-surface', 'rgba(255,255,255,0.55)')
      shardColor = cssColor(canvas, '--ym-shard', 'rgba(180,190,245,0.6)')
    }

    /** 保证「场」与当前尺寸一致（首次、以及尺寸变化后调用）。 */
    const syncField = (): Field => {
      const { width, height } = syncSize()
      if (field === null) field = createField(width, height, Math.random)
      else resizeField(field, width, height, Math.random)
      return field
    }

    /** 画一帧（用缓存的尺寸，不读布局）。 */
    const draw = (active: Field): void => {
      context.clearRect(0, 0, size.width, size.height)
      const rows = visibleRows(active)
      // 第一遍：还在柱面上的格子（轴对齐，便宜）
      context.fillStyle = surfaceColor
      for (let row = 0; row < rows; row += 1) {
        for (let dense = 0; dense < active.dense; dense += 1) {
          const cell = tileFrame(active, dense, row, scratch)
          if (cell === null || cell.detached || cell.alpha <= 0.002) continue
          context.globalAlpha = cell.alpha
          context.fillRect(cell.x, cell.y, cell.width, cell.height)
        }
      }
      // 第二遍：被切下来、正在向右滚的碎屑要旋转，画在最上面
      context.fillStyle = shardColor
      for (let row = 0; row < rows; row += 1) {
        for (let dense = 0; dense < active.dense; dense += 1) {
          const cell = tileFrame(active, dense, row, scratch)
          if (cell === null || !cell.detached || cell.alpha <= 0.002) continue
          context.save()
          context.globalAlpha = Math.min(1, cell.alpha)
          context.translate(cell.x + cell.width / 2 + cell.dx, cell.y + cell.height / 2 + cell.dy)
          context.rotate(cell.angle)
          context.scale(cell.scale, cell.scale)
          context.fillRect(-cell.width / 2, -cell.height / 2, cell.width, cell.height)
          context.restore()
        }
      }
      context.globalAlpha = 1
    }

    /** 一帧的循环体。 */
    const tick = (now: number): void => {
      frame = window.requestAnimationFrame(tick)
      const elapsed = last === 0 ? 0 : Math.min(now - last, MAX_FRAME_MS)
      last = now
      accumulator += elapsed
      // 未到下一帧：只更新 last/accumulator，不跑模拟也不画 —— 模拟按真实时间推进。
      if (accumulator < FRAME_INTERVAL_MS) return
      const step = accumulator
      accumulator = 0
      const active = field ?? syncField()
      stepField(active, step, Math.random)
      draw(active)
    }

    /**
     * 停着的时候盯着「什么时候能再开」：每 1.5s 复查一次查询条件。
     * 只靠 `matchMedia` 的 `change` 事件不够，某些环境下事件不派发，效果会一直停着不回来。
     */
    const scheduleResumeCheck = (): void => {
      if (poll !== 0 || frame !== 0) return
      poll = window.setInterval(() => {
        if (motionQuery.matches || document.hidden) return
        window.clearInterval(poll)
        poll = 0
        start()
      }, 1500)
    }

    /** 开循环（已经开着就什么都不做）。 */
    const start = (): void => {
      if (poll !== 0) {
        window.clearInterval(poll)
        poll = 0
      }
      if (frame !== 0 || motionQuery.matches) return
      last = 0
      accumulator = 0
      refreshColors()
      syncField()
      frame = window.requestAnimationFrame(tick)
    }

    /** 停循环并清屏：停之前不清会留一帧残影。 */
    const stop = (): void => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
        frame = 0
      }
      const { width, height } = syncSize()
      context.clearRect(0, 0, width, height)
      // 停下来之后惦记着什么时候能再开（见 scheduleResumeCheck）。
      if (motionQuery.matches) scheduleResumeCheck()
    }

    const observer = new ResizeObserver(() => {
      refreshColors()
      syncField()
    })
    observer.observe(canvas)

    const onVisibility = (): void => {
      if (document.hidden) stop()
      else start()
    }
    const onMotionChange = (): void => {
      if (motionQuery.matches) stop()
      else start()
    }

    document.addEventListener('visibilitychange', onVisibility)
    motionQuery.addEventListener('change', onMotionChange)
    // 一开始就不可见（后台启动）时不起循环。
    if (!document.hidden) start()

    return () => {
      stop()
      if (poll !== 0) window.clearInterval(poll)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      motionQuery.removeEventListener('change', onMotionChange)
    }
  }, [])

  return <canvas className="sidebar__fx" ref={canvasRef} aria-hidden="true" />
}
