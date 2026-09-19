/**
 * 文件卡片：工具调用碰到文件时，渲染成「图标 + 文件名 + 路径 + 打开」。
 *
 * 比一行纯文本好在两点：文件一眼能认出来（图标 + 基名），并且能**真的打开它** ——
 * 「打开」走主进程的 `shell.openPath`（见 `main.js`），用系统默认程序打开；
 * 相对路径按 agent 的工作目录解析。
 *
 * @module YuanMy/desktop/renderer/components/file-card
 */

import { memo, type ReactElement } from 'react'
import { IconExternal, IconFile } from '../icons.tsx'

/** 从路径里取文件名（兼容 `/` 与 `\`）。 */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

/** 从路径里取所在目录，作为副标题。 */
function dirname(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at <= 0 ? '' : path.slice(0, at)
}

export interface FileCardProps {
  /** 文件路径（可能是相对的，交给主进程按工作目录解析）。 */
  readonly path: string
  /** 操作名（读取 / 写入 / 修改）。 */
  readonly action: string
  /** 打开文件。 */
  readonly onOpen: (path: string) => void
}

export const FileCard = memo(function FileCard({ path, action, onOpen }: FileCardProps): ReactElement {
  const dir = dirname(path)
  return (
    <div className="filecard" title={`${action} ${path}`}>
      <span className="filecard__icon"><IconFile size={16} /></span>
      <span className="filecard__text">
        <span className="filecard__name">{basename(path)}</span>
        <span className="filecard__path">{action}{dir === '' ? '' : ` · ${dir}`}</span>
      </span>
      <button
        type="button"
        className="filecard__open no-drag"
        title={`用系统默认程序打开 ${path}`}
        onClick={() => { onOpen(path) }}
      >
        <IconExternal size={13} />
        打开
      </button>
    </div>
  )
})
