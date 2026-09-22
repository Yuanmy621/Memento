/**
 * 面包屑：**当前会话的工作目录 + git 分支**（分支可切换）。
 *
 * ## 为什么要有它
 *
 * agent 干活的地方是一个目录，而那个目录多半是个 git 仓库 —— 「现在在哪个项目、
 * 哪个分支上」是用这个工具时最常被问到的两件事。以前顶栏只在右端写了一整行绝对路径
 * （`topbar__sub`）：看不出层级，也看不出分支。现在换成一条正经的面包屑：
 * 路径按段展示，有 git 时在后面接一段**可切换**的分支。
 *
 * 摆放位置是**输入框正上方**（`App` 通过 `Composer` 的 `above` 插槽传进来）：
 * 于是它自动与输入卡同宽同中心，也不占主区的一条网格行。
 *
 * ## 职责边界：这里只画，不碰 git
 *
 *   - **路径**：纯展示，数据来自当前会话（`cwd`）。
 *   - **分支**：探测与切换都在**主进程**（`main.ts` 的 `readGit` / `switchGitBranch`）——
 *     渲染进程是网页，拿不到 fs 也起不了子进程，也不该拿到。它只负责画、把用户
 *     点的分支名送回去、把 git 说的话显示出来。
 *
 * ## 分支段的四个细节
 *
 *   1. **只在真的是 git 仓库时出现**（`repo`）。非仓库、没装 git、目录被删都只是
 *      「没有这一段的理由」，不是错误 —— 路径照常显示，不打扰用户。
 *   2. **切换走白名单**：菜单里的分支名原样送回主进程，由主进程对照它自己列过的
 *      分支校验。界面这边不拼命令、不做「智能」推断，注入面因此在协议层就关掉了。
 *   3. **失败原因原样显示**：git 的 stderr（「Your local changes would be
 *      overwritten by checkout…」）比我们编的文案准得多，直接贴在面包屑右端
 *      （长文本省略，全文在 `title` 里）。刻意**不**往会话里塞一条系统提示 ——
 *      这是面包屑上的局部动作，不该污染对话记录。
 *   4. **打开菜单时重新探测一次**（`onRefresh`）：分支随时可能被 agent 用 bash
 *      或用户在终端里改掉，列表过期比报错更烦人。
 *
 * @module Memento/desktop/renderer/components/breadcrumb
 */

import { Fragment, useState, type ReactElement } from 'react'
import { Menu, type MenuEntry } from './menu.tsx'
import { IconBranch } from '../icons.tsx'
import type { GitStatus } from '../use-agent.ts'

/** 面包屑里的一段路径。 */
interface Crumb {
  /** 显示的文字（家目录那一段是 `~`）。 */
  readonly label: string
  /** hover 时的路径（逐段累积）。 */
  readonly title: string
}

/** 最多显示几段；超了就折叠中间（保留首段 + 末两段）。 */
const MAX_SEGMENTS = 4

/**
 * 把工作目录切成面包屑。
 *
 * 家目录缩写成 `~`（`/Users/me/work/app` → `~ / work / app`）：绝对路径的前几段
 * 对用户没有信息量，占的却是最宝贵的横向空间。
 * @param cwd - 工作目录（绝对路径）。
 * @param home - 家目录（主进程给的 `appInfo.home`）；拿不到时空串，只影响缩写。
 * @returns 从根到当前目录的段；`cwd` 为空时是空数组。
 */
function crumbsOf(cwd: string, home: string): Crumb[] {
  if (cwd === '') return []
  const sep = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter((part) => part !== '')
  const homeParts = home === '' ? [] : home.split(/[\\/]+/).filter((part) => part !== '')
  const atHome = homeParts.length > 0 && parts.length >= homeParts.length
    && homeParts.every((part, index) => parts[index] === part)
  if (atHome) {
    parts.splice(0, homeParts.length, '~')
  } else if (sep === '/') {
    // 绝对路径补一个根段，否则 `/usr` 看起来像个相对路径。
    parts.unshift('/')
  }
  let acc = ''
  const all = parts.map((part) => {
    acc = acc === '' ? part : (acc === '/' ? `/${part}` : `${acc}${sep}${part}`)
    return { label: part, title: acc }
  })
  if (all.length <= MAX_SEGMENTS) return all
  const head = all[0]
  // 首段（`~` 或根）+ 末两段：中间折叠掉，末尾那两段才是「我在哪」。
  return head === undefined ? all : [head, { label: '…', title: cwd }, ...all.slice(-2)]
}

export interface BreadcrumbProps {
  /** 当前会话的工作目录（绝对路径）；空串 = 还没有会话，整条不渲染。 */
  readonly cwd: string
  /** 主进程给的家目录（`appInfo.home`）。 */
  readonly home: string
  /** 当前目录的 git 情况；null = 还没探测到 / 探测失败。 */
  readonly git: GitStatus | null
  /** 正在探测或正在切分支。 */
  readonly busy: boolean
  /** 重新探测一次（打开分支菜单时调用）。 */
  readonly onRefresh: () => void
  /** 切分支；成功返回空串，失败返回要显示给用户的原因。 */
  readonly onSwitch: (branch: string) => Promise<string>
}

export function Breadcrumb(props: BreadcrumbProps): ReactElement | null {
  const { cwd, home, git, busy, onRefresh, onSwitch } = props
  /** 上一次切换失败的原因；重新探测或再次切换时清掉。 */
  const [error, setError] = useState('')
  if (cwd === '') return null

  const crumbs = crumbsOf(cwd, home)
  const repo = git !== null && git.repo
  /** 分支段的文字：正常是分支名，detached 时是 `detached@<短 SHA>`。 */
  const current = git === null
    ? ''
    : (git.branch !== '' ? git.branch : (git.detached === '' ? '' : `detached@${git.detached}`))

  /** 切一个分支，把 git 的话原样留下来。 */
  const pick = async (branch: string): Promise<void> => {
    setError('')
    const message = await onSwitch(branch)
    if (message !== '') setError(message)
  }

  /** 菜单项：本地分支（可切）→ 远程分支（切了会新建同名的本地跟踪分支）。 */
  const entries: MenuEntry[] = []
  if (git !== null) {
    if (git.local.length === 0) {
      entries.push({ key: 'l:none', kind: 'block', label: '这个仓库还没有本地分支（还没提交过？）' })
    }
    for (const name of git.local) {
      entries.push({
        key: `l:${name}`,
        label: name,
        active: name === git.branch,
        hint: name === git.branch ? `${name}（当前分支）` : `切到 ${name}`,
        onSelect: () => { void pick(name) },
      })
    }
    if (git.remote.length > 0) {
      entries.push({ key: 'r:head', kind: 'block', label: '远程分支 · 切换会新建同名的本地跟踪分支' })
      for (const name of git.remote) {
        entries.push({
          key: `r:${name}`,
          label: name,
          note: '远程',
          hint: `切到 ${name}（新建本地跟踪分支）`,
          onSelect: () => { void pick(name) },
        })
      }
    }
  }

  const branchTitle = git === null
    ? '正在读 git…'
    : [
      `分支 ${current === '' ? '（未知）' : current}`,
      git.dirty > 0 ? `工作区有 ${String(git.dirty)} 个未提交的改动` : '工作区干净（只看已跟踪文件）',
      git.root === '' ? '' : git.root,
    ].filter((line) => line !== '').join('\n')

  return (
    <nav className="crumbs" aria-label="工作目录与 git 分支">
      <ol className="crumbs__path">
        {crumbs.map((crumb, index) => (
          <Fragment key={`${String(index)}:${crumb.label}`}>
            {index > 0 && <li className="crumbs__gap" aria-hidden>/</li>}
            <li
              className="crumbs__seg"
              title={crumb.title}
              aria-current={index === crumbs.length - 1 ? 'location' : undefined}
            >
              {crumb.label}
            </li>
          </Fragment>
        ))}
      </ol>

      {repo && (
        <>
          <span className="crumbs__divider" aria-hidden />
          <Menu
            icon={<IconBranch size={12} className="crumbs__branch-icon" />}
            label={current === '' ? '分支' : current}
            title={branchTitle}
            caret
            // 向上弹：面包屑在窗口**底部**（输入框正上方），往下弹会出画面
            // —— 和输入区那排下拉同一个方向。
            side="top"
            disabled={busy}
            width={280}
            entries={entries}
            onOpen={onRefresh}
          />
        </>
      )}

      {error !== '' && (
        <span className="crumbs__error" role="status" title={error}>{error}</span>
      )}
    </nav>
  )
}
