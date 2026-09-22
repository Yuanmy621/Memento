/**
 * 3D 中国象棋 · Jev PK 驱动
 *
 * 连接真实（有窗口的）Chrome 的 CDP，读写 window.__XQ 局面。
 * 子命令：
 *   state                    打印当前局面快照
 *   snapshot                 打印局面 + 候选着法（供 Jev 决策）
 *   play <from> <to>         走一步，并等待内置 AI 应着结束
 *   newgame <side> <level>   开新局（side: 1 红 / -1 黑）
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PROJECT = '/Users/yuanmingyuan/Acmer/YuanMy/3D 中国象棋';
const RL = await import(pathToFileURL(path.join(PROJECT, 'src/game/rules.js')).href);
const AI = await import(pathToFileURL(path.join(PROJECT, 'src/game/ai.js')).href);

const CDP = 'http://127.0.0.1:9222';
const DEPTH = Number(process.env.XQ_DEPTH || 2);

async function connect() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:5180'));
  if (!page) {
    console.error('targets:', list.map((t) => [t.type, t.url]));
    throw new Error('找不到象棋页面（localhost:5180）');
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const r = waiting.get(m.id);
    if (r) { waiting.delete(m.id); r(m); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  return { ev, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(ev, { timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const st = await ev('JSON.stringify({phase:__XQ.S.phase, ply:__XQ.S.history.length, side:__XQ.S.side})');
    const o = JSON.parse(st);
    if (o.phase === 'human' || o.phase === 'over' || o.phase === 'idle') return o;
    last = st;
    await sleep(400);
  }
  throw new Error('等待 AI 超时: ' + last);
}

const NAMES = { 1: '帅', 2: '仕', 3: '相', 4: '马', 5: '车', 6: '炮', 7: '兵', '-1': '将', '-2': '士', '-3': '象', '-4': '马', '-5': '车', '-6': '炮', '-7': '卒' };
const RED_NAMES = RL.RED_NAMES, BLACK_NAMES = RL.BLACK_NAMES;

function boardArt(board) {
  const lines = [];
  for (let y = 9; y >= 0; y--) {
    const cells = [];
    for (let x = 0; x < 9; x++) {
      const p = board[y * 9 + x];
      cells.push(p === 0 ? '．' : p > 0 ? RED_NAMES[p] : BLACK_NAMES[-p]);
    }
    lines.push(String(y).padStart(2) + ' ' + cells.join(' '));
  }
  lines.push('    ' + [...Array(9).keys()].map((x) => String.fromCharCode(97 + x)).join(' '));
  return lines.join('\n');
}

function coord(sq) { return String.fromCharCode(97 + (sq % 9)) + ((sq / 9) | 0); }

/** 用项目自带引擎做浅层搜索，给候选着法排序（代码负责候选生成，Jev 负责决策） */
function shrunkRank(board, side, limit = 8) {
  const legal = RL.generateLegalMoves(board, side);
  const rows = [];
  for (const mv of legal) {
    const from = RL.moveFrom(mv), to = RL.moveTo(mv);
    const next = RL.cloneBoard(board);
    const captured = RL.makeMove(next, mv);
    let score;
    if (RL.typeOf(captured) === RL.K) score = RL.MATE_SCORE;
    else score = -AI.search(next, RL.flipSide(side), { maxDepth: DEPTH, timeMs: 400 }).score;
    const opp = RL.flipSide(side);
    const givesCheck = RL.inCheck(next, opp);
    rows.push({
      move: mv, from, to,
      notation: RL.moveToChinese(board, mv),
      piece: board[from],
      captured,
      givesCheck,
      score,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  // 确保吃子 / 将军的着法不被浅层评估漏掉
  const picked = rows.slice(0, limit);
  const extra = rows.filter((r) => (r.captured !== 0 || r.givesCheck) && !picked.includes(r)).slice(0, 2);
  return picked.concat(extra);
}

function material(board) {
  const left = { 1: {}, '-1': {} };
  for (let sq = 0; sq < 90; sq++) {
    const p = board[sq];
    if (!p) continue;
    const s = p > 0 ? 1 : -1;
    const t = Math.abs(p);
    left[s][t] = (left[s][t] || 0) + 1;
  }
  const name = (s, t) => (s === 1 ? RED_NAMES[t] : BLACK_NAMES[t]);
  const fmt = (s) => RL.PIECE_TYPES.map((t) => `${name(s, t)}×${left[s][t] || 0}`).join(' ');
  return { red: fmt(1), black: fmt(-1) };
}

async function main() {
  const cmd = process.argv[2] || 'state';
  const { ev, close } = await connect();
  try {
    if (cmd === 'newgame') {
      const side = Number(process.argv[3] || 1);
      const level = process.argv[4] || 'hard';
      await ev(`__XQ.api.newGame(${side}, '${level}').then(()=>1)`, true);
      const st = await waitIdle(ev);
      console.log(JSON.stringify({ ok: true, ...st }));
      return;
    }

    if (cmd === 'play') {
      const from = Number(process.argv[3]);
      const to = Number(process.argv[4]);
      const before = JSON.parse(await ev('JSON.stringify({ply:__XQ.S.history.length, side:__XQ.S.side})'));
      const res = await ev(
        `(async()=>{const b=__XQ.S.board.slice();const mv=__XQ.RL.encodeMove(${from},${to});` +
        `const ok=__XQ.RL.generateLegalMoves(b,__XQ.S.side).includes(mv);if(!ok)return{ok:false};` +
        `const nota=__XQ.RL.moveToChinese(b,mv);await __XQ.api.playMove(${from},${to});return{ok:true,nota};})()`,
        true,
      );
      if (!res.ok) { console.log(JSON.stringify({ ok: false, reason: '非法着法' })); return; }
      const st = await waitIdle(ev);
      const after = JSON.parse(await ev(
        'JSON.stringify({ply:__XQ.S.history.length, side:__XQ.S.side, phase:__XQ.S.phase,' +
        'moves:__XQ.S.history.map(h=>({n:h.notation,s:h.side})),' +
        'status:document.getElementById("statusText").textContent,' +
        'banner:document.getElementById("bannerText").textContent,' +
        'bannerShown:document.getElementById("banner").classList.contains("show")})'));
      const reply = after.moves.slice(before.ply);
      console.log(JSON.stringify({ ok: true, played: res.nota, ...st, reply, status: after.status, banner: after.bannerShown ? after.banner : null }, null, 1));
      return;
    }

    // state / snapshot
    const snap = JSON.parse(await ev(
      'JSON.stringify({board:Array.from(__XQ.S.board), side:__XQ.S.side, humanSide:__XQ.S.humanSide,' +
      'phase:__XQ.S.phase, ply:__XQ.S.history.length,' +
      'moves:__XQ.S.history.map(h=>h.notation),' +
      'status:document.getElementById("statusText").textContent,' +
      'engine:document.getElementById("engineText").textContent,' +
      'bannerShown:document.getElementById("banner").classList.contains("show"),' +
      'banner:document.getElementById("bannerText").textContent})'));
    const board = Int8Array.from(snap.board);
    const out = {
      phase: snap.phase, side: snap.side === 1 ? '红' : '黑', sideCode: snap.side,
      humanSide: snap.humanSide, ply: snap.ply, status: snap.status, engine: snap.engine,
      banner: snap.bannerShown ? snap.banner : null,
      moves: snap.moves,
      inCheck: RL.inCheck(board, snap.side),
      material: material(board),
      boardArt: boardArt(board),
    };
    if (cmd === 'snapshot') {
      const cands = shrunkRank(board, snap.side, 8);
      out.candidates = cands.map((c, i) => ({
        idx: i + 1,
        notation: c.notation,
        piece: NAMES[c.piece] || String(c.piece),
        from: coord(c.from), to: coord(c.to),
        capture: c.captured ? (c.captured > 0 ? RED_NAMES[c.captured] : BLACK_NAMES[-c.captured]) : null,
        check: c.givesCheck,
        engineScore: Math.round(c.score),
        legalCount: RL.generateLegalMoves(board, snap.side).length,
      }));
    }
    console.log(JSON.stringify(out, null, 1));
  } finally {
    close();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
