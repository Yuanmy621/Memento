# 五子棋 3D · 双 Agent PK 操作说明

## 1. 环境（已经由白方 Agent 准备好）

| 项目 | 值 |
| --- | --- |
| 浏览器 | **可见的** macOS Google Chrome（非无头），窗口 1440×960 |
| 调试端口 | `http://127.0.0.1:9222`（CDP，仅本机可连） |
| 标签页 | `http://localhost:5173/`，标题 `五子棋 3D · Gomoku` |
| 页面接口 | `window.__gomoku`（项目自带调试钩子） |
| 共享脚本 | `/Users/yuanmingyuan/YuanMy/.tmp/jev-pk/gomoku.mjs` |

两个 Agent 连的是**同一个 Chrome、同一个标签页、同一盘棋**。不是各自开一个页面，
所以不需要同步——棋盘状态就在这个标签页里，谁落子对方立刻能看到。

## 2. 对阵

- 黑棋 `●` = 对手 Agent（先手）
- 白棋 `○` = 本会话的 Agent（后手）

规则：自由规则 15×15，黑先，连成 5 子（含长连）即胜。当前 `renju=false`。

坐标记法：列 `A`–`O`（左→右），行 `1`–`15`（下→上）。天元是 `H8`。

## 3. 对手 Agent 的操作方式

脚本在 `/Users/yuanmingyuan/YuanMy/.tmp/jev-pk/gomoku.mjs`（任何 cwd 都可以用绝对路径调用）。
如果你的 workspace 读不到这个路径，用第 4 节的内联片段。

```bash
GM=/Users/yuanmingyuan/YuanMy/.tmp/jev-pk/gomoku.mjs

# ① 看棋局：输出 JSON + 棋盘图（X=黑，O=白）
node $GM state

# ② 轮到你（黑）时落子；带 black 参数会做执子校验，不是黑方回合会被拒绝
node $GM play H8 black

# ③ 万一浏览器被关掉，重新拉起（幂等，已在跑就直接复用）
bash /Users/yuanmingyuan/YuanMy/.tmp/jev-pk/start-chrome.sh
```

`state` 的关键字段：

```json
{ "turn": 1, "over": false, "winner": 0, "moves": ["1.●H8", "2.○I9"],
  "side": "BLACK(●)", "turnColor": "黑", "stones": 2 }
```

- `turn`: `1`=黑方行棋，`2`=白方行棋
- `winner`: `0` 未结束，`1` 黑胜，`2` 白胜
- `moves`: 完整棋谱，可直接喂给模型

推荐循环：

```bash
while true; do
  S=$(node $GM state)
  OVER=$(echo "$S" | head -20 | python3 -c "import sys,json;print(json.loads(sys.stdin.read().split('\n\n')[0])['over'])")
  ...
done
```

简化版：先 `state`，如果 `turn==1 && over==false` 就决策并 `play <点> black`；否则等 1–2 秒再 `state`。

其他可用命令：
`node $GM eval "<js>"`（在页面执行表达式）、`node $GM shot out.png`（截图，需图像模型）、
`node $GM reset pvp`（**只允许在双方同意时重开**）。

## 4. 内联片段（不方便用脚本文件时）

```bash
node --input-type=module -e '
const CDP="http://127.0.0.1:9222";
const list=await (await fetch(CDP+"/json/list")).json();
const p=list.find(t=>t.type==="page"&&t.url.includes("localhost:5173"));
const ws=new WebSocket(p.webSocketDebuggerUrl); let id=0; const w=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); const r=w.get(m.id); if(r){w.delete(m.id);r(m)}};
await new Promise(r=>ws.onopen=r);
const ev=async x=>{const i=++id;const q=new Promise(r=>w.set(i,r));
  ws.send(JSON.stringify({id:i,method:"Runtime.evaluate",params:{expression:x,returnByValue:true,userGesture:true}}));
  return (await q).result?.result?.value};
console.log(await ev("JSON.stringify(window.__gomoku.state())"));           // 读棋局
// console.log(await ev("window.__gomoku.play(7,7)"));                      // 落子（x=7,y=7 即 H8）
ws.close()'
```

## 5. 公平性约定

- 只用 `state` / `play`，**不要**用 `eval` 直接改 `game.board`、`game.turn`、`game.history`。
- 不要在自己回合之外落子（脚本的 `black`/`white` 参数会挡住误操作）。
- 对局进行中不要 `reset`/`newGame`/切模式；要重开先跟对方说。
- AI 自动应手不需要：模式已是 `pvp`，页面不会自己走棋。

## 6. 目录内其他文件

- `gomoku.mjs` —— 共享 CDP 客户端（本文档的主角）
- `start-chrome.sh` —— 幂等启动可见 Chrome + CDP 9222
- `chrome-profile/` —— 独立 Chrome 用户目录（不影响你日常浏览器的登录态）
