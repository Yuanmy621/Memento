/**
 * 图标：统一走 `lucide-react`，这里只做名字与尺寸的收敛。
 *
 * 尺寸跟随界面（侧栏行 24px、标签栏 44px，图标基本 12~16px），线宽统一 1.75
 * （lucide 默认 2，小尺寸下偏粗）；具名 import 保证用不到的图标不进 bundle。
 * 保留 `Icon*` 前缀，换图标库时组件侧不用动。
 *
 * @module Memento/desktop/renderer/src/icons
 */

import {
  ArrowDownToLine, ArrowLeft, ChevronDown, Clock, Coins, Copy, ExternalLink,
  FileCode, FileImage, FileQuestionMark, FileText, FolderOpen, Gauge, GitBranch, ListTree,
  LoaderCircle, MessageSquare, PanelRightClose, PanelRightOpen, Plus,
  Repeat, Search, SendHorizontal, ShieldCheck, Sparkles, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'

/**
 * 图标属性：颜色一律 `currentColor`（由 CSS 决定）。
 * `className` 是给「转圈」这类整体动效留的钩子（例如 `IconSpinner className="spin"`）。
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

// 通用
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
/** 推理强度（模型「思考多少」）—— 输入区那一排的强度下拉用。 */
export const IconGauge = icon(Gauge)
/** git 分支：面包屑的分支段用。 */
export const IconBranch = icon(GitBranch)
/** 拉取最新（`git pull`）：面包屑分支段右边那个按钮。 */
export const IconPull = icon(ArrowDownToLine)
export const IconClose = icon(X)
export const IconCopy = icon(Copy)
export const IconSpinner = icon(LoaderCircle)
/** 思考（推理）块的头图标。 */
export const IconSparkle = icon(Sparkles)

// 标签栏 / 面板
export const IconChat = icon(MessageSquare)
export const IconTrace = icon(ListTree)
export const IconPanelOpen = icon(PanelRightOpen)
export const IconPanelClose = icon(PanelRightClose)

// 预览面板（按文件类型区分）
export const IconCodeFile = icon(FileCode)
export const IconImageFile = icon(FileImage)
export const IconFileQuestion = icon(FileQuestionMark)
export const IconFolderOpen = icon(FolderOpen)

/** 文件卡片等地方用的「普通文件」图标。 */
export const IconFile = icon(FileText)
