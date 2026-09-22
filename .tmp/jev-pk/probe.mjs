/** 深层校验：对给定着法列表跑项目自带引擎（深度6）打分 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const PROJECT = '/Users/yuanmingyuan/Acmer/YuanMy/3D 中国象棋';
const RL = await import(pathToFileURL(path.join(PROJECT, 'src/game/rules.js')).href);
const AI = await import(pathToFileURL(path.join(PROJECT, 'src/game/ai.js')).href);

const CDP = 'http://127.0.0.1:9222';
const list = await (await fetch(CDP + '/json/list')).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:5180'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m); } };
await new Promise((r) => { ws.onopen = r; });
const ev = async (expr) => {
  const i = ++id;
  const p = new Promise((res) => waiting.set(i, res));
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  const r = await p;
  return r.result?.result?.value;
};
const snap = JSON.parse(await ev('JSON.stringify({board:Array.from(__XQ.S.board), side:__XQ.S.side})'));
const board = Int8Array.from(snap.board);
const side = snap.side;
const depth = Number(process.env.PROBE_DEPTH || 6);

for (const arg of process.argv.slice(2)) {
  const [a, b] = arg.split('-');
  const sq = (s) => Number(s.slice(1)) * 9 + (s.charCodeAt(0) - 97);
  const from = sq(a), to = sq(b);
  const mv = RL.encodeMove(from, to);
  const legal = RL.generateLegalMoves(board, side).includes(mv);
  const next = RL.cloneBoard(board);
  RL.makeMove(next, mv);
  const r = AI.search(next, RL.flipSide(side), { maxDepth: depth, timeMs: 3000 });
  console.log(`${arg} ${RL.moveToChinese(board, mv)} legal=${legal} 深度${depth}黑方最优=${r.score} 节点=${r.nodes}`);
}
ws.close();
