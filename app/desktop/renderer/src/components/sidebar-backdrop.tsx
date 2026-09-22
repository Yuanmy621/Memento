/**
 * 侧栏背景的柱面粒子层：把 {@link ./sidebar-cylinder} 的纯模拟画到一块 canvas 上。
 *
 * ## 它只做「DOM 那半边」
 *
 * | 归它管 | 归 `sidebar-cylinder.ts` 管 |
 * | --- | --- |
 * | canvas / DPR / ResizeObserver | 柱面投影（列的位置与宽度）、明暗、纵向强度 |
 * | rAF 循环、帧率、`dt` 夹上限 | 小块的周期、被切下来的位移与消散曲线 |
 * | 暂停条件（窗口隐藏 / 系统「减弱动态效果」） | —— |
 * | 颜色与两遍绘制顺序 | —— |
 *
 * ## 绘制的两遍（顺序不能换）
 *
 * 1. **还在柱面上的格子**（轴对齐的 `fillRect`，便宜）——正在滚的那些**跳过**，
 *    它们的格子在画面上留空，那才是「被切走了一块」；
 * 2. **滚出去的碎屑**（`save/translate/rotate/fillRect/restore`）——画在最后，
 *    因为它们是「已经离开表面、离观察者更近」的东西。
 *
 * ## 三条不做就会出事的规则
 *
 * 1. **必须尊重 `prefers-reduced-motion`**：系统里开了「减弱动态效果」的人是真的会被
 *    持续动的东西弄难受，而这个效果**信息量为零**。命中时直接不启动循环，并清空画布。
 * 2. **窗口不可见时必须停**（`visibilitychange`）：侧栏在后台每帧还画一次 canvas 是白烧电。
 * 3. **`dt` 要夹上限**（{@link MAX_FRAME_MS}）：切回前台/系统卡顿后 `now - last` 可能是
 *    好几秒，不夹的话所有碎屑会「闪现」到远处。
 *
 * 另外两条是性能要求：**每帧不读布局**（尺寸只在 `ResizeObserver` 里读一次并缓存）、
 * 帧率压到 **30fps**、DPR 上限 **1.5** —— 这三条一起把渲染进程开销从 20% 压到几个百分点。
 *
 * canvas 是 `pointer-events: none` + `aria-hidden`：不参与交互，也不该被读屏软件念出来。
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

/** 单帧最大步进（ms）。见文件头第 3 条。 */
const MAX_FRAME_MS = 48

/**
 * 目标帧率。
 *
 * **30fps 就够**：这是一层 5~20% 不透明度的背景，不是动画片；60fps 在观感上看不出差别，
 * 但渲染进程开销直接翻倍（实测：一个被遮住的窗口上，60fps 约 20%，30fps + 不读布局之后是几个百分点）。
 */
const FRAME_INTERVAL_MS = 1000 / 30

/**
 * 画布像素上限倍率。
 *
 * 不用系统的 2 倍：这些是纯色小方块（5~25% 不透明度），1.25 倍与 2 倍的区别肉眼不可见，
 * 但**光栅化的开销几乎正比于覆盖的像素数**。整面柱面网格的覆盖率约 20%，
 * 实测 1.5 倍时渲染进程 ~9.6%、1.25 倍时 ~6.5%（同一台机器、窗口被遮住时的 TaskDuration 口径）。
 */
const MAX_DPR = 1.25

/** 系统「减弱动态效果」的媒体查询。 */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/**
 * 从 CSS 变量里取颜色。
 *
 * 为什么不在 JS 里写死 rgb：这个仓库的规矩是**配色一律走令牌**（见 `app.css` 的 `@theme`），
 * 粒子色也得跟着主题/磨砂玻璃变。读不到就给一个很淡的白 —— 它只是背景，宁可看不见也不要报错。
 *
 * @param node - 任意挂在文档里的元素（借它读计算样式）。
 * @param name - CSS 变量名。
 * @param fallback - 兜底颜色。
 * @returns 可以直接喂给 `fillStyle` 的颜色字符串。
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
    /** 缓存的逻辑尺寸：**不在每帧读 `clientWidth`**，那会强制布局，是卡顿的经典来源。 */
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
     *
     * ⚠️ 只在「挂载 / 尺寸变化 / 重新开始」时调它。放进每帧循环里读 `clientWidth`
     * 会每帧强制一次布局计算 —— canvas 动画最常见的性能坑。
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
      // ── 第一遍：还在柱面上的格子（轴对齐，便宜）─────────────────────────
      context.fillStyle = surfaceColor
      for (let row = 0; row < rows; row += 1) {
        for (let dense = 0; dense < active.dense; dense += 1) {
          const cell = tileFrame(active, dense, row, scratch)
          if (cell === null || cell.detached || cell.alpha <= 0.002) continue
          context.globalAlpha = cell.alpha
          context.fillRect(cell.x, cell.y, cell.width, cell.height)
        }
      }
      // ── 第二遍：被切下来、正在向右滚的碎屑（要旋转，画在最上面）──────────
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
     * 停着的时候，盯着「什么时候能再开」。
     *
     * 正常路径是 `matchMedia` 的 `change` 事件，但**不能只靠它**：某些环境下
     * （切换模拟、某些平台的设置变更）事件不一定派发，那样效果会一直停着不回来。
     * 这里每 1.5s 复查一次查询条件，条件满足就自己恢复 —— 一个定时器的成本，
     * 换掉一整类「设置改回去了但画面还是死的」的静默故障。
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

    /** 停循环并清屏 —— 停之前必须清，否则会留一帧残影在原地。 */
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
    // 一开始就不可见（后台启动）时也别起循环。
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
