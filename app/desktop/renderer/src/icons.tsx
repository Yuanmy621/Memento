/**
 * 界面图标：内联 SVG，不引图标库。
 *
 * 规则：只用 `currentColor`（所以「白色图标」由容器字色决定，侧栏里就是白的），
 * `stroke-width: 1.5`、`stroke-linecap: round`，尺寸由 `size` 参数给 ——
 * 与官方 ui-primitives 里图标的观感一致：细、线性、无填充。
 *
 * @module YuanMy/desktop/renderer/icons
 */

import type { ReactElement } from 'react'

/** 所有图标共用的属性。 */
interface IconProps {
  /** 边长（px），默认 16。 */
  readonly size?: number
  /** 附加类名。 */
  readonly className?: string
}

/** 统一的 svg 外壳。 */
function Svg({ size = 16, className, children }: IconProps & { readonly children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** 搜索。 */
export const IconSearch = (props: IconProps): ReactElement => (
  <Svg {...props}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></Svg>
)

/** 新建（加号）。 */
export const IconPlus = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="M12 5v14M5 12h14" /></Svg>
)

/** 下拉箭头。 */
export const IconChevronDown = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="m6 9 6 6 6-6" /></Svg>
)

/** 会话（对话气泡）。 */
export const IconChat = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" /></Svg>
)

/** 轨迹（分支 / 时间线）。 */
export const IconTrace = (props: IconProps): ReactElement => (
  <Svg {...props}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 8.5v7M11 6h7M11 18h7" /></Svg>
)

/** 发送。 */
export const IconSend = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="M4.5 12 20 4.5 15 20l-3.4-6.1z" /><path d="m11.6 13.9 3.4-3.4" /></Svg>
)

/** 文件。 */
export const IconFile = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Svg>
)

/** 文件夹。 */
export const IconFolder = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>
)

/** 外部打开。 */
export const IconExternal = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></Svg>
)

/** 权限（盾牌）。 */
export const IconShield = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" /></Svg>
)

/** 用量（令牌）。 */
export const IconToken = (props: IconProps): ReactElement => (
  <Svg {...props}><circle cx="12" cy="12" r="8" /><path d="M12 8v8M9.5 10h5M9.5 14h5" /></Svg>
)

/** 耗时（时钟）。 */
export const IconClock = (props: IconProps): ReactElement => (
  <Svg {...props}><circle cx="12" cy="12" r="8" /><path d="M12 8v4.5l3 1.8" /></Svg>
)

/** 轮次（列表）。 */
export const IconTurns = (props: IconProps): ReactElement => (
  <Svg {...props}><path d="M4 7h16M4 12h16M4 17h10" /></Svg>
)
