#!/usr/bin/env node
/**
 * 候选着法生成 + 项目自带引擎的「根节点搜索」打分。
 *
 * 为什么不用 ai.js 的 findBestMove 直接排行？它只返回榜首，不返回全部候选分。
 * 这里复刻它的 negamax 语义（同样的 orderMoves 排序、同样的 evalFor、同样的
 * WIN_SCORE / 挡五 快捷判定），对根节点每个候选着法都算出**同一深度**的分数，
 * 因此候选之间可以直接比较。奇数深度会破坏它「迭代加深每次 +2」的约定，
 * 所以 depth 只用偶数。
 *
 * 环境变量：DEPTH=6 TIME=4000 WIDTH=12 RADIUS=2 TOP=12
 */
import { pathToFileURL } from 'node:url'
const PROJECT = process.env.PROJECT || '/Users/yuanmingyuan/Acmer/YuanMy/gomoku-3d'
const CDP = process.env.CDP || 'http://127.0.0.1:9222'
const MATCH = process.env.MATCH || 'localhost:5173'
const COLS = 'ABCDEFGHIJKLMNO'
const name = (x, y) => `${COLS[x]}${15 - y}`

const RL = await import(pathToFileURL(PROJECT + '/src/rules.js').href)
const AI = await import(pathToFileURL(PROJECT + '/src/ai.js').href)
const { Board, BLACK, WHITE, EMPTY, opponent, evaluatePlacement, judge, countFourDirections, countOpenThreeDirections } = RL
const { Engine, WIN_SCORE } = AI

/* ---------------- 复刻 ai.js 的搜索内核 ---------------- */
const TIMEOUT = Symbol('timeout')

function neighborhood(board, radius) {
  const n = board.size, seen = new Set()
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (board.get(x, y) === EMPTY) continue
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue
      if (board.get(nx, ny) !== EMPTY) continue
      seen.add(ny * n + nx)
    }
  }
  return [...seen].map((k) => ({ x: k % n, y: (k / n) | 0 }))
}

function orderMoves(engine, color, radius) {
  const opp = opponent(color)
  const list = []
  for (const { x, y } of neighborhood(engine.board, radius)) {
    const b0 = engine.total[BLACK], w0 = engine.total[WHITE]
    engine.place(x, y, color)
    const gain = engine.total[color] - (color === BLACK ? b0 : w0)
    const block = (color === BLACK ? w0 : b0) - engine.total[opp]
    engine.remove(x, y)
    list.push({ x, y, score: gain + block * 0.95 })
  }
  list.sort((a, b) => b.score - a.score)
  return list
}

function negamax(engine, color, depth, alpha, beta, ctx) {
  if ((ctx.nodes++ & 255) === 0 && Date.now() > ctx.deadline) throw TIMEOUT
  const opp = opponent(color)
  if (depth <= 0) return engine.evalFor(color)
  const moves = orderMoves(engine, color, ctx.radius).slice(0, ctx.width)
  if (moves.length === 0) return 0
  let best = -Infinity
  for (const move of moves) {
    const verdict = evaluatePlacement(engine.board, move.x, move.y, color, ctx.renju)
    if (!verdict || verdict.status === 'forbidden') continue
    engine.place(move.x, move.y, color)
    let score
    try {
      if (verdict.status === 'win') score = WIN_SCORE - (ctx.maxDepth - depth)
      else if (engine.stones >= engine.n * engine.n) score = 0
      else score = -negamax(engine, opp, depth - 1, -beta, -alpha, ctx)
    } finally { engine.remove(move.x, move.y) }
    if (score > best) best = score
    if (score > alpha) alpha = score
    if (alpha >= beta) break
  }
  return best === -Infinity ? engine.evalFor(color) : best
}

/** 根节点：返回每个候选在同一深度下的分数（正 = 对 color 有利） */
function rootScores(board, color, opts) {
  const { renju = false, depth = 6, timeLimit = 4000, width = 12, radius = 2, only = null } = opts
  const started = Date.now()
  const engine = new Engine(board)
  const opp = opponent(color)
  const all = orderMoves(engine, color, radius)
  let legal = all.filter((m) => {
    const v = evaluatePlacement(board, m.x, m.y, color, renju)
    return v && v.status !== 'forbidden'
  })
  if (only && only.length) legal = legal.filter((m) => only.includes(name(m.x, m.y)))
  if (legal.length === 0) return { scored: [], reached: 0, nodes: 0, ms: 0 }

  const win = legal.find((m) => evaluatePlacement(board, m.x, m.y, color, renju).status === 'win')
  if (win) return { scored: [{ ...win, value: WIN_SCORE, tag: '五连获胜' }], reached: 1, nodes: 0, ms: Date.now() - started, forced: 'win' }

  const threats = all.filter((m) => {
    const v = evaluatePlacement(board, m.x, m.y, opp, renju)
    return v && v.status === 'win'
  })
  if (threats.length === 1) {
    return { scored: [{ ...threats[0], value: 0, tag: '挡住对手成五(必挡)' }], reached: 1, nodes: 0, ms: Date.now() - started, forced: 'block' }
  }

  // 每个候选单独做一次「全窗口」搜索：根节点不剪枝，得到的分才是可比的精确值。
  // 若沿用根节点共享 alpha 的剪枝写法，第 2 个候选之后拿到的多是 fail-low 上界，
  // 数值不可比（这正是 findBestMove 只返回榜首的原因）。
  const ctx = { nodes: 0, deadline: started + timeLimit, renju, width, radius, maxDepth: depth }
  const scored = []
  const pool = legal.slice(0, Math.max(width, 8))
  try {
    for (const move of pool) {
      const verdict = evaluatePlacement(board, move.x, move.y, color, renju)
      engine.place(move.x, move.y, color)
      let value
      try {
        value = verdict?.status === 'win' ? WIN_SCORE : -negamax(engine, opp, depth - 1, -Infinity, Infinity, ctx)
      } finally { engine.remove(move.x, move.y) }
      scored.push({ ...move, value })
    }
  } catch (e) { if (e !== TIMEOUT) throw e }
  scored.sort((a, b) => b.value - a.value)

  // 注释：对手下一手有直接成五点 → 未去挡的手很危险
  const oppWins = threats.map((t) => `${t.x},${t.y}`)
  for (const s of scored) {
    if (s.value <= -WIN_SCORE / 2) s.tag = '给对手留下必胜(差)'
    else if (oppWins.includes(`${s.x},${s.y}`)) s.tag = '挡住对手成五'
  }
  return { scored, reached: depth, nodes: ctx.nodes, ms: Date.now() - started, timeouts: scored.length < pool.length }
}

/* ---------------- 战术扫描：不依赖引擎估值，只看「能形成什么」 ---------------- */
/**
 * 把 color 落在 (x,y) 后：
 *  - 我方这一手形成了 五 / 四 / 活三 吗
 *  - 对手下一手能形成 五 / 四 / 活三 的点有哪些（活三 = 再补一子即活四）
 * 返回的是可解释的棋形事实，不受搜索深度振荡影响。
 */
function tacticalScan(board, color, x, y) {
  const opp = opponent(color)
  const out = { myWin: false, myFour: 0, myOpenThree: 0, oppWins: [], oppFours: [], oppOpenThrees: [] }
  board.set(x, y, color)
  try {
    if (judge(board, x, y, color, false).status === 'win') out.myWin = true
    out.myFour = countFourDirections(board, x, y, color)
    out.myOpenThree = countOpenThreeDirections(board, x, y, color)
    for (const m of neighborhood(board, 2)) {
      board.set(m.x, m.y, opp)
      if (judge(board, m.x, m.y, opp, false).status === 'win') out.oppWins.push(name(m.x, m.y))
      else if (countFourDirections(board, m.x, m.y, opp) >= 1) out.oppFours.push(name(m.x, m.y))
      else if (countOpenThreeDirections(board, m.x, m.y, opp) >= 1) out.oppOpenThrees.push(name(m.x, m.y))
      board.set(m.x, m.y, EMPTY)
    }
  } finally { board.set(x, y, EMPTY) }
  const cap = (a) => (a.length > 6 ? [...a.slice(0, 6), `…共${a.length}`] : a)
  out.oppWins = cap(out.oppWins); out.oppFours = cap(out.oppFours); out.oppOpenThrees = cap(out.oppOpenThrees)
  return out
}

/* ---------------- 读棋局 ---------------- */
const list = await (await fetch(CDP + '/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.url.includes(MATCH))
if (!page) throw new Error('找不到五子棋标签页')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const waiting = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m) } }
await new Promise((r) => { ws.onopen = r })
const ev = async (expr) => {
  const i = ++id
  const p = new Promise((r) => waiting.set(i, r))
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  const r = await p
  return r.result?.result?.value
}

const snap = JSON.parse(await ev('JSON.stringify(window.__gomoku.state())'))
const board = new Board()
for (const mv of snap.moves) {
  const m = String(mv).match(/^(\d+)\.(●|○)([A-O])(1[0-5]|[1-9])$/)
  if (!m) continue
  board.set(COLS.indexOf(m[3]), 15 - Number(m[4]), m[2] === '●' ? BLACK : WHITE)
}
const me = snap.turn

/* ---------------- 输出 ---------------- */
const depth = Number(process.env.DEPTH || 4)
const timeLimit = Number(process.env.TIME || 6000)
const width = Number(process.env.WIDTH || 12)
const radius = Number(process.env.RADIUS || 2)
const topN = Number(process.env.TOP || 12)

const r = rootScores(board, me, { depth, timeLimit, width, radius, only: process.env.ONLY ? process.env.ONLY.split(',') : null })
const maxAbs = Math.max(1, ...r.scored.map((s) => Math.abs(s.value)))

// 交叉验证：项目引擎自己的深度搜索首选（只取榜首，值同样是精确的）
const t0 = Date.now()
const deep = snap.over ? null : AI.findBestMove(board, me, {
  depth: Number(process.env.TOPDEPTH || 8), timeLimit: Number(process.env.TOPTIME || 5000), width, radius,
})

const out = {
  turn: me === BLACK ? 'BLACK(●)' : 'WHITE(○)',
  moves: snap.moves,
  over: snap.over,
  engine: { depthRequested: depth, nodes: r.nodes, ms: r.ms, width, radius, partial: !!r.timeouts },
  engineTop: deep ? { move: name(deep.x, deep.y), x: deep.x, y: deep.y, value: Math.round(deep.score), depth: deep.depth, reason: deep.reason, ms: Date.now() - t0 } : null,
  forced: r.forced || null,
  candidates: r.scored.slice(0, topN).map((s, i) => ({
    move: name(s.x, s.y), x: s.x, y: s.y,
    value: Math.round(s.value), rank: i + 1, tag: s.tag || '',
    t: tacticalScan(board, me, s.x, s.y),
  })),
}
console.log(JSON.stringify(out, null, 2))
ws.close()
