/**
 * `cn()`：class 合并助手（shadcn 生态的标准写法，Beautiful UI 的组件都 import 它）。
 *
 * `clsx` 负责条件拼接，`tailwind-merge` 负责**去重冲突的 Tailwind 类** ——
 * 后者才是关键：组件给了默认 `px-3`、调用方又传 `px-5` 时，没有它两个类都会留在
 * class 里，谁生效取决于 CSS 生成顺序（看起来像「传了没用」）。
 *
 * @module Memento/desktop/renderer/src/ui/beautifului/lib/utils
 */

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 合并一串 class。
 * @param inputs - 任意 class 片段（支持条件写法）。
 * @returns 合并后的 class 字符串。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
