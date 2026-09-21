/**
 * 图标：**统一走 [lucide-react](https://lucide.dev/)**，这个文件只做「名字与尺寸的收敛」。
 *
 * ## 为什么从手写 SVG 换成图标库
 *
 * 早先这里是自己画 SVG（12 个）。到「轨迹按角色区分 + 会话导航条 + 预览面板」这一步，
 * 需要的图标变成 30 个上下：手写既慢又难统一（线宽、圆角、视觉重心各画各的）。
 * lucide 的图标是 24px 网格、`currentColor` 描边，与本项目的单色图标风格一致，
 * 而且**按需引入**（具名 import → Tree-shaking，用不到的不进 bundle）。
 *
 * ## 为什么还要包一层
 *
 * 三件事集中在这里，别散到各个组件里：
 *   1. **尺寸**：本项目界面偏紧（侧栏行 24px、标签栏 44px），图标基本是 12~16px；
 *   2. **线宽**：lucide 默认 2，在小尺寸下略粗，这里统一降到 1.75；
 *   3. **命名**：保留 `Icon*` 前缀，改图标库时组件侧不用动。
 *
 * @module YuanMy/desktop/renderer/src/icons
 */

import {
  ArrowLeft, Brain, ChevronDown, CircleAlert, Clock, Coins, Copy, ExternalLink,
  FileCode, FileImage, FileQuestionMark, FileText, FolderOpen, Info, ListTree,
  LoaderCircle, MessageSquare, MessagesSquare, PanelRightClose, PanelRightOpen, Plus,
  Repeat, Search, SendHorizontal, ShieldCheck, SquareTerminal, Target,
  User, Wrench, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'

/**
 * 图标属性。
 *
 * 颜色一律 `currentColor`（由 CSS 决定），所以这里只有尺寸和一个 class ——
 * class 是给「转圈」这类整体动效留的钩子（例如 `IconSpinner className="spin"`）。
 */
export interface IconProps {
  readonly size?: number
  readonly className?: string
}

/** 把 lucide 图标包成项目里统一的 `Icon*` 组件。 */
function icon(Component: LucideIcon): (props: IconProps) => ReactElement {
  return function Icon({ size = 16, className }: IconProps): ReactElement {
    return <Component size={size} strokeWidth={1.75} className={className} aria-hidden />
  }
}

// ── 通用 ────────────────────────────────────────────────────────────────────
export const IconSearch = icon(Search)
export const IconPlus = icon(Plus)
export const IconChevronDown = icon(ChevronDown)
export const IconBack = icon(ArrowLeft)
export const IconSend = icon(SendHorizontal)
export const IconExternal = icon(ExternalLink)
export const IconShield = icon(ShieldCheck)
export const IconToken = icon(Coins)
export const IconClock = icon(Clock)
export const IconTurns = icon(Repeat)
export const IconClose = icon(X)
export const IconCopy = icon(Copy)
export const IconSpinner = icon(LoaderCircle)

// ── 标签栏 / 面板 ───────────────────────────────────────────────────────────
export const IconChat = icon(MessageSquare)
export const IconTrace = icon(ListTree)
export const IconPanelOpen = icon(PanelRightOpen)
export const IconPanelClose = icon(PanelRightClose)

// ── 轨迹（按角色区分）────────────────────────────────────────────────────────
export const IconUser = icon(User)
export const IconReasoning = icon(Brain)
export const IconReply = icon(MessagesSquare)
export const IconTool = icon(Wrench)
export const IconBug = icon(CircleAlert)
export const IconNote = icon(Info)
export const IconShell = icon(SquareTerminal)
export const IconGoal = icon(Target)

// ── 预览面板（按文件类型区分）───────────────────────────────────────────────
export const IconCodeFile = icon(FileCode)
export const IconImageFile = icon(FileImage)
export const IconFileQuestion = icon(FileQuestionMark)
export const IconFolderOpen = icon(FolderOpen)

/** 文件卡片等地方用的「普通文件」图标。 */
export const IconFile = icon(FileText)
/** 没有类型可判断时的中性图标。 */
