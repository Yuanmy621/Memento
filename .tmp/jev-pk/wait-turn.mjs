#!/usr/bin/env node
/**
 * 轮询棋局，直到「轮到白棋」或「对局结束」才退出。
 * 用法：node wait-turn.mjs [最长等待秒数，默认 2700]
 * 退出码：0 = 轮到白棋 / 对局结束；1 = 超时或出错
 */
const CDP = process.env.CDP || 'http://127.0.0.1:9222'
const MATCH = process.env.MATCH || 'localhost:5173'
const MAX = Number(process.argv[2] || 2700)
const t0 = Date.now()

const COLS = 'ABCDEFGHIJKLMNO'
function render(moves) {
  const g = Array.from({ length: 15 }, () => Array(15).fill('.'))
  for (const mv of moves) {
    const m = String(mv).match(/^(\d+)\.(●|○)([A-O])(1[0-5]|[1-9])$/)
    if (m) g[15 - Number(m[4])][COLS.indexOf(m[3])] = m[2] === '●' ? 'X' : 'O'
  }
  const head = '   ' + [...COLS].map((c) => c.padStart(2)).join('')
  return [head, ...g.map((r, y) => String(15 - y).padStart(2) + ' ' + r.map((c) => c.padStart(2)).join(''))].join('\n')
}

async function readState() {
  const list = await (await fetch(CDP + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes(MATCH))
  if (!page) throw new Error('找不到五子棋标签页')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m) } }
  await new Promise((r) => { ws.onopen = r })
  const i = ++id
  const p = new Promise((r) => waiting.set(i, r))
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(window.__gomoku.state())', returnByValue: true } }))
  const res = await p
  ws.close()
  const raw = res.result?.result?.value
  if (!raw) throw new Error('页面未返回棋局状态')
  return JSON.parse(raw)
}

let lastMoves = -1
while ((Date.now() - t0) / 1000 < MAX) {
  try {
    const st = await readState()
    if (st.moves.length !== lastMoves) {
      lastMoves = st.moves.length
      console.log(`[${new Date().toLocaleTimeString()}] ${st.moves.length} 手：${st.moves.join(' ') || '(空)'}`)
    }
    if (st.over) {
      console.log(`\n对局结束：${st.winner === 1 ? '黑胜' : st.winner === 2 ? '白胜' : '和棋'}`)
      console.log(render(st.moves))
      process.exit(0)
    }
    if (st.turn === 2) {
      console.log(`\n轮到白棋（第 ${st.moves.length + 1} 手）`)
      console.log(JSON.stringify(st, null, 2))
      console.log(render(st.moves))
      process.exit(0)
    }
  } catch (e) {
    console.log('轮询出错：' + e.message)
  }
  await new Promise((r) => setTimeout(r, 2000))
}
console.log('等待超时')
process.exit(1)
