/**
 * 输入法（IME）组字守卫：组字中的回车是「确认候选词」，不是「提交」。
 *
 * 判定用三个信号：`nativeEvent.isComposing`、`keyCode === 229`（macOS Chromium 上
 * `compositionend` 先于 `keydown`，只剩这个哨兵值），以及 `compositionend` 后紧邻的一次按键。
 * 组字标记只活一个宏任务 —— 某些输入法不触发 `compositionend`，持久标志位会卡死回车。
 *
 * @module Memento/desktop/renderer/composition
 */

import { useCallback, useMemo, useRef } from 'react'

/** 「这次按键已被输入法处理」的哨兵值，Chromium 在组字确认时仍会带上。 */
export const IME_PROCESS_KEYCODE = 229

/** 判定所需的最小事件形状，便于单测而不构造真实 `KeyboardEvent`。 */
export interface ImeKeyShape {
  readonly isComposing?: boolean
  readonly keyCode?: number
}

/**
 * 这次按键是否应当被输入法守卫拦下（不当作「发送 / 中断」处理）。
 * `native` 是原生键盘事件；`justEndedComposition` 指刚刚在同一宏任务内结束过组字，返回 `true` 时忽略按键。
 */
export function isImeKeyEvent(native: ImeKeyShape, justEndedComposition: boolean): boolean {
  // 事件自带的信息最权威：它发生在 compositionstart 与 compositionend 之间。
  if (native.isComposing === true) return true
  // macOS Chromium：compositionend 先于 keydown，只留下 229 这个哨兵值。
  if (native.keyCode === IME_PROCESS_KEYCODE) return true
  // 兜底：组字刚结束的那一下。
  return justEndedComposition
}

/** {@link useImeGuard} 的返回值。 */
export interface ImeGuard {
  /** 这次按键该不该被忽略；`onKeyDown` 第一句就问它（参数是原生事件，React 取 `event.nativeEvent`）。 */
  readonly isImeKeyNative: (event: ImeKeyShape) => boolean
  /** 要展开到输入元素上的组字事件监听。 */
  readonly compositionProps: {
    readonly onCompositionStart: () => void
    readonly onCompositionEnd: () => void
  }
}

/**
 * 给输入元素加一层输入法守卫，返回判定函数与组字事件监听。
 * textarea 把 `compositionProps` 展开到元素上；富文本输入框的键盘回调在 ProseMirror 里拿不到
 * React 事件，但组字事件会冒泡，挂到外层容器（`.composer__box`）即可，判定照旧用 `isImeKeyNative`。
 */
export function useImeGuard(): ImeGuard {
  /** 组字刚刚结束的临时标记：只活一个宏任务，不会残留。 */
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
      // 不做持久标志位：只让标记在当前任务内有效，避免输入法不触发 compositionend 时卡死。
      justEndedRef.current = true
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        justEndedRef.current = false
        timerRef.current = null
      }, 0)
    },
  }), [])

  const isImeKeyNative = useCallback((event: ImeKeyShape) => {
    return isImeKeyEvent(event, justEndedRef.current)
  }, [])

  return { isImeKeyNative, compositionProps }
}
