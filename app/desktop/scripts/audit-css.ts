/**
 * 样式审计：找出「上一个提交里有、现在没有、但界面代码还在用」的 CSS 类。
 *
 * ## 为什么要有这个脚本
 *
 * 清理死 CSS 最危险的形式是**按区间删**：本仓库就踩过一次 —— 删「轨迹时间线」那段时
 * 区间取成了「到下一个分节注释为止」，结果把夹在中间的**下拉菜单、提及菜单、统计行、
 * 纠偏气泡、指令 token、输入框 chip** 一起删了（它们的类名都还在 TSX 里，
 * 表现是这些地方突然没样式）。当时编译不报错、类型检查也过，只有肉眼看界面才发现。
 *
 * 这个脚本把那次的事后排查固化成一步：**拿 HEAD 的选择器集合与当前 CSS 做差集，
 * 再用渲染进程源码逐个验证「还有没有人用」** —— 有就是误删。
 *
 * 用法：`npm run audit:css`（退出码 1 表示发现误删）。
 *
 * @module Memento/desktop/scripts/audit-css
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cssPath = 'app/desktop/renderer/styles/app.css'
const srcDir = join(root, 'app/desktop/renderer/src')

/** 取某个版本的 CSS 文本。 */
function cssAt(revision: string): string {
  return execFileSync('git', ['show', `${revision}:${cssPath}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

/** 选择器集合（只看规则头，忽略 @media 内部）。 */
function selectors(css: string): Set<string> {
  const out = new Set<string>()
  for (const match of css.matchAll(/^([.#:a-zA-Z\[][^{}]*?)\{/gm)) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ')
    if (selector !== '') out.add(selector)
  }
  return out
}

/** 渲染进程里出现过的所有 class 名。 */
function usedClasses(): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (!/\.tsx?$/.test(entry)) continue
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        for (const token of `${match[1] ?? ''} ${match[2] ?? ''}`.split(/[\s${}]+/)) {
          const name = token.split(':')[0]?.replace(/^[^a-zA-Z]+/, '')
          if (name !== undefined && name !== '') out.add(name)
        }
      }
    }
  }
  walk(srcDir)
  return out
}

const before = selectors(cssAt('HEAD'))
const now = selectors(readFileSync(join(root, cssPath), 'utf8'))
const used = usedClasses()

const missing = [...before].filter((selector) => !now.has(selector))
const suspicious = missing.filter((selector) => {
  const classes = [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? '')
  return classes.length > 0 && classes.every((name) => used.has(name))
})

if (suspicious.length === 0) {
  console.log(`样式审计通过：HEAD 有 ${String(before.size)} 条选择器，当前缺 ${String(missing.length)} 条，其中没有仍被界面引用的。`)
  process.exit(0)
}

console.error(`⚠️ 疑似误删 ${String(suspicious.length)} 条（HEAD 里有、现在没有、但 className 还在用）：`)
for (const selector of suspicious) console.error(`   - ${selector}`)
console.error('\n恢复办法：`git show HEAD:' + cssPath + '` 里按选择器取回，并把旧令牌换成 foundation 令牌。')
process.exit(1)
