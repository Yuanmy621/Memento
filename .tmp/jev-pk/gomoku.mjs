#!/usr/bin/env node
/**
 * 五子棋 3D · 共享 CDP 客户端（供参战双方 Agent 使用）
 *
 * 用法：
 *   node .tmp/jev-pk/gomoku.mjs state              # 读取棋局（JSON + 棋盘图）
 *   node .tmp/jev-pk/gomoku.mjs play H8            # 在 H8 落子（当前行棋方）
 *   node .tmp/jev-pk/gomoku.mjs play H8 black      # 带执子校验：不是黑方回合则拒绝
 *   node .tmp/jev-pk/gomoku.mjs play 7 7           # 也可用 x y（列, 行；x/y 均 0..14，y=0 在最上）
 *   node .tmp/jev-pk/gomoku.mjs reset pvp          # 重开一局并切到双人对战
 *   node .tmp/jev-pk/gomoku.mjs eval "<expr>"      # 在页面里执行任意表达式
 *   node .tmp/jev-pk/gomoku.mjs shot out.png       # 截图当前标签页
 *
 * 环境变量：
 *   CDP=http://127.0.0.1:9222      调试端口
 *   MATCH=localhost:5173           目标标签页 URL 关键字
 */
const CDP = process.env.CDP || 'http://127.0.0.1:9222'
const MATCH = process.env.MATCH || 'localhost:5173'

async function pageTarget() {
  const list = await (await fetch(CDP + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes(MATCH))
  if (!page) {
    throw new Error(`没有找到 URL 含 "${MATCH}" 的标签页。当前: ${JSON.stringify(list.map((t) => [t.type, t.url]))}`)
  }
  return page
}

async function connect() {
  const page = await pageTarget()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    const r = waiting.get(m.id)
    if (r) { waiting.delete(m.id); r(m) }
  }
  const failed = new Promise((_, rej) => { ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')) })
  await Promise.race([new Promise((r) => { ws.onopen = r }), failed])
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id
      waiting.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
      setTimeout(() => { if (waiting.delete(i)) rej(new Error(method + ' 超时')) }, 30000)
    })
  const ev = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true })
    if (r.result?.exceptionDetails) {
      throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 600))
    }
    return r.result?.result?.value
  }
  return { ws, send, ev, page }
}

const COLS = 'ABCDEFGHIJKLMNO'
/** 'H8' 或 '7,7' / 两个数字 → {x,y}；y=0 在最上 */
export function parsePoint(args) {
  const raw = args.join(' ').trim().toUpperCase().replace(/[,\s]+/g, ' ').trim()
  const m = raw.match(/^([A-O])\s*(1[0-5]|[1-9])$/)
  if (m) {
    const x = COLS.indexOf(m[1])
    const row = Number(m[2])
    return { x, y: 15 - row, name: `${COLS[x]}${row}` }
  }
  const nums = raw.split(' ').map(Number)
  if (nums.length === 2 && nums.every((n) => Number.isInteger(n) && n >= 0 && n < 15)) {
    return { x: nums[0], y: nums[1], name: `${COLS[nums[0]]}${15 - nums[1]}` }
  }
  throw new Error(`无法解析坐标 "${args.join(' ')}"（示例：H8 / 7 7）`)
}

/** 在 15x15 棋盘上渲染棋谱，便于人类与模型直接阅读 */
export function renderBoard(moves) {
  const g = Array.from({ length: 15 }, () => Array(15).fill('.'))
  // moves 形如 "1.●H8"
  for (const mv of moves) {
    const m = String(mv).match(/^(\d+)\.(●|○)([A-O])(1[0-5]|[1-9])$/)
    if (!m) continue
    const x = COLS.indexOf(m[3])
    const y = 15 - Number(m[4])
    g[y][x] = m[2] === '●' ? 'X' : 'O'
  }
  const header = '   ' + [...COLS].map((c) => c.padStart(2)).join('')
  const rows = g.map((row, y) => String(15 - y).padStart(2) + ' ' + row.map((c) => c.padStart(2)).join(''))
  return [header, ...rows].join('\n')
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const c = await connect()
  try {
    if (cmd === 'state' || cmd === undefined) {
      const st = await c.ev('JSON.stringify(window.__gomoku ? window.__gomoku.state() : null)')
      if (!st) throw new Error('页面里没有 window.__gomoku —— 可能不是五子棋页面，或还没加载完')
      const state = JSON.parse(st)
      const stones = await c.ev('window.__gomoku.stoneCount()')
      const out = { ...state, stones, side: state.turn === 1 ? 'BLACK(●)' : 'WHITE(○)', turnColor: state.turn === 1 ? '黑' : '白' }
      console.log(JSON.stringify(out, null, 2))
      console.log('\n' + renderBoard(state.moves))
      if (state.over) console.log(`\n对局结束：${state.winner === 1 ? '黑胜' : state.winner === 2 ? '白胜' : '和棋'}`)
    } else if (cmd === 'play') {
      const want = rest.find((a) => /^(black|white|b|w|黑|白)$/i.test(a))
      const coords = rest.filter((a) => a !== want)
      const expect = want ? (/^(black|b|黑)$/i.test(want) ? 1 : 2) : null
      const p = parsePoint(coords)
      const before = JSON.parse(await c.ev('JSON.stringify(window.__gomoku.state())'))
      if (before.over) throw new Error(`对局已结束（${before.winner === 1 ? '黑胜' : before.winner === 2 ? '白胜' : '和棋'}），请先 reset`)
      if (expect && before.turn !== expect) {
        throw new Error(`现在是${before.turn === 1 ? '黑' : '白'}方回合，拒绝${expect === 1 ? '黑' : '白'}方落子`)
      }
      const res = JSON.parse(await c.ev(`JSON.stringify(window.__gomoku.play(${p.x}, ${p.y}) ? {ok:true} : {ok:false})`))
      if (!res.ok) throw new Error(`落子被拒（可能该点已有子）: ${p.name}`)
      const after = JSON.parse(await c.ev('JSON.stringify(window.__gomoku.state())'))
      console.log(JSON.stringify({ placed: p.name, x: p.x, y: p.y, by: before.turn === 1 ? 'BLACK' : 'WHITE', turn: after.turn, over: after.over, winner: after.winner, moves: after.moves }, null, 2))
      console.log('\n' + renderBoard(after.moves))
    } else if (cmd === 'reset') {
      const mode = rest[0] === 'ai' ? 'ai' : 'pvp'
      await c.ev(`window.__gomoku.newGame({ mode: ${JSON.stringify(mode)}, renju: false })`)
      await new Promise((r) => setTimeout(r, 300))
      const st = JSON.parse(await c.ev('JSON.stringify(window.__gomoku.state())'))
      console.log(JSON.stringify({ reset: true, mode: st.mode, turn: st.turn, over: st.over }, null, 2))
    } else if (cmd === 'eval') {
      const r = await c.ev(rest.join(' '))
      console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2))
    } else if (cmd === 'shot') {
      const file = rest[0] || 'shot.png'
      const r = await c.send('Page.captureScreenshot', { format: 'png' })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(file, Buffer.from(r.result.data, 'base64'))
      console.log('saved ' + file)
    } else {
      console.error('未知命令: ' + cmd)
      console.error('可用: state | play <H8|x y> | reset [pvp|ai] | eval <expr> | shot <file>')
      process.exit(2)
    }
  } finally {
    c.ws.close()
  }
}

main().catch((e) => { console.error('错误: ' + e.message); process.exit(1) })
