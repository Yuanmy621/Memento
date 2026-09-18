#!/usr/bin/env node
/**
 * 无 GUI 的 host 冒烟测试：直接拉起 `host/index.ts` 并按协议驱动它。
 *
 * 用途有三：
 *   1. 不开 Electron 就能验证「内核装配 + 事件桥 + IPC 协议」这条链路；
 *   2. 定位问题是出在 host 还是出在界面（Electron 只是转发者）；
 *   3. 在没有图形环境（CI / SSH）时做回归。
 *
 * 用法：
 *   node app/desktop/scripts/host-smoke.js                      # 只启动内核并打印 ready
 *   node app/desktop/scripts/host-smoke.js -p "看看项目结构"     # 跑一个真实回合
 *   node app/desktop/scripts/host-smoke.js --cwd /tmp --keep     # 启动后保持不退出
 *
 * 退出码：0 成功；1 host 报错或回合失败；2 用法错误。
 *
 * @module YuanMy/desktop/scripts/host-smoke
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const hostEntry = fileURLToPath(new URL('../host/index.ts', import.meta.url))

/** 用法文本。 */
const USAGE = `host 冒烟测试
用法: node app/desktop/scripts/host-smoke.js [--cwd <dir>] [--model <id>] [-p <text>] [--keep] [--verbose]

  -p, --prompt <text>  发起一个真实回合（需要可用的 API key）
      --keep           拿到 ready 后保持运行，直到 Ctrl-C
      --resume <id>    恢复一个已落盘的会话（透传给 host）
      --verbose        打印 host 的 stdout / stderr`

/** 极简参数解析（与 CLI 的开关同名，便于对照）。 */
function parseArgs(argv) {
  const result = { options: [], prompt: undefined, keep: false, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-p' || arg === '--prompt') {
      result.prompt = argv[++i]
    } else if (arg === '--keep') {
      result.keep = true
    } else if (arg === '--verbose') {
      result.verbose = true
    } else if (arg === '--cwd' || arg === '--model' || arg === '--provider' || arg === '--effort'
      || arg === '--state-dir' || arg === '--resume' || arg === '--session') {
      // 这些开关原样透传给 host（host 自己用 CLI 的 parseOptions 解析）。
      result.options.push(arg, argv[++i])
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else {
      process.stderr.write(`未知参数 ${arg}\n${USAGE}\n`)
      process.exit(2)
    }
  }
  return result
}

const args = parseArgs(process.argv.slice(2))

// 与 Electron 主进程完全相同的启动方式：系统 node + Node 原生类型擦除。
const node = process.env.YuanMy_NODE_BIN || process.env.npm_node_execpath || 'node'
const child = spawn(node, [
  '--experimental-strip-types',
  '--disable-warning=ExperimentalWarning',
  hostEntry,
  ...args.options,
], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => { if (args.verbose) process.stdout.write(`[host stdout] ${chunk}`) })
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { process.stderr.write(`[host stderr] ${chunk}`) })

/** 收到 `--keep` 时由 Ctrl-C 结束。 */
let keepAlive = args.keep
/** 无 prompt 模式下，正在等第一帧 workspace（会话清单）。 */
let awaitingWorkspace = false
let turnId
let exitCode = 0

child.on('message', (event) => {
  switch (event?.type) {
    case 'ready': {
      const { info } = event
      process.stdout.write(`✓ host 就绪\n`)
      process.stdout.write(`  会话    ${info.sessionId}\n`)
      process.stdout.write(`  模型    ${info.provider}/${info.model}\n`)
      process.stdout.write(`  工作目录 ${info.cwd}\n`)
      process.stdout.write(`  工具    ${info.tools.length} 个: ${info.tools.map(tool => tool.name).join(', ')}\n`)
      process.stdout.write(`  凭据    ${info.credential}\n`)
      process.stdout.write(`  Node    ${info.nodeVersion}\n`)
      if (args.prompt === undefined) {
        if (keepAlive) return
        // 就绪之后 host 还会推一帧「项目 / 会话清单」，等它到了再判定，
        // 否则这个冒烟测不到会话扫描（早先就是这样漏掉的）。
        awaitingWorkspace = true
        setTimeout(() => {
          if (!awaitingWorkspace) return
          process.stderr.write('✖ 8s 内没有收到 workspace 帧（会话扫描可能坏了）\n')
          finish(1)
        }, 8000).unref()
        return
      }
      turnId = randomUUID()
      process.stdout.write(`\n▶ 提问: ${args.prompt}\n\n`)
      child.send({ type: 'prompt', turnId, text: args.prompt })
      return
    }
    case 'text-delta':
      process.stdout.write(event.text)
      return
    case 'reasoning-delta':
      // 终端里用灰色展示推理过程，与 CLI 的观感保持一致。
      process.stdout.write(`\u001B[90m${event.text}\u001B[0m`)
      return
    case 'tool-call':
      process.stdout.write(`\n⏺ ${event.name} ${event.summary}\n`)
      return
    case 'tool-result':
      process.stdout.write(`  ⎿ ${event.name} → ${event.summary}\n`)
      return
    case 'turn-end': {
      process.stdout.write(`\n\n— turn-end: ${event.outcome}`)
      process.stdout.write(event.error === undefined ? '' : ` (${event.error})`)
      process.stdout.write(` · ${String(event.toolCalls)} 次工具调用 · ${String(event.text.length)} 字符 —\n`)
      if (event.outcome !== 'completed') exitCode = 1
      if (!keepAlive) finish(exitCode)
      return
    }
    case 'workspace': {
      if (awaitingWorkspace) {
        awaitingWorkspace = false
        finish(0)
      }
      const current = event.projects.find((project) => project.current)
      process.stdout.write(`\n◫ 项目 ${String(event.projects.length)} 个 · 当前「${current?.name ?? '?'}」· 会话 ${String(event.sessions.length)} 个\n`)
      for (const session of event.sessions.slice(0, 5)) {
        process.stdout.write(`  ${session.current ? '▸' : ' '} ${session.id}  ${String(session.turns)} 轮  ${session.title || '（暂无消息）'}\n`)
      }
      return
    }
    case 'usage':
      process.stdout.write(`\n∑ usage 未命中=${String(event.usage.inputTokens)} 命中=${String(event.usage.cacheReadTokens ?? 0)} 输出=${String(event.usage.outputTokens)}\n`)
      return
    case 'notice':
      process.stdout.write(`\n[${event.level}] ${event.message}\n`)
      return
    case 'fatal':
      process.stderr.write(`✖ host 致命错误: ${event.message}\n`)
      finish(1)
      return
    default:
      return
  }
})

child.on('exit', (code) => {
  if (!keepAlive) return
  process.stdout.write(`host 已退出 (code ${String(code)})\n`)
  process.exit(code ?? 0)
})

/** 结束：先请求 host 优雅退出，再退出自己。 */
function finish(code) {
  exitCode = code
  keepAlive = false
  if (child.connected) child.send({ type: 'shutdown' })
  setTimeout(() => { child.kill('SIGTERM'); process.exit(exitCode) }, 1500).unref()
}

process.on('SIGINT', () => {
  if (child.connected) child.send({ type: 'shutdown' })
  finish(exitCode)
})
