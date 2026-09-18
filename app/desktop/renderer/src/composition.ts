/**
 * 输入法（IME）组字守卫。
 *
 * ## 要解决的问题
 *
 * 中文 / 日文 / 韩文输入法在「组字中」时，回车是**确认候选词**，不是「提交」。
 * 但浏览器的 keydown 照样会派发，于是下面这种最常见的写法会在用户打词时
 * 把半成品当成消息发出去：
 *
 * ```tsx
 * if (event.key === 'Enter' && !event.shiftKey) submit()   // ❌ 组字中也会触发
 * ```
 *
 * ## 三个信号，缺一不可
 *
 * 1. **`nativeEvent.isComposing`** —— 最可靠的信号：事件自己带着「我发生在
 *    compositionstart 与 compositionend 之间」。注意 React 的合成事件**没有**
 *    这个属性（`SyntheticEvent` 上不存在 `isComposing`），必须从 `nativeEvent` 取。
 * 2. **`keyCode === 229`** —— Chromium 在 macOS 上有个已知边界情况：确认组字的
 *    那次回车，`compositionend` **先于** `keydown` 派发，等我们的处理函数运行时
 *    `isComposing` 已经是 `false`，只剩 `keyCode` 还是 229（「这次按键被输入法
 *    吃掉了」的历史哨兵值）。只查 `isComposing` 在 macOS 上会漏。
 * 3. **`compositionend` 之后紧邻的那一次按键** —— 兜住信号 2 之外的同任务顺序差异。
 *
 * ⚠️ 这里**不**用一个「组字中」的持久标志位做判断。真实教训是：某些输入法 /
 * 场景下 `compositionend` 可能不触发，标志位就永久卡在 `true`，表现是**回车彻底
 * 发不出去**。所以第 3 条用一个只活一个宏任务的临时标记（定时器一定会清掉），
 * 永远不会残留。
 *
 * ## 测试
 *
 * 判定逻辑抽成了纯函数 {@link isImeKeyEvent}，`scripts/ui-smoke.js` 直接跑真值表；
 * 「composition 事件真的挂上了」这一段由 `npm run desktop:smoke` 在真实窗口里验证。
 *
 * @module YuanMy/desktop/renderer/composition
 */

import { useCallback, useMemo, useRef, type KeyboardEvent } from 'react'

/** 「这次按键已被输入法处理」的历史哨兵值，Chromium 仍会在组字确认时带上。 */
export const IME_PROCESS_KEYCODE = 229

/** 判定所需的最小事件形状（方便单测，不必构造真实 KeyboardEvent）。 */
export interface ImeKeyShape {
  readonly isComposing?: boolean
  readonly keyCode?: number
}

/**
 * 这次按键是否应当被输入法守卫拦下（不当作「发送 / 中断」处理）。
 *
 * 纯函数，无副作用，便于单测。
 * @param native - 原生键盘事件（`event.nativeEvent`）。
 * @param justEndedComposition - 刚刚（同一个宏任务内）结束过组字。
 * @returns `true` 表示调用方应当完全忽略这次按键。
 */
export function isImeKeyEvent(native: ImeKeyShape, justEndedComposition: boolean): boolean {
  // ① 事件自带的信息最权威。
  if (native.isComposing === true) return true
  // ② macOS Chromium：compositionend 先于 keydown，只留下 229。
  if (native.keyCode === IME_PROCESS_KEYCODE) return true
  // ③ 兜底：组字刚结束的那一下。
  return justEndedComposition
}

/** {@link useImeGuard} 的返回值。 */
export interface ImeGuard {
  /**
   * 这次按键该不该被忽略。在 `onKeyDown` 里**第一句**就该问它。
   */
  readonly isImeKey: (event: KeyboardEvent<HTMLElement>) => boolean
  /** 要展开到输入元素上的组字事件监听。 */
  readonly compositionProps: {
    readonly onCompositionStart: () => void
    readonly onCompositionEnd: () => void
  }
}

/**
 * 给输入元素加一层输入法守卫。
 *
 * 用法：
 * ```tsx
 * const ime = useImeGuard()
 * <textarea
 *   {...ime.compositionProps}
 *   onKeyDown={(event) => {
 *     if (ime.isImeKey(event)) return          // ← 第一句
 *     if (event.key === 'Enter' && !event.shiftKey) submit()
 *   }}
 * />
 * ```
 * @returns 判定函数与组字事件监听。
 */
export function useImeGuard(): ImeGuard {
  /** 组字刚刚结束的临时标记；只活一个宏任务，绝不会残留。 */
  const justEndedRef = useRef(false)
  /** 定时器句柄，避免上一次的清理把这一次的标记提前抹掉。 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const compositionProps = useMemo(() => ({
    onCompositionStart: () => {
      // 进入组字时先撤销可能还在待清理的「刚结束」标记。
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      justEndedRef.current = false
    },
    onCompositionEnd: () => {
      // 见模块注释第 3 条：不做持久标志位，只让它在当前任务内有效。
      justEndedRef.current = true
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        justEndedRef.current = false
        timerRef.current = null
      }, 0)
    },
  }), [])

  const isImeKey = useCallback((event: KeyboardEvent<HTMLElement>) => {
    return isImeKeyEvent(event.nativeEvent, justEndedRef.current)
  }, [])

  return { isImeKey, compositionProps }
}
