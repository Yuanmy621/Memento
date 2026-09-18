#!/usr/bin/env node
/**
 * 界面侧冒烟测试（**不需要窗口**，纯 Node 跑）。
 *
 * 旧版本用「假 DOM + 回放事件」验证渲染进程，改成 React 之后那条路不再成立。
 * 现在拆成三层，都比假 DOM 更接近真相：
 *
 *   1. **静态契约**：源码里用到的 DOM 挂载点 / data-testid / IPC 频道 / api 方法
 *      必须真实存在；preload 必须保持 CommonJS（见下）；
 *   2. **归约器回放**：`renderer/src/use-agent.ts` 是纯函数，直接 import 进 Node，
 *      按真实顺序灌入 ready → text → tool-call → tool-result → turn-end，
 *      断言产出的消息结构（顺序、工具卡片回填、结论、忙碌标记）；
 *   3. **Markdown 真渲染**：用 `react-dom/server` 把 Streamdown 渲染成 HTML，
 *      断言 Markdown 真的被解析（标题/粗体/表格/代码块），而不是当纯文本贴出来。
 *
 * 真实窗口 + preload + IPC 的那一段由 `npm run desktop:smoke` 覆盖。
 *
 * 用法: node app/desktop/scripts/ui-smoke.js
 * 退出码：0 全部通过；1 有断言失败。
 *
 * @module YuanMy/desktop/scripts/ui-smoke
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url))

const html = readFileSync(here('../renderer/index.html'), 'utf8')
const preloadSource = readFileSync(here('../preload.js'), 'utf8')
const protocolSource = readFileSync(here('../host/protocol.ts'), 'utf8')
const ipcSource = readFileSync(here('../ipc.js'), 'utf8')

/** 渲染进程的全部源码（含组件）。 */
const srcDir = here('../renderer/src')
const srcFiles = []
const collect = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`
    if (statSync(full).isDirectory()) collect(full)
    else srcFiles.push(full)
  }
}
collect(srcDir)
const srcText = srcFiles.map((file) => readFileSync(file, 'utf8')).join('\n')

let failures = 0

/** 断言。 */
function check(label, condition, detail) {
  if (condition) {
    process.stdout.write(`  ✓ ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 静态契约
// ─────────────────────────────────────────────────────────────────────────────

process.stdout.write('\n静态契约\n')

check('index.html 有 #root 挂载点', html.includes('id="root"'))
check('index.html 加载构建产物', html.includes('dist/renderer.js') && html.includes('dist/renderer.css'))
check('index.html 设置了 CSP', html.includes('Content-Security-Policy'))

/** 构建产物存在且比源码新（避免「改了源码忘了构建」）。 */
const bundle = here('../renderer/dist/renderer.js')
const bundleExists = existsSync(bundle)
check('渲染进程已构建（dist/renderer.js）', bundleExists, '先跑 npm run build:renderer')
if (bundleExists) {
  const newestSrc = Math.max(...srcFiles.map((file) => statSync(file).mtimeMs))
  check('构建产物不比源码旧', statSync(bundle).mtimeMs >= newestSrc, '源码改过但没重新构建')
}

/** 冒烟脚本依赖的 data-testid 必须在源码里真实出现。 */
const REQUIRED_TESTIDS = [
  'status-text', 'messages', 'assistant-message',
  'user-message', 'message-meta', 'tool-card', 'markdown', 'input', 'send', 'cancel',
  'composer-state', 'model-input', 'model-apply', 'new-session', 'pick-directory',
  // 项目树 / 会话 / token
  'current-project', 'project-name', 'project-tree', 'project-item', 'switch-project',
  'session-list', 'session-item', 'refresh-sessions',
  'token-bar', 'token-input', 'token-output', 'token-cache', 'token-rate', 'token-calls',
]
/**
 * testid 允许两种写法：字面量 `data-testid="x"`，或三元/表达式
 * `data-testid={cond ? 'x' : 'y'}`（项目行就是这么区分当前/非当前的）。
 * 只认字面量会把后一种误判为「缺失」——这里把两种都算上。
 */
const hasTestId = (id) => new RegExp(`data-testid="${id}"`).test(srcText)
  || new RegExp(`data-testid=\\{[^}]*'${id}'[^}]*\\}`).test(srcText)
const missingIds = REQUIRED_TESTIDS.filter((id) => !hasTestId(id))
check(`冒烟脚本需要的 ${String(REQUIRED_TESTIDS.length)} 个 data-testid 都在源码里`, missingIds.length === 0, missingIds.join(', '))

/**
 * preload 必须是 CommonJS。
 *
 * 根 package.json 是 `"type": "module"`，所以 preload.js 按 Node 规则「看起来」是 ESM，
 * 只有 Electron 会把它当 CommonJS 跑（preload 忽略 `type: module`）。
 * 一旦有人顺手把 `require` 改成 `import`，界面会静默失去整个 window.YuanMy —— 很难查。
 */
const preloadIsEsm = /^\s*(import|export)\s/m.test(preloadSource)
check('preload 保持 CommonJS（无 import/export 且显式 require electron）',
  !preloadIsEsm && preloadSource.includes("require('electron')"),
  preloadIsEsm ? '发现 import/export：沙箱化 preload 不支持 ESM' : "缺少 require('electron')")

/** IPC 频道名：ipc.js 与 preload.js 必须逐字一致。 */
const ipcChannels = new Set([...ipcSource.matchAll(/'(YuanMy:[a-z-]+)'/g)].map((match) => match[1]))
const preloadChannels = new Set([...preloadSource.matchAll(/'(YuanMy:[a-z-]+)'/g)].map((match) => match[1]))
const channelDiff = [
  ...[...ipcChannels].filter((name) => !preloadChannels.has(name)).map((name) => `preload 缺 ${name}`),
  ...[...preloadChannels].filter((name) => !ipcChannels.has(name)).map((name) => `ipc.js 缺 ${name}`),
]
check(`IPC 频道名两边一致（${String(ipcChannels.size)} 个）`, channelDiff.length === 0, channelDiff.join(', '))

/** 渲染进程只能调用 preload 暴露的方法。 */
const apiBlock = preloadSource.slice(preloadSource.indexOf('const api = {'))
const exposedMethods = new Set([...apiBlock.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]))
const calledMethods = new Set([...srcText.matchAll(/\bapi\??\.(\w+)\(/g)].map((match) => match[1]))
const missingMethods = [...calledMethods].filter((name) => !exposedMethods.has(name))
check(`渲染进程调用的 ${String(calledMethods.size)} 个 api 方法都在 preload 中暴露`, missingMethods.length === 0, missingMethods.join(', '))

/**
 * 归约器处理的 host 事件类型必须在协议里定义（或属于主进程自产事件、界面本地动作）。
 *
 * `LOCAL_ACTIONS` 里的这些不是「事件」，是界面自己 dispatch 的动作 —— 它们只存在于
 * `use-agent.ts`，不经过任何通道，所以不需要协议定义。
 */
const LOCAL_ACTIONS = [
  'user-send', 'adopt-turn', 'user-error',
  'project-sessions-loading', 'project-sessions-error',
]
const shellEventTypes = new Set([...ipcSource.matchAll(/SHELL_EVENT_TYPES[\s\S]*?\[([^\]]*)\]/g)]
  .flatMap((match) => [...match[1].matchAll(/'([a-z-]+)'/g)].map((inner) => inner[1])))
const handledInReducer = [...readFileSync(here('../renderer/src/use-agent.ts'), 'utf8').matchAll(/case '([a-z-]+)':/g)]
  .map((match) => match[1])
  .filter((type) => type.includes('-'))
const missingTypes = handledInReducer.filter((type) => !protocolSource.includes(`'${type}'`) && !shellEventTypes.has(type) && !LOCAL_ACTIONS.includes(type))
check(`归约器处理的 ${String(handledInReducer.length)} 种事件都有定义`, missingTypes.length === 0, missingTypes.join(', '))

// ─────────────────────────────────────────────────────────────────────────────
// 1.5 技能：`.agents/skills` 的 frontmatter 契约
// ─────────────────────────────────────────────────────────────────────────────

process.stdout.write('\n技能（.agents/skills）\n')

const { isSkillName } = await import('@deepseek-ai/dsh-skill')

const skillsRoot = here('../../../.agents/skills')

/**
 * 取 YAML frontmatter 里的某个键（支持 `key: 值` 后面的续行折叠）。
 * 只做够用的一层解析：这些技能文件是我们自己写的，不引入 YAML 依赖。
 */
function frontmatterValue(block, key) {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block)
  if (match === null) return undefined
  let value = match[1]
  for (const line of block.slice(match.index + match[0].length).split('\n')) {
    if (/^[A-Za-z_-]+:/.test(line)) break
    if (line.trim() === '') continue
    value += ` ${line.trim()}`
  }
  return value.trim().replace(/^["']|["']$/g, '')
}

/** 解析一个 SKILL.md；返回 undefined 表示没有合法 frontmatter。 */
function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (match === null) return undefined
  return {
    name: frontmatterValue(match[1], 'name'),
    description: frontmatterValue(match[1], 'description'),
  }
}

/** 收集技能：目录包 `<name>/SKILL.md` 与单文件 `<name>.md`。 */
const skillEntries = existsSync(skillsRoot)
  ? readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => (entry.isDirectory()
      ? { id: entry.name, file: `${skillsRoot}/${entry.name}/SKILL.md`, kind: '目录包' }
      : { id: entry.name.replace(/\.md$/, ''), file: `${skillsRoot}/${entry.name}`, kind: '单文件' }))
  : []

check(`发现技能目录（${String(skillEntries.length)} 个）`, existsSync(skillsRoot) && skillEntries.length > 0)

for (const entry of skillEntries) {
  if (!existsSync(entry.file)) {
    // 目录里没有 SKILL.md 会被 provider **静默忽略** —— 这正是要拦的情况。
    check(`${entry.id}：目录里有 SKILL.md`, false, `${entry.file} 不存在`)
    continue
  }
  const parsed = parseSkill(readFileSync(entry.file, 'utf8'))
  if (parsed === undefined) {
    check(`${entry.id}：有 YAML frontmatter`, false, '文件未以 --- 开头的 frontmatter 起头')
    continue
  }
  check(`${entry.id}：name 合法且与目录名一致`,
    parsed.name === entry.id && isSkillName(entry.id),
    `name=${String(parsed.name)} 目录=${entry.id}（name 必须等于目录名，且是合法技能名）`)
  check(`${entry.id}：description 非空`,
    typeof parsed.description === 'string' && parsed.description.trim().length >= 10,
    '缺少 description 或过短（它决定模型会不会选这个技能）')
}

/** `.claude/skills` 应当是指向 `.agents/skills` 的符号链接（与 DSH 一致）。 */
const claudeLink = here('../../../.claude/skills')
check('.claude/skills 指向 .agents/skills',
  existsSync(claudeLink) && existsSync(skillsRoot)
  && readdirSync(claudeLink).sort().join() === readdirSync(skillsRoot).sort().join(),
  '符号链接缺失或指向了别处')

// ─────────────────────────────────────────────────────────────────────────────
// 1.8 项目 / 会话树的数据源（用临时 fixture 目录，不碰真实会话）
// ─────────────────────────────────────────────────────────────────────────────

process.stdout.write('\n项目 / 会话树（host 侧读盘）\n')

const { mkdtempSync, mkdirSync, rmSync: rmDir, writeFileSync: writeFile } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { listWorkspaceSessions, listProjectSessions } = await import('../host/sessions.ts')

/** 造一份最小可用的会话日志（第一行是头，之后是事件）。 */
function writeLog(root, projectSlug, sessionId, cwd, title, turns) {
  const dir = `${root}/${projectSlug}/${sessionId}`
  mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 3, id: sessionId, createdAt: 1000, cwd })]
  if (title !== '') {
    lines.push(JSON.stringify({ type: 'user/message', seq: 0, time: 2000, data: {
      content: [{ type: 'text', text: title }], source: { kind: 'user' }, role: 'user', id: 'm1',
    } }))
  }
  for (let index = 0; index < turns; index += 1) {
    lines.push(JSON.stringify({ type: 'turn/end', seq: index + 1, time: 3000 + index, data: { turn: index + 1, reason: { kind: 'completed' } } }))
  }
  writeFile(`${dir}/session.v3.jsonl`, `${lines.join('\n')}\n`)
}

const fixture = mkdtempSync(`${tmpdir()}/yuanmy-tree-`)
writeLog(fixture, '--proj-a--', 'sess-a1', '/tmp/proj-a', 'A 的第一个会话', 2)
writeLog(fixture, '--proj-a--', 'sess-a2', '/tmp/proj-a', 'A 的第二个会话', 0)
writeLog(fixture, '--proj-b--', 'sess-b1', '/tmp/proj-b', 'B 的唯一会话', 1)

const workspace = await listWorkspaceSessions({ root: fixture, cwd: '/tmp/proj-a', currentSessionId: 'sess-a1' })
check('项目清单含两个项目，当前项目排第一',
  workspace.projects.length === 2
  && workspace.projects[0].path === '/tmp/proj-a' && workspace.projects[0].current === true
  && workspace.projects[1].path === '/tmp/proj-b' && workspace.projects[1].current === false,
  JSON.stringify(workspace.projects.map((p) => p.path)))
check('首屏只带当前项目的会话（另一个项目留给懒加载）',
  workspace.sessions.length === 2 && workspace.sessions.every((s) => s.id.startsWith('sess-a')),
  JSON.stringify(workspace.sessions.map((s) => s.id)))
check('会话标题取第一条用户消息、轮数取自 turn/end',
  workspace.sessions.find((s) => s.id === 'sess-a1')?.title === 'A 的第一个会话'
  && workspace.sessions.find((s) => s.id === 'sess-a1')?.turns === 2)
check('当前会话被标记', workspace.sessions.find((s) => s.id === 'sess-a1')?.current === true)

const projectB = await listProjectSessions({ root: fixture, path: '/tmp/proj-b', currentSessionId: 'sess-a1' })
check('按需读另一个项目的会话明细',
  projectB !== undefined && projectB.project.path === '/tmp/proj-b'
  && projectB.sessions.length === 1 && projectB.sessions[0].id === 'sess-b1')
check('别的项目里没有「当前会话」标记', projectB?.sessions[0].current === false)
check('读不存在的项目返回 undefined',
  await listProjectSessions({ root: fixture, path: '/tmp/nope', currentSessionId: 'x' }) === undefined)

/** 当前会话还没落盘时，要补一条合成记录，否则树里标不出「当前」。 */
const synthetic = await listWorkspaceSessions({ root: fixture, cwd: '/tmp/proj-a', currentSessionId: 'brand-new' })
check('当前会话未落盘时补一条合成记录',
  synthetic.sessions[0].id === 'brand-new' && synthetic.sessions[0].current === true && synthetic.sessions[0].title === '')

/** 全新的项目目录（还没有任何会话）也要出现在树里。 */
const empty = await listWorkspaceSessions({ root: fixture, cwd: '/tmp/fresh', currentSessionId: 's1' })
const fresh = empty.projects.find((project) => project.path === '/tmp/fresh')
check('没有会话的新项目也在清单里、排第一，且当前会话可见',
  fresh !== undefined && fresh.current === true && fresh.sessionCount === 0
  && empty.projects[0].path === '/tmp/fresh'
  && empty.sessions.length === 1 && empty.sessions[0].id === 's1' && empty.sessions[0].current === true,
  JSON.stringify({ projects: empty.projects.map((project) => project.path), sessions: empty.sessions.length }))

check('不存在的根目录不报错，返回只有当前项目',
  (await listWorkspaceSessions({ root: `${fixture}/missing`, cwd: '/tmp/x', currentSessionId: 's' })).projects.length === 1)

rmDir(fixture, { recursive: true, force: true })

// ─────────────────────────────────────────────────────────────────────────────
// 2. 归约器回放（纯函数，不需要 DOM）
// ─────────────────────────────────────────────────────────────────────────────

process.stdout.write('\n状态归约器回放\n')

const { reducer, initialState } = await import('../renderer/src/use-agent.ts')

/** 依次应用事件。 */
const play = (actions) => actions.reduce(reducer, initialState)

const INFO = {
  protocolVersion: 1,
  sessionId: 'YuanMy-20260918-test',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  cwd: '/Users/me/project',
  persist: true,
  credential: '~/.dsd/.credentials.yaml sk-abc…123',
  tools: [{ name: 'tree', description: '目录树' }, { name: 'bash', description: '跑命令' }],
  nodeVersion: 'v26.3.1',
}

const afterReady = play([{ type: 'ready', info: INFO }])
check('ready 后进入就绪态并带上内核信息', afterReady.phase === 'ready' && afterReady.info.model === 'deepseek-flash')

const afterTurn = play([
  { type: 'ready', info: INFO },
  { type: 'user-send', text: '看看目录' },
  { type: 'adopt-turn', turnId: 't1' },
  { type: 'reasoning-delta', turnId: 't1', text: '先了解结构。' },
  { type: 'text-delta', turnId: 't1', text: '我先看目录。' },
  { type: 'tool-call', turnId: 't1', callId: 'c1', name: 'tree', summary: 'app/desktop' },
  { type: 'tool-result', turnId: 't1', callId: 'c1', name: 'tree', summary: 'app/desktop (11 行) exit 0', isError: false },
  { type: 'text-delta', turnId: 't1', text: '这是一个 Electron 壳。' },
  { type: 'turn-end', turnId: 't1', outcome: 'completed', text: '', toolCalls: 1 },
])

const assistant = afterTurn.items[1]
check('用户消息与助手消息各一条', afterTurn.items.length === 2 && afterTurn.items[0].kind === 'user')
check('助手条目认领了 turnId', assistant.turnId === 't1')
check('推理增量进入 reasoning', assistant.reasoning === '先了解结构。')
check('正文被工具调用切成两块（顺序保留）',
  assistant.blocks.length === 3
  && assistant.blocks[0].type === 'text' && assistant.blocks[0].text === '我先看目录。'
  && assistant.blocks[1].type === 'tool'
  && assistant.blocks[2].type === 'text' && assistant.blocks[2].text === '这是一个 Electron 壳。')
check('工具结果按 callId 回填', assistant.blocks[1].result === 'app/desktop (11 行) exit 0' && assistant.blocks[1].pending === undefined)
check('回合结束写入结论并解除忙碌',
  assistant.meta.outcome === 'completed' && assistant.meta.toolCalls === 1 && afterTurn.busy === false)

const d1 = play([
  { type: 'ready', info: INFO },
  { type: 'user-send', text: 'x' },
  { type: 'turn-end', turnId: 't2', outcome: 'aborted', text: '', toolCalls: 0 },
])
check('中断后回到空闲', d1.busy === false && d1.items[1].meta.outcome === 'aborted')

const d2 = play([
  { type: 'ready', info: INFO },
  { type: 'tool-call', turnId: 't3', callId: 'c9', name: 'bash', summary: 'ls' },
  { type: 'tool-result', turnId: 't3', callId: 'c9', name: 'bash', summary: 'boom', isError: true },
])
check('结果带错误标记', d2.items[0].blocks[0].isError === true)

const d3 = play([{ type: 'ready', info: INFO }, { type: 'restarting', cwd: '/tmp' }])
check('restarting 清空会话', d3.items.length === 0 && d3.phase === 'booting')

const d4 = play([{ type: 'ready', info: INFO }, { type: 'host-error', message: '崩了' }])
check('host 错误进入不可用态并留下提示',
  d4.phase === 'error' && d4.error === '崩了' && d4.items.at(-1).level === 'error')

const d5 = play([{ type: 'ready', info: INFO }, { type: 'notice', message: '提示' }])
check('notice 追加系统提示', d5.items.at(-1).kind === 'note' && d5.items.at(-1).level === 'info')

// ── token 统计 ────────────────────────────────────────────────────────────

const { cacheHitRate, billedInputTokens, emptyUsage } = await import('../renderer/src/use-agent.ts')

check('空累计的命中率是 null（不伪造 0%）', cacheHitRate({ ...emptyUsage }) === null)

/** 取一份真实日志里的数字：未命中 246、命中 2816、输出 77。 */
const afterUsage = play([
  { type: 'ready', info: INFO },
  { type: 'usage', turnId: 't1', usage: { inputTokens: 246, outputTokens: 77, totalTokens: 3139, cacheReadTokens: 2816, reasoningTokens: 52 } },
  { type: 'usage', turnId: 't1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 3 } },
])
const usage = afterUsage.usage
check('usage 帧累加（而非覆盖）',
  usage.inputTokens === 256 && usage.outputTokens === 82 && usage.cacheReadTokens === 2906
  && usage.cacheWriteTokens === 3 && usage.reasoningTokens === 52)
check('调用次数按帧计数', usage.calls === 2)
check('last 保留最近一次调用的明细', usage.last.inputTokens === 10 && usage.last.cacheWriteTokens === 3)

/** DSH 的计数是互斥的：计费输入 = 未命中 + 命中 + 写入。 */
const single = play([
  { type: 'ready', info: INFO },
  { type: 'usage', turnId: 't1', usage: { inputTokens: 246, outputTokens: 77, cacheReadTokens: 2816 } },
]).usage
check('计费输入 = 未命中 + 命中 + 写入', billedInputTokens(single) === 3062)
check('命中率 = 命中 / 计费输入（92.0%）', Math.abs((cacheHitRate(single) ?? 0) - 0.9197) < 0.001,
  String(cacheHitRate(single)))
check('缓存写入也算进分母（它是未命中的一部分）',
  billedInputTokens({ ...emptyUsage, inputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 50 }) === 100
  && cacheHitRate({ ...emptyUsage, inputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 50 }) === 0.5)

check('重启内核会清零 token 累计',
  play([{ type: 'ready', info: INFO }, { type: 'usage', turnId: 't1', usage: { inputTokens: 9, outputTokens: 9 } }, { type: 'restarting', cwd: '/tmp' }]).usage.calls === 0)

// ── 项目 / 会话清单 ───────────────────────────────────────────────────────

const PROJECT = { name: 'YuanMy', path: '/Users/me/YuanMy', sessionCount: 3, updatedAt: 1, current: true }
const OTHER = { name: 'proj', path: '/Users/me/proj', sessionCount: 1, updatedAt: 2, current: false }
const SESSIONS = [
  { id: 's-new', title: '看一下目录', createdAt: 2, updatedAt: 3, turns: 2, current: true },
  { id: 's-old', title: '', createdAt: 1, updatedAt: 1, turns: 0, current: false },
]
const withWorkspace = play([{ type: 'ready', info: INFO }, { type: 'workspace', projects: [PROJECT, OTHER], sessions: SESSIONS }])
check('workspace 帧写入项目与会话', withWorkspace.projects.length === 2 && withWorkspace.sessions.length === 2)
check('当前会话带 current 标记', withWorkspace.sessions[0].current === true && withWorkspace.sessions[1].current === false)
check('标题为空表示还没有用户消息', withWorkspace.sessions[1].title === '')

// ── 折叠项目的会话明细（侧栏里点开才读）─────────────────────────────────

const detail = play([
  { type: 'ready', info: INFO },
  { type: 'project-sessions-loading', path: OTHER.path },
  { type: 'project-sessions', path: OTHER.path, sessions: SESSIONS },
])
check('展开的项目：会话挂在该项目路径下', (detail.projectSessions[OTHER.path] ?? []).length === 2)
check('明细到达后结束「读取中」', detail.loadingProject === null)

check('读取中会标记出来（界面据此显示占位）',
  play([{ type: 'ready', info: INFO }, { type: 'project-sessions-loading', path: OTHER.path }]).loadingProject === OTHER.path)

check('重启内核会丢掉已展开项目的会话缓存',
  play([
    { type: 'ready', info: INFO },
    { type: 'project-sessions', path: OTHER.path, sessions: SESSIONS },
    { type: 'restarting', cwd: '/tmp' },
  ]).projectSessions[OTHER.path] === undefined)

const failed = play([
  { type: 'ready', info: INFO },
  { type: 'project-sessions-loading', path: OTHER.path },
  { type: 'project-sessions-error', path: OTHER.path, message: '读不到' },
])
check('读取失败会结束「读取中」并留下提示',
  failed.loadingProject === null && failed.items.at(-1).level === 'warn')

// ─────────────────────────────────────────────────────────────────────────────
// 3. 输入法守卫（真值表）
// ─────────────────────────────────────────────────────────────────────────────

process.stdout.write('\n输入法组字守卫\n')

const { isImeKeyEvent, IME_PROCESS_KEYCODE } = await import('../renderer/src/composition.ts')

check('输入法哨兵值是 229', IME_PROCESS_KEYCODE === 229)

/** 一个「正常回车」：未被输入法处理，也没有刚结束组字。 */
check('普通回车 → 不拦（否则回车就发不出去了）',
  isImeKeyEvent({ isComposing: false, keyCode: 13 }, false) === false)

check('组字中的回车 → 拦下（这是用户报的那个 bug）',
  isImeKeyEvent({ isComposing: true, keyCode: 229 }, false) === true)

check('组字中的回车（浏览器没给 keyCode）→ 仍靠 isComposing 拦下',
  isImeKeyEvent({ isComposing: true }, false) === true)

check('macOS Chromium：compositionend 之后 isComposing=false 但 keyCode=229 → 拦下',
  isImeKeyEvent({ isComposing: false, keyCode: 229 }, false) === true)

check('compositionend 同一任务内的后续按键 → 靠临时标记拦下',
  isImeKeyEvent({ isComposing: false, keyCode: 13 }, true) === true)

check('临时标记清掉后回车恢复可用（防「守卫卡死」）',
  isImeKeyEvent({ isComposing: false, keyCode: 13 }, false) === false)

check('Shift+Enter 路径不受影响（shift 不在判定范围内，只由调用方处理）',
  isImeKeyEvent({ isComposing: false, keyCode: 13 }, false) === false)

// ─────────────────────────────────────────────────────────────────────────────
// 4. Markdown 真渲染（react-dom/server + Streamdown）
// ─────────────────────────────────────────────────────────────────────────────

process.stdout.write('\nMarkdown 渲染\n')

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { Streamdown } = await import('streamdown')

const markdown = [
  '# 标题一',
  '',
  '这是 **粗体** 与 `inline`。',
  '',
  '- 项目 A',
  '- 项目 B',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| a | 1 |',
].join('\n')

const rendered = renderToStaticMarkup(createElement(Streamdown, null, markdown))

check('标题被解析为 <h1>', rendered.includes('<h1'))
check('粗体被解析为 [data-streamdown="strong"]', rendered.includes('data-streamdown="strong"'))
check('行内代码被解析为 <code>', rendered.includes('<code'))
check('无序列表被解析为 <ul>', rendered.includes('<ul'))
check('表格被解析为 <table>', rendered.includes('<table'))
check('没有把 Markdown 源码原样贴出', !rendered.includes('**粗体**') && !rendered.includes('# 标题一'))

// ─────────────────────────────────────────────────────────────────────────────

process.stdout.write(`\n${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}\n\n`)
process.exit(failures === 0 ? 0 : 1)
