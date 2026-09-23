/**
 * 面包屑：当前会话的工作目录 + git 分支，以及切分支 / 拉取两个控件。
 *
 * 路径按段展示，家目录缩写成 `~`，超过 `MAX_SEGMENTS` 段时折叠中间、保留首段与末两段；
 * 分支段只在真的是 git 仓库时出现。切分支与拉取分成两个控件，避免「先切再拉？」的歧义。
 * 探测、切换、拉取都在主进程（`readGit` / `switchGitBranch` / `pullGitBranch`）。
 *
 * @module Memento/desktop/renderer/components/breadcrumb
 */

import { Fragment, useEffect, useState, type ReactElement } from 'react'
import { Menu, type MenuEntry } from './menu.tsx'
import { IconBranch, IconPull, IconSpinner } from '../icons.tsx'
import type { GitActionResult, GitStatus } from '../use-agent.ts'

/** 面包屑里的一段路径。 */
interface Crumb {
  /** 显示的文字（家目录那一段是 `~`）。 */
  readonly label: string
  /** hover 时的路径（逐段累积）。 */
  readonly title: string
}

/** 最多显示几段；超了就折叠中间（保留首段 + 末两段）。 */
const MAX_SEGMENTS = 4

/** 成功回执在屏幕上留多久（毫秒）。失败的那句不走这个计时器。 */
const NOTICE_MS = 6_000

/**
 * 把工作目录切成面包屑：家目录（`appInfo.home`，拿不到时给空串，只影响缩写）缩写成 `~`，
 * 非家目录的绝对路径补一个根段；`cwd` 为空时返回空数组，否则是从根到当前目录的段。
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
  // 首段（`~` 或根）+ 末两段才是「我在哪」，中间折叠掉。
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
  /** 切分支；成功时 `message` 为空（分支名自己会变），失败时是要显示的原因。 */
  readonly onSwitch: (branch: string) => Promise<GitActionResult>
  /** 拉取当前分支最新；成功时 `message` 是 git 的结论（「Already up to date.」/ diffstat）。 */
  readonly onPull: () => Promise<GitActionResult>
}

export function Breadcrumb(props: BreadcrumbProps): ReactElement | null {
  const { cwd, home, git, busy, onRefresh, onSwitch, onPull } = props
  /** 上一次动作要显示的一句话；再次动作或自动过期时清掉。 */
  const [notice, setNotice] = useState<GitActionResult | null>(null)

  /**
   * 成功那句话会自己淡出：它是回执，不是状态。失败那句留着，等用户处理。
   *
   * 这个 effect 要排在下面那个提前 return 之前：hooks 不能有条件地调用。
   */
  useEffect(() => {
    if (notice === null || !notice.ok) return
    const timer = setTimeout(() => { setNotice(null) }, NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [notice])

  if (cwd === '') return null

  const crumbs = crumbsOf(cwd, home)
  const repo = git !== null && git.repo
  /** 分支段的文字：正常是分支名，detached 时是 `detached@<短 SHA>`。 */
  const current = git === null
    ? ''
    : (git.branch !== '' ? git.branch : (git.detached === '' ? '' : `detached@${git.detached}`))

  /**
   * 跑一个 git 动作并把结果留下来显示。切分支成功时 `message` 为空（分支名自己会变），
   * 那一格自然不出现；拉取成功则要有一句话，好区分「已是最新」与「真拉到了东西」。
   */
  const run = async (action: () => Promise<GitActionResult>): Promise<void> => {
    setNotice(null)
    const result = await action()
    setNotice(result.message === '' ? null : result)
  }

  /** 菜单项：先本地分支（可切），再远程分支（切了会新建同名的本地跟踪分支）。 */
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
        onSelect: () => { void run(() => onSwitch(name)) },
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
          onSelect: () => { void run(() => onSwitch(name)) },
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

  /** 拉取按钮的悬停提示：说清拉谁，以及不做什么（不生成合并提交）。 */
  const pullTitle = [
    current === '' ? '拉取当前分支最新' : `拉取 ${current} 最新`,
    'git pull --ff-only：只快进，不生成合并提交',
    '分叉时 git 会拒绝并把原话显示在右边；要 merge/rebase 请去终端',
  ].join('\n')

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
            // 向上弹：面包屑在窗口底部（输入框正上方），往下弹会出画面。
            side="top"
            disabled={busy}
            width={280}
            entries={entries}
            onOpen={onRefresh}
          />
          {/* 拉取与切分支分成两个控件：一个是「换地方」，一个是「就地更新」，
              混进菜单里会让人以为它也是一次切换。 */}
          <button
            type="button"
            className="crumbs__pull"
            title={pullTitle}
            aria-label="拉取当前分支最新"
            disabled={busy}
            onClick={() => { void run(onPull) }}
          >
            {busy ? <IconSpinner size={12} className="spin" /> : <IconPull size={12} />}
          </button>
        </>
      )}

      {notice !== null && (
        <span
          className={notice.ok ? 'crumbs__note' : 'crumbs__error'}
          role="status"
          title={notice.message}
        >
          {notice.message}
        </span>
      )}
    </nav>
  )
}
