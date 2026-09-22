/**
 * 通用浮层菜单：一个触发器 + 一个键盘可操作的菜单。
 *
 * 从输入框那三个下拉（`+` 新建 / 权限 / 模型）里抽出来的 —— 它们原本各写各的、
 * 只有一个「点空白关掉」的遮罩。抽成公共组件之后顺手补齐了缺的那些**真菜单该有的东西**：
 *
 * | 能力 | 为什么要 |
 * | --- | --- |
 * | ↑ / ↓ / Home / End 移动高亮 | 用键盘选是菜单的基本预期，鼠标只是其中一条路 |
 * | Enter / Space 选中、Esc 关闭 | Esc 关掉后**焦点回到触发器**，接着按方向键还能再打开 |
 * | `role="menu"` / `menuitem` + `aria-haspopup` / `aria-expanded` | 读屏软件靠它知道「这是一个菜单、现在开着」 |
 * | 点外面关掉（`pointerdown` 监听，不用整屏遮罩） | 遮罩会挡住底下的一切交互，而且它本身只是个「点了就关」的 hack |
 * | 向上 / 向下弹、贴哪一边、限高滚动 | 输入区那三个下拉在底部，必须往上弹；条目多了一屏放不下要能滚 |
 *
 * 为什么不用 Radix / headless 那类库：**输入框那一侧不能用**（`@` 候选菜单必须由编辑器
 * 持有焦点与按键，库会和 ProseMirror 抢）；为输入区三个下拉单独引一套依赖也不划算。
 * 这份实现只有两百来行，行为边界清楚。真要继续加菜单（右键菜单、子菜单）时，
 * 再按 README「自研 vs 成熟组件」里那条建议整体换 Radix 更划算。
 *
 * @module Memento/desktop/renderer/src/components/menu
 */

import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactElement,
} from 'react'
import { IconChevronDown } from '../icons.tsx'
import { buttonVariants } from '../ui/beautifului/atoms/Button.tsx'
import { cn } from '../ui/beautifului/lib/utils.ts'

/** 菜单里的一行。 */
export interface MenuEntry {
  /** 稳定 key。 */
  readonly key: string
  /**
   * 行的类型：
   *   - `item`：可点的一项（默认）；
   *   - `block`：整段说明文字（不可点，例如权限菜单那段「无沙箱」的解释）。
   */
  readonly kind?: 'item' | 'block'
  /** 主文案（中文功能名 / 选项名）。 */
  readonly label?: string
  /** 次要说明（一行小字，显示出来，可省）。 */
  readonly note?: string
  /** 鼠标悬停时的完整提示（可省；默认用 `note`）。 */
  readonly hint?: string
  /** 左侧图标（可省）。 */
  readonly icon?: ReactElement
  /** 当前选中项：右侧打勾并染成强调色。 */
  readonly active?: boolean
  readonly disabled?: boolean
  /** 选中回调（`item` 才有意义）。 */
  readonly onSelect?: () => void
}

export interface MenuProps {
  /** 悬停提示 / 无障碍名。 */
  readonly title: string
  readonly entries: readonly MenuEntry[]
  /** 触发器左侧图标。 */
  readonly icon?: ReactElement
  /** 触发器文案（为空则只有图标）。 */
  readonly label?: string
  /** 触发器和图标后面要不要那个小三角（侧栏的「N 工具」不要）。 */
  readonly caret?: boolean
  readonly disabled?: boolean
  /** 菜单从触发器的哪一侧弹出。 */
  readonly side?: 'top' | 'bottom'
  /** 与触发器左对齐还是右对齐。 */
  readonly align?: 'start' | 'end'
  /** 菜单宽度（像素）。 */
  readonly width?: number
}

/** 菜单里可以落焦点的行（跳过整段说明那种不可点的行）。 */
function isFocusable(entry: MenuEntry): boolean {
  return (entry.kind ?? 'item') === 'item' && entry.disabled !== true
}

export function Menu(props: MenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  /** 键盘高亮的下标（-1 = 还没进菜单）。 */
  const [cursor, setCursor] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const close = useCallback((refocus: boolean): void => {
    setOpen(false)
    setCursor(-1)
    if (refocus) triggerRef.current?.focus()
  }, [])

  /**
   * **刚打开**那一刻：把焦点交给菜单本身（键盘事件才接得住），高亮落在「当前项」或第一项。
   *
   * ⚠️ 依赖里刻意**只有 `open`**：`entries` 是调用方每次渲染现拼的数组，
   * 把它放进依赖会让「鼠标划过某项 → 重渲染 → 这个 effect 又把高亮弹回第一项」，
   * 键盘与鼠标就打架了。打开后的高亮只归 `move()` / `onMouseEnter` 管。
   */
  useEffect(() => {
    if (!open) return
    const entries = props.entries
    const first = entries.findIndex(isFocusable)
    const active = entries.findIndex((entry) => entry.active === true && isFocusable(entry))
    setCursor(active >= 0 ? active : first)
    popRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上面那段：只在打开时定位一次
  }, [open])

  // 点外面关掉：用 pointerdown（比 click 早，且拖选文字时不会误关）
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      const node = event.target
      if (!(node instanceof Node)) return
      if (popRef.current?.contains(node) === true) return
      if (triggerRef.current?.contains(node) === true) return
      close(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => { document.removeEventListener('pointerdown', onDown, true) }
  }, [close, open])

  /** 可落点项的下标（跳过分组标题与说明行）。 */
  const selectable = useCallback((): number[] => {
    return props.entries.map((entry, index) => (isFocusable(entry) ? index : -1)).filter((index) => index >= 0)
  }, [props.entries])

  /** 当前高亮行的下一个 / 上一个可落点项（循环）。`step = 0` 表示从头/尾开始。 */
  const move = useCallback((step: number): void => {
    const list = selectable()
    if (list.length === 0) return
    if (step === 0) { setCursor(list[0] ?? -1); return }
    if (step === -1 && cursor === -1) { setCursor(list[list.length - 1] ?? -1); return }
    const at = list.indexOf(cursor)
    const next = at < 0
      ? (step > 0 ? list[0] : list[list.length - 1])
      : list[(at + step + list.length) % list.length]
    setCursor(next ?? -1)
  }, [cursor, selectable])

  /** Home / End 直接跳到两端。 */
  const jump = useCallback((where: 'first' | 'last'): void => {
    const list = selectable()
    if (list.length === 0) return
    setCursor(where === 'first' ? (list[0] ?? -1) : (list[list.length - 1] ?? -1))
  }, [selectable])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(1); break
      case 'ArrowUp': event.preventDefault(); move(-1); break
      case 'Home': event.preventDefault(); jump('first'); break
      case 'End': event.preventDefault(); jump('last'); break
      case 'Escape': event.preventDefault(); close(true); break
      case 'Tab': close(true); break
      case 'Enter': {
        event.preventDefault()
        const entry = props.entries[cursor]
        if (entry === undefined || !isFocusable(entry)) break
        entry.onSelect?.()
        close(true)
        break
      }
      default: break
    }
  }, [close, cursor, jump, move, props.entries])

  const hasSelectable = props.entries.some(isFocusable)

  return (
    <div className="menu">
      <button
        type="button"
        ref={triggerRef}
        className={cn(buttonVariants({ variant: 'quiet', size: 'xs' }), 'menu__trigger no-drag')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled ?? false}
        title={props.title}
        onClick={() => { setOpen((value) => !value) }}
      >
        {props.icon}
        {props.label !== undefined && props.label !== '' && <span className="menu__label">{props.label}</span>}
        {props.caret === true && <IconChevronDown size={12} />}
      </button>
      {open && (
        <div
          ref={popRef}
          className={`menu__pop menu__pop--${props.side ?? 'top'} menu__pop--${props.align ?? 'start'}`}
          role="menu"
          tabIndex={-1}
          aria-label={props.title}
          style={props.width === undefined ? undefined : { width: `${String(props.width)}px` }}
          onKeyDown={onKeyDown}
        >
          {props.entries.map((entry, index) => {
            if ((entry.kind ?? 'item') === 'block') {
              return <div key={entry.key} className="menu__block">{entry.label}</div>
            }
            return (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                className={`menu__item${entry.active === true ? ' menu__item--active' : ''}${index === cursor && hasSelectable ? ' menu__item--cursor' : ''}`}
                disabled={entry.disabled ?? false}
                // title 给「完整解释」：说明之外还能塞原名之类的排查信息
                title={entry.hint ?? entry.note ?? entry.label ?? ''}
                onMouseEnter={() => { setCursor(index) }}
                onClick={() => { entry.onSelect?.(); close(true) }}
              >
                {entry.icon !== undefined && <span className="menu__icon">{entry.icon}</span>}
                <span className="menu__text">
                  <span className="menu__name">{entry.label}</span>
                  {entry.note !== undefined && entry.note !== '' && <span className="menu__note">{entry.note}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
