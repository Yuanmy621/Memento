#!/usr/bin/env node
/**
 * 桌面端真窗口冒烟的外壳：造一个**临时工作区**，在里面跑 Electron。
 *
 * 为什么要多这一层：
 *   1. **不污染真实会话**。早先冒烟直接用仓库目录当工作目录，跑一次就往
 *      `.YuanMy/sessions/` 里塞一个新会话 —— 侧栏会话列表里会慢慢堆满
 *      「只回答两个字：好的」这种测试残留。
 *   2. **能造多项目 fixture**。项目树的懒加载必须有两个项目才验得到，
 *      而真实机器上通常只有一个。
 *
 * 临时工作区结构（跑完即删）：
 *
 * ```
 * <tmp>/yuanmy-desktop-smoke-XXXX/
 *   .YuanMy/sessions/<当前项目>/<会话>/session.v3.jsonl   ← cwd 指向自己
 *   other-project/
 *     .YuanMy/sessions/<另一个项目>/<会话>/session.v3.jsonl ← cwd 指向 other-project
 * ```
 *
 * 用法: node app/desktop/scripts/smoke-desktop.js
 * 退出码与 Electron 一致（0 全绿）。
 *
 * @module YuanMy/desktop/scripts/smoke-desktop
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const electron = fileURLToPath(new URL('../../../node_modules/.bin/electron', import.meta.url))
const mainEntry = fileURLToPath(new URL('../main.js', import.meta.url))

/**
 * 造一份最小可用的会话日志。
 * @param root - 工作区根目录。
 * @param cwd - 这份日志所属项目的绝对路径（lister 从头里读它来分组）。
 * @param sessionId - 会话 id。
 * @param title - 第一条用户消息（会变成侧栏标题）。
 */
function writeSession(root, cwd, sessionId, title) {
  const slug = `--${cwd.replace(/\//g, '-')}--`
  const dir = join(root, '.YuanMy', 'sessions', slug, sessionId)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 }),
    JSON.stringify({
      type: 'user/message',
      seq: 0,
      time: Date.now(),
      data: { content: [{ type: 'text', text: title }], source: { kind: 'user' }, role: 'user', id: 'seed' },
    }),
    JSON.stringify({ type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
  writeFileSync(join(dir, 'session.v3.jsonl'), `${lines.join('\n')}\n`)
}

const workspace = mkdtempSync(join(tmpdir(), 'yuanmy-desktop-smoke-'))
const otherProject = join(workspace, 'other-project')

// 当前项目：一条历史会话（「当前」那条由 host 合成）。
writeSession(workspace, workspace, 'smoke-current-project-1', '冒烟 fixture：当前项目的历史会话')
// 另一个项目：**也必须写进同一个 sessions 根**。
// lister 只扫 `<cwd>/.YuanMy/sessions` 一个根，靠每份日志头里的 `cwd` 字段分组 ——
// 把它的会话放到别处（otherProject/.YuanMy/…）是扫不到的。
// 另外它的目录也要真存在，切换项目/恢复会话时才不会指向空气。
mkdirSync(otherProject, { recursive: true })
writeSession(workspace, otherProject, 'smoke-other-project-1', '冒烟 fixture：另一个项目的会话')
writeSession(workspace, otherProject, 'smoke-other-project-2', '冒烟 fixture：另一个项目的第二条')

const child = spawn(electron, [mainEntry], {
  stdio: 'inherit',
  env: {
    ...process.env,
    YuanMy_SMOKE: '1',
    // 关键：把工作目录指到临时工作区，测试会话不会落到真实项目里。
    YuanMy_SMOKE_CWD: workspace,
  },
})

/** 收尾：删掉临时工作区（含里面写下的会话）。 */
function cleanup() {
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    // 删不掉也不该让冒烟失败（比如文件被占用），下次启动会重新建。
  }
}

child.on('close', (code) => {
  cleanup()
  process.exit(code ?? 1)
})
process.on('SIGINT', () => { child.kill('SIGTERM') })
process.on('SIGTERM', () => { child.kill('SIGTERM') })
