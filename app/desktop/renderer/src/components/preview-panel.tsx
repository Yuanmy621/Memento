/**
 * 右侧预览面板：不离开界面就能看 agent 刚生成的东西（报告 / 代码 / 文本 / 截图）。
 *
 * 渲染按类型分流：markdown 与 code 交给 `markdown.tsx` 那一层（code 由 `@streamdown/code`
 * 做 Shiki 高亮），image 走 data URL 的 `<img>`（CSP 限制只能经 IPC 传回），text 用等宽
 * `<pre>`。扩展名判断、体积上限与路径解析都在主进程（`IPC.previewRead`），这里只按 `kind` 画。
 *
 * @module Memento/desktop/renderer/components/preview-panel
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { PreviewPayload } from '../../../ipc.ts'
import type { RecentFile } from '../use-agent.ts'
import { Markdown } from '../markdown.tsx'
import CodeBlock from '../ui/beautifului/primitives/CodeBlock.tsx'
import { Button } from '../ui/beautifului/atoms/Button.tsx'
import {
  IconBack, IconClose, IconCodeFile, IconCopy, IconExternal, IconFile, IconFileQuestion,
  IconFolderOpen, IconImageFile, IconSpinner,
} from '../icons.tsx'

/** 从路径里取文件名（兼容 `/` 与 `\`）。 */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

/** 从路径里取所在目录。 */
function dirname(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at <= 0 ? '' : path.slice(0, at)
}

/** 字节数说成人话。 */
function humanSize(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 把代码包成一段围栏代码块交给 Markdown 渲染层高亮。
 * 围栏要长于正文里最长的一串反引号，否则 ``` 会被提前闭合，后面的代码变成普通段落。
 */
function fenced(text: string, language: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${language}\n${text}\n${ticks}`
}

/** 按类型选一个图标（面板头部与最近文件列表共用）。 */
function iconOf(kind: PreviewPayload['kind']): ReactElement {
  if (kind === 'image') return <IconImageFile size={14} />
  if (kind === 'code') return <IconCodeFile size={14} />
  if (kind === 'binary') return <IconFileQuestion size={14} />
  return <IconFile size={14} />
}

/** 类型的中文名（头部角标）。 */
const KIND_LABEL: Record<PreviewPayload['kind'], string> = {
  markdown: '报告',
  code: '代码',
  text: '文本',
  image: '图片',
  binary: '二进制',
}

export interface PreviewPanelProps {
  /** 要预览的文件；`null` 表示还没选，显示「最近文件」。 */
  readonly path: string | null
  /** 会话里碰过的文件（倒序，最近的在前）。 */
  readonly recent: readonly RecentFile[]
  /** 选中某个文件（列表点击 / 对话里的文件卡片）；传 `null` 回到文件列表。 */
  readonly onSelect: (path: string | null) => void
  /** 用系统默认程序打开（主进程 `shell.openPath`）。 */
  readonly onOpenPath: (path: string) => void
  /** 收起面板。 */
  readonly onClose: () => void
  /** 读文件（`window.Memento.previewRead`）。 */
  readonly read: (path: string) => Promise<PreviewPayload>
}

export const PreviewPanel = memo(function PreviewPanel({
  path, recent, onSelect, onOpenPath, onClose, read,
}: PreviewPanelProps): ReactElement {
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * 读取代际：快速连点两个文件时，先发的那次可能后回来。
   * 每次请求记一个号，回来时对不上号就丢掉。
   */
  const generation = useRef(0)

  useEffect(() => {
    if (path === null) {
      setPayload(null)
      setLoading(false)
      return
    }
    const mine = generation.current + 1
    generation.current = mine
    setLoading(true)
    read(path)
      .then((result) => {
        if (generation.current !== mine) return
        setPayload(result)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return
        setPayload({ ok: false, path, kind: 'binary', error: String((error as Error | undefined)?.message ?? error) })
        setLoading(false)
      })
  }, [path, read])

  /** 面板头部「打开」：走系统程序（预览只负责看，改还是要外部编辑器）。 */
  const openExternally = useCallback((): void => {
    if (path !== null) onOpenPath(path)
  }, [onOpenPath, path])

  const name = path === null ? '预览' : basename(path)
  const dir = path === null ? '' : dirname(path)

  return (
    <aside className="preview" aria-label="预览面板">
      <header className="preview__head">
        {/* 开着文件时给一个「返回列表」：否则只能收起再展开面板才能换文件。 */}
        {path !== null ? (
          <Button variant="quiet" size="xs" className="preview__btn" title="返回文件列表" onClick={() => { onSelect(null) }}>
            <IconBack size={14} />
          </Button>
        ) : (
          <span className="preview__icon"><IconFile size={14} /></span>
        )}
        {path !== null && <span className="preview__icon">{payload === null ? <IconFile size={14} /> : iconOf(payload.kind)}</span>}
        <span className="preview__title" title={path ?? ''}>{name}</span>
        {payload !== null && payload.ok && (
          <span className="preview__badge">{KIND_LABEL[payload.kind]}</span>
        )}
        <span className="preview__spacer" />
        {path !== null && payload !== null && payload.ok && payload.text !== undefined && (
          <Button
            variant="quiet"
            size="xs"
            className="preview__btn"
            title="复制全文"
            onClick={() => { void navigator.clipboard.writeText(payload.text ?? '') }}
          >
            <IconCopy size={13} />
          </Button>
        )}
        {path !== null && (
          <Button variant="quiet" size="xs" className="preview__btn" title={`用系统默认程序打开 ${path}`} onClick={openExternally}>
            <IconExternal size={13} />
          </Button>
        )}
        <Button variant="quiet" size="xs" className="preview__btn" title="收起预览面板" onClick={onClose}>
          <IconClose size={13} />
        </Button>
      </header>
      {dir !== '' && <div className="preview__path mono" title={path ?? ''}>{dir}</div>}

      <div className="preview__body">
        {/* 没选文件：列「这次会话碰过的文件」 */}
        {path === null && (
          recent.length === 0
            ? (
              <div className="preview__empty">
                <IconFolderOpen size={20} />
                <p>还没有可预览的文件。</p>
                <p className="preview__hint">agent 读过或写过的文件会出现在这里，点一下就能看内容。</p>
              </div>
            )
            : (
              <ul className="preview__list">
                {recent.map((file) => (
                  <li key={file.id}>
                    <button type="button" className="preview__item" title={file.path} onClick={() => { onSelect(file.path) }}>
                      <span className="preview__item-icon">{iconOf(kindOfPath(file.path))}</span>
                      <span className="preview__item-text">
                        <span className="preview__item-name">{basename(file.path)}</span>
                        <span className="preview__item-dir">{dirname(file.path)}</span>
                      </span>
                      <span className="preview__item-action">{file.action}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
        )}

        {/* 正在读 */}
        {path !== null && loading && (
          <div className="preview__loading"><IconSpinner size={14} className="spin" /> 正在读取…</div>
        )}

        {/* 读失败或太大：给出口，不硬渲染 */}
        {path !== null && !loading && payload !== null && !payload.ok && (
          <div className="preview__empty">
            <IconFileQuestion size={20} />
            <p>{payload.error ?? '读不到这个文件'}</p>
            {payload.bytes !== undefined && <p className="preview__hint">体积 {humanSize(payload.bytes)}，超出内嵌预览上限。</p>}
            <button type="button" className="btn btn--ghost" onClick={openExternally}>
              <IconExternal size={13} />
              用系统程序打开
            </button>
          </div>
        )}

        {/* 正常渲染 */}
        {path !== null && !loading && payload !== null && payload.ok && (
          <div className={`preview__content preview__content--${payload.kind}`}>
            {payload.kind === 'markdown' && <Markdown>{payload.text ?? ''}</Markdown>}
            {payload.kind === 'code' && <Markdown>{fenced(payload.text ?? '', payload.language ?? '')}</Markdown>}
            {/* 纯文本 / 日志：用带行号、文件名头与一键复制的 `CodeBlock` */}
            {payload.kind === 'text' && (
              <CodeBlock
                variant="Code"
                lines={(payload.text ?? '').split('\n')}
                code={payload.text ?? ''}
                filename={name}
                labels={{ copy: '复制全文', copied: '已复制' }}
              />
            )}
            {payload.kind === 'image' && <img className="preview__img" src={payload.dataUrl ?? ''} alt={name} />}
            {payload.kind === 'binary' && (
              <div className="preview__empty">
                <IconFileQuestion size={20} />
                <p>这个类型没法内嵌预览。</p>
                <button type="button" className="btn btn--ghost" onClick={openExternally}>
                  <IconExternal size={13} />
                  用系统程序打开
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {path !== null && payload !== null && payload.ok && (
        <footer className="preview__foot mono">
          <span>{KIND_LABEL[payload.kind]}</span>
          {payload.language !== undefined && payload.language !== '' && <span>{payload.language}</span>}
          {payload.bytes !== undefined && <span>{humanSize(payload.bytes)}</span>}
        </footer>
      )}
    </aside>
  )
})

/**
 * 「最近文件」列表里按扩展名猜个图标：判断错了只是图标不好看。
 * 真正的类型判断在主进程（`previewTypeOf`），界面不重复实现一套规则。
 */
function kindOfPath(path: string): PreviewPayload['kind'] {
  const dot = path.lastIndexOf('.')
  const ext = dot <= 0 ? '' : path.slice(dot + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico', 'svg'].includes(ext)) return 'image'
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown'
  if (['txt', 'log', 'jsonl', 'ndjson', 'csv', 'tsv', 'diff', 'patch'].includes(ext)) return 'text'
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return 'text'
  return 'code'
}
