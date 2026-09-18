# YuanMy Agent 桌面客户端

Electron 外壳。**复用 `app/cli/` 的同一套 DSH 内核装配**，只把「终端渲染」换成「窗口界面」。

```
npm run desktop          # 打开窗口
```

> **文件扩展名约定**（都受根 `package.json` 的 `"type": "module"` 影响）：
>
> | 文件 | 模块系统 | 说明 |
> | --- | --- | --- |
> | `main.js` / `ipc.js` / `host/*.ts` | ESM | `"type": "module"` 下 `.js` 就是 ESM，无需 `.mjs` |
> | `preload.js` | **CommonJS** | 见下方说明，**不要改成 `import`** |
> | `renderer/src/main.tsx` | TSX | 由 `<script src>` 加载，不走 Node 模块系统 |
>
> `preload.js` 是全项目唯一「`.js` 但属于 CommonJS」的文件：
> **Electron 加载 preload 时会忽略 `"type": "module"`**，一律按 CommonJS 执行
> （官方文档 *ES Modules (ESM) in Electron*：「Preload scripts will ignore
> `type: module` fields」），沙箱化 preload 也不支持 ESM `import`。
> 所以这里的 `require('electron')` 是有效的，`npm run desktop:smoke` 实测
> `bridge=object` 验证过；`ui-smoke.js` 里也有一条断言拦着它被改成 ESM。
>
> 代价要说清楚：**除了 Electron，所有工具都会以为它是 ESM**（Node、编辑器、linter、打包器）。
> 想消除这个歧义，把文件名换回 `preload.cjs` 就行 —— 官方的 DSH 桌面端正是这么做的
> （`lib/main.js` 走 ESM，`src/main.ts` 里引用的却是 `preload-app.cjs` /
> `preload-mandatory.cjs`，其 `tsdown.config.ts` 的注释写着
> "Sandboxed Electron preloads run as CommonJS even though the application package is ESM"）。
> 两种命名本项目都验证可用，选 `.js` 是为了统一观感。

---

## 1. 三个进程，一条数据流

```
┌──────────────────────── Electron 主进程 (main.js) ────────────────────────┐
│  窗口 / 菜单 / 单实例锁 / 原生目录选择框                                    │
│  ipcMain.handle(...)  ←─ 只接受本窗口的调用（assertSender）                 │
└───────┬──────────────────────────────────────────────────▲─────────────────┘
        │ Node IPC（结构化消息，不是 stdout 解析）           │
        │ HostRequest: prompt / cancel / set-model / shutdown│ HostEvent: ready
        ▼                                                    │ text-delta / reasoning-delta
┌──────────────── agent host 子进程 (host/index.ts) ──────────┴────────────────┐
│  用**系统 node** 启动；installApiKey → bootKernel（app/cli/kernel.ts）       │
│  bridge.ts 把内核事件翻译成 UI 帧                                            │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────── 渲染进程 (renderer/) ────────────────┐
│  React 应用：无 Node、无 ipcRenderer，只能看到 window.YuanMy │
│  Markdown 由 Streamdown 渲染（代码高亮走 shiki）        │
└──────────────────────────────────────────────────────┘
```

| 文件 | 语言 | 角色 |
| --- | --- | --- |
| `main.js` | JS（ESM） | Electron 主进程：窗口、菜单、生命周期、IPC 收口、host 子进程管理、窗口材质 |
| `preload.js` | JS（**CommonJS**） | 安全桥：把一组函数挂到 `window.YuanMy`，此外什么都不暴露 |
| `ipc.js` | JS（ESM） | IPC 频道名 + shell 状态形状（只被主进程引用） |
| `host/index.ts` | TS | agent host：装凭据、起内核、驱动回合、收发协议消息 |
| `host/bridge.ts` | TS | 内核事件 → UI 帧；工具摘要直接复用 CLI 的 `summarizeCall` / `summarizeResult` |
| `host/protocol.ts` | TS | 主进程 ⇄ host 的类型契约（唯一的「协议真相」） |
| `renderer/src/**/*.tsx` | **TSX** | React 组件：`app.tsx`、`use-agent.ts`、`markdown.tsx`、`components/` |
| `renderer/styles/app.css` | CSS | Tailwind v4 + Codex 色板 + 组件样式 |
| `renderer/dist/` | 产物 | 构建输出（**不入库**，`npm run build:renderer` 生成） |

### 为什么渲染进程是 TSX，而 Electron 那两个文件还是 JS

- **`renderer/` 用 TypeScript（`.tsx` / `.ts`）**：React 组件、事件类型、归约器都值得被类型保护。
  它**不归 Electron 加载** —— 由 esbuild 打包，类型由独立的
  `renderer/tsconfig.json` 检查（`DOM` + `jsx: react-jsx`），与 Node 侧的
  `tsconfig.json` 分开，互不污染全局类型。
- **`preload.js` 必须是 JS**：沙箱化 preload 的 `require` 只认 `electron`，
  更没有 TypeScript 加载能力，所以它只能是一段自包含的 CommonJS。
- **`main.js` 保持 JS**：Electron 主进程直接执行它，而 Electron 自带 Node 不保证
  开启类型擦除，`.ts` 不一定能跑。想改造的话得先引入构建步骤（或确认目标
  Electron 版本的 Node 支持 `--experimental-strip-types`）。

类型检查分两个项目跑：

```bash
npm run typecheck    # tsc --noEmit（Node 侧） && tsc --noEmit -p app/desktop/renderer/tsconfig.json
```

### 渲染进程为什么需要构建

Markdown 用 [Streamdown](https://streamdown.ai/)（React 组件）渲染，它需要 React 运行时
和 Tailwind 生成的样式；浏览器跑不了 JSX，`file://` 下也没有裸包名解析。
所以 `scripts/build-renderer.js` 用 esbuild + PostCSS 把它们**打成两个文件**：

```
renderer/dist/renderer.js     IIFE（React + Streamdown + shiki + 我们的组件）
renderer/dist/renderer.css    Tailwind 产出（含 Streamdown 的类名）
```

主进程与 host 依旧零构建（`.js` / `.ts` 直接跑）。`npm run desktop` 会先构建再启动；
改界面时用 `npm run desktop:watch` 起监听。

> **bundle 有 ~10 MB**，其中约 9 MB 是 shiki 的语法定义（200 多种语言）。
> `@streamdown/code` 号称按需加载语言，但单文件 IIFE 会把动态 import 全部内联。
> 实测代价很小（**冷启动到窗口可见约 235 ms**，V8 会惰性解析没被执行到的函数体），
> 所以先保持简单。真要瘦身有两条路：去掉 `@streamdown/code`（约 1 MB，代码块不再高亮），
> 或改用自定义协议（`app://`）加载界面以支持代码分割 —— 官方 DSH 桌面端走的就是后者。

---

## 2. 为什么内核跑在**子进程**里

1. **原生模块 ABI**。DSH 的执行能力 provider 是原生模块（`dsh-fs-local` → koffi、
   `dsh-subprocess-local` → node-pty），按系统 Node 的 ABI 编译。Electron 自带 Node 的
   ABI 不同，直接在主进程里 `import` 会在加载 `.node` 时失败。
2. **隔离**。渲染进程崩溃 / 窗口重载 / 用户点「刷新」都不会带走内核状态；
   反过来，内核里跑飞的子进程也不会卡住窗口。
3. **可单独调试**。`npm run desktop:host-smoke` 能在完全没有 Electron 的情况下
   把整条内核链路跑一遍。

代价是多一层 IPC —— 但消息是结构化对象（`child_process` 的 Node IPC，不是解析 stdout），
所以没有「日志和协议混在一条流里」的麻烦。父进程消失时子进程会收到 `disconnect`，
自行 `dispose()` 内核并退出，不留孤儿进程。

---

## 3. IPC 契约：加一个功能要改哪几处

渲染进程能做的事，全部由 `preload.js` 的 `api` 对象定义。加一个动作的完整链路：

1. `ipc.js`：往 `IPC` 表里加频道名（例如 `theme: 'YuanMy:theme'`）；
2. `main.js`：加 `ipcMain.handle(IPC.theme, (event) => { assertSender(event); … })`；
3. `preload.js`：在 `CHANNEL` 与 `api` 里各加一条（**沙箱化 preload 不能 require 本地文件，
   所以频道字面量必须重复一份**）；
4. `renderer/src/` 里调用 `api.theme(...)`（组件或 `use-agent.ts`）。

第 3 步的两处重复是最容易出错的地方，所以 `scripts/ui-smoke.js` 里有一条静态检查：
它会比对 `ipc.js` 与 `preload.js` 的频道名集合、渲染进程调用的 api 方法是否都已暴露、
`getElementById` 用到的 id 是否都在 `index.html` 里。**改完先跑 `npm run desktop:ui-smoke`。**

想让界面显示一种**新的内核事件**，则是另一条链路：

1. `host/protocol.ts`：往 `HostEvent` 联合类型加一个分支（顺便更新 `isHostEvent`）；
2. `host/bridge.ts`：在对应事件里 `this.send({ type: '...' })`；
3. `renderer/src/use-agent.ts`：在归约器的 `switch` 里加 `case`，再到 `components/message.tsx` 里决定怎么渲染。

`ui-smoke.js` 也会检查 renderer 里 case 的事件类型在协议里有定义（或属于
`ipc.js` 的 `SHELL_EVENT_TYPES`，那是主进程自己产生的事件）。

---

## 4. 启动时序

```
main.js: app.whenReady().then(onReady)      ← 注意：不是顶层 await，见下
  ├─ registerIpc()          先装 handler，避免界面抢跑
  ├─ buildMenu()
  ├─ createWindow()         窗口立刻显示（先出界面，不空等）
  └─ restartWith(config)    spawn host → host 发 ready → 状态置为 ready
                            ready 之前渲染进程拿到的是 { phase: 'booting' }

host/index.ts:
  parseOptions(argv)        复用 CLI 的参数解析（--cwd / --model / --resume …）
  installApiKey()           必须早于任何 DSH 模块被求值（见 app/cli/main.ts 的说明）
  bootKernel(options)       手工装配整棵插件树
  send({ type: 'ready' })   把侧栏要的信息一次性发过去
```

### ⚠️ 主进程入口不能用顶层 `await app.whenReady()`

这是本项目踩过的坑，而且现象很有迷惑性：**进程活着、日志正常、但永远不出现窗口。**

Electron 的 ESM 主进程入口是异步加载的，在模块顶层 `await` `ready` 会与 Electron
自己的启动流程互相等待（Electron 44 实测必现）。最小复现：

```js
// ❌ 卡死：module loaded 之后再无输出，也没有窗口
import { app } from 'electron'
await app.whenReady()

// ✅ 正常：ready 事件照常派发
app.whenReady().then(() => { /* … */ })
```

所以 `main.js` 把所有「需要 ready」的工作放进 `onReady()`，用 `.then()` 注册；
事件监听（`window-all-closed` / `activate` / `before-quit`）则同步注册，它们不需要等 ready。
注意这**不是**「顶层 await 不能用」—— `host/index.ts` 就大量用了顶层 await，
它跑在普通 Node 进程里，没有这个限制。

界面用 `getState()` + `onEvent()` **两条腿**拿状态：先订阅事件再拉一次快照，
这样无论内核是在界面订阅之前还是之后就绪，都不会漏掉 `ready`。

---

## 5. 安全基线

| 措施 | 位置 | 作用 |
| --- | --- | --- |
| `contextIsolation: true` | `main.js` | 网页脚本与 preload 处于不同 JS 世界 |
| `nodeIntegration: false` | `main.js` | 网页拿不到 `require` / `process` |
| `sandbox: true` | `main.js` | preload 也在沙箱里，只能 `require('electron')` |
| `contextBridge` 白名单 | `preload.js` | 网页只能看到 9 个函数，看不到 Electron 对象 |
| CSP `script-src 'self'` | `renderer/index.html` | 界面不加载任何远程脚本 |
| Streamdown 内置净化 | `streamdown` 依赖 | Markdown 走 `rehype-harden` + `rehype-sanitize` 后再渲染 |
| 链接只当按钮 | `markdown.tsx` | Streamdown 把链接渲染成 `<button>`，点击经 `window.open` → 主进程转系统浏览器 |
| `assertSender` | `main.js` | 每个 handler 校验调用方是不是本窗口 |
| `setWindowOpenHandler` | `main.js` | 新窗口一律拒绝，http(s) 交给系统浏览器 |

> CSP 里 `style-src` 带 `'unsafe-inline'`：Streamdown / shiki 会在运行时注入 `<style>`
> （代码高亮主题）。样式注入不构成脚本执行风险，而 `script-src` 依然是收紧的。

---

## 6. 界面是怎么长出来的

### 数据流：事件 → 归约器 → 组件

`renderer/src/use-agent.ts` 是**唯一**把 host 事件翻译成 UI 数据的地方，
它是一个纯函数归约器（所以能在 Node 里直接回放测试）。产出的一条会话由若干条目组成：

```
{ kind: 'user',      text }
{ kind: 'note',      level, text }                  系统提示
{ kind: 'assistant', turnId, reasoning, blocks[], meta }
```

助手条目的 `blocks` 是**有序**的，于是「先说话 → 调工具 → 再说话」被如实还原：

```
blocks: [ {type:'text', text:'我先看目录。'}
          {type:'tool', callId, name, args, result, isError}
          {type:'text', text:'这是一个 Electron 壳。'} ]
```

| 事件 | 归约结果 |
| --- | --- |
| `ready` | 状态置 ready，侧栏拿到模型 / 会话 / 目录 / 凭据 / 工具 |
| `restarting` | 清空会话，状态回到启动中 |
| `text-delta` | 追加到**最后一个** text 块；上一个动作是工具就新起一块 |
| `reasoning-delta` | 追加到 `reasoning` |
| `tool-call` | push 一个 `tool` 块（`result: null` = 运行中） |
| `tool-result` | 按 `callId` 回填；找不到对应调用就补一张卡片，不丢信息 |
| `turn-end` | 写 `meta`（结论 + 工具次数），解除忙碌 |
| `notice` / `fatal` / `host-error` | 追加系统提示；致命错误把状态切成不可用 |
| `workspace` | 刷新侧栏的项目 / 会话清单（就绪后、每轮结束、以及界面主动请求时各来一次） |
| `usage` | 累加 token 计量（每个模型 step 一帧），并记下最近一次调用的明细 |

### 视觉：Codex 配色 + 原生磨砂玻璃

- **配色**（`styles/app.css` 的 `@theme`）：近单色。底色 `#0d0d0d`，层次靠
  `surface` 的微差与半透明白描边拉开；主按钮是白底黑字；只有成功/警告/失败
  三种状态用彩色。**没有渐变，也没有紫蓝**。
- **Streamdown 换肤**：Streamdown 内部用的是 shadcn 那套 token 名
  （`bg-muted`、`text-muted-foreground`、`border-border`、`text-primary`…）。
  Tailwind 只为**已定义**的 token 生成工具类，缺了会被静默丢掉（行内代码/链接/表格就没样式），
  所以 `@theme` 里把这一整套别名都映射到了上面的色板。
- **磨砂玻璃**：由**窗口材质**提供，不是 CSS。
  `main.js` 的 `windowMaterial()` 在 macOS 用 `vibrancy: 'sidebar'`、
  Windows 11 用 `backgroundMaterial: 'acrylic'`，Linux 退回不透明。
  渲染进程把结果写进 `html[data-vibrancy]`，CSS 只在 native 时让侧栏让出背景。
  **刻意不用 `backdrop-filter`**。
- **顶部栏**：`titleBarStyle: 'hidden'`。系统标题栏没了之后窗口不会自己变可拖拽，
  所以侧栏品牌区与顶栏都挂 `.drag-region`（`-webkit-app-region: drag`），
  里面的按钮一律 `.no-drag`；`html[data-platform="darwin"]` 给红绿灯留位，
  `win32` 给 `titleBarOverlay` 留位。冒烟测试会断言「拖拽区数量 > 0」。

**想改外观**：只动 `styles/app.css`（颜色全在 `@theme` 里）。
**想加消息类型**：在 `use-agent.ts` 里加一条 `case`，再到 `components/message.tsx` 里渲染。

### 侧栏：项目 → 会话的树

数据不是另建的索引，而是**直接读会话日志**（`host/sessions.ts`）——
索引会和日志不同步，日志才是真相。每个摘要从 JSONL 里取：

| 字段 | 来源 |
| --- | --- |
| `id` / `createdAt` / `cwd` | 第一行 `{"type":"session", …}` |
| `title` | 优先最后一条 `session/title` 事件，否则第一条 `source.kind === 'user'` 的 `user/message` |
| `turns` | `turn/end` 事件条数 |
| `updatedAt` | 文件 mtime 与最后一条事件 `time` 取大 |

两个刻意的取舍：

- **项目目录名不可逆**（`--Users-me-proj--` 这种转义），所以项目的真实 cwd 从它
  最新那个会话的日志头里读，而不是去猜转义规则；
- **有界读**：每个会话最多整体读 2 MB，更大的只读头部 256 KB（标题总在开头），
  此时 `turns` 是下界。当前项目最多列 40 个会话。
- 当前会话如果还没落盘（新建后没跑过回合），会**补一条合成记录**，
  否则侧栏标不出「当前」，新建会话后看起来像没生效。

**层级与懒加载**。侧栏是「项目 → 会话」两级树，点击项目行折叠/展开，点击会话恢复它。
数据分两批来，这是刻意的：

| 时机 | 帧 | 内容 |
| --- | --- | --- |
| 就绪 / 每轮结束 / 手动刷新 | `workspace` | 项目清单 **+ 当前项目的会话** |
| 展开某个折叠项目 | `project-sessions`（响应 `list-project-sessions`） | 那个项目的会话 |

首屏只读当前项目的会话，其他项目等被点开时才读盘 —— 项目再多也不会拖慢启动。
展开状态存在组件里（`currentOpen` + `expandedProjects`），首次展开才请求，之后先用缓存。

**侧栏刻意不放的东西**（都是重复或只在排查时才有用的「参数」）：
状态行 → 并进底栏一个小圆点；模型名 → 就是下面那个输入框；会话 id → 树里已高亮；
工具清单 → 底栏 `13 工具` 点一下展开；凭据 → **只在缺失时**以警告形式出现。

点击会话 = `restart({ resume: id, cwd })`（CLI 的 `--resume` 早就通了，这里只是给它一个界面）。
点击其它项目的「切换」= `restart({ cwd })`，即用新工作目录启一个新会话。

> ⚠️ 会话只属于它的项目。`main.js` 的 `restartWith()` 里有条规则：**cwd 变了就丢掉
> `resume` / `sessionId`** —— 否则会拿着上一个项目的会话 id 去新项目里找。

`title` 的正式来源是 `@deepseek-ai/dsh-session-title`（写 `session/title` 日志事件）。
本项目**暂时没挂它**（它还需要 `dsh-invariants` 那套 companion 插件），
但读取端已经优先认这个事件 —— 以后挂上，或用 DSH 自己的 CLI 建过会话，标题会自动变好。

### 输入框下的 token 统计

数字来自 `assistant/message` 事件上的 `TokenUsage`（`bridge.ts` 发 `usage` 帧）。

**关键：DSH 的计数是互斥的**（见 `dsh-llm` 里 `TokenUsage` 的注释）：

```
inputTokens      只算未命中缓存的输入
cacheReadTokens  命中缓存而复用的输入
cacheWriteTokens 写入缓存的输入
计费输入 = 三者之和        ← 命中率的分母
```

所以「命中率」= `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`，
而**不是** `cacheRead / (input + cacheRead + cacheWrite + output)`，
也不是把 `totalTokens` 当分母（`totalTokens` 是含输出的整次调用总量）。
没有输入 token 时返回 `null`，界面显示 `—` —— 不伪造 0%。

展示上是**会话累计**（每帧累加），鼠标悬停看最近一次调用的明细
（未命中 / 命中 / 写入 / 输出含推理 / 合计）。判定与累加都是纯函数
（`billedInputTokens` / `cacheHitRate` / `accumulate`），`ui-smoke.js` 有真值表。

### 布局：为什么 `.app-shell` 必须写 `grid-template-rows: minmax(0, 1fr)`

这是修过的一个真 bug，症状很具迷惑性：**展开一段长推理后，左侧栏「样式变了」，内容一多就卡死。**

原因不在推理块，而在这条规则：

```css
.app-shell { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100% }  /* ❌ */
```

只写 `height: 100%` 时，grid 的行是**隐式 auto**，会被内容撑高。于是：

1. `.messages` 不再是「视口内的滚动区」，整篇文档变得很长；
2. `.sidebar` 是同一个 grid 的行内 item，被拉到和内容一样高 ——
   实测展开一段推理后侧栏从 **800px 变成 1723px**，底部内容顶出可视区，
   看起来就是「侧栏样式变了」；
3. 文档动辄几千像素高 + 超长不可断 token，每次交互都触发整篇重排 → 渲染进程卡死。

修法是两处一起（缺一不可）：

```css
.app-shell { grid-template-rows: minmax(0, 1fr); overflow: hidden }   /* 行高锁在容器内 */
.main-column, .messages { min-height: 0 }                              /* 子项允许收缩 */
```

外加 `.reasoning__body { overflow-wrap: anywhere }`：推理里可能出现超长无空格片段
（路径、base64、连续汉字），`break-word` 不参与 min-content 计算，`anywhere` 才会，
容器因此能正常收缩 + 换行。

`desktop:smoke` 的**布局探针**盯着这件事：注入一段带 4000 字符不可断 token 的推理，
展开后断言「外壳/侧栏/body 高度 ≤ 视口」「内容撑高的是 `.messages` 的内部滚动区」
「展开耗时 < 250ms」。反向验证过：把 `minmax(0, 1fr)` 去掉，它会打印
`侧栏 800→1723` 并以退出码 1 失败。

### 输入法（IME）组字守卫

中文 / 日文 / 韩文输入法组字时，回车是**确认候选词**、Escape 是**取消组字**，
都不是「发送 / 中断」。如果 `onKeyDown` 只判断 `event.key === 'Enter'`，用户打一个词
按回车就会把半成品发出去 —— 这是修过的真实 bug，守卫在 `src/composition.ts`。

判定用三个信号，缺一不可：

| 信号 | 覆盖的情况 |
| --- | --- |
| `nativeEvent.isComposing === true` | 通用情况。⚠️ React 的**合成事件没有** `isComposing`，必须从 `nativeEvent` 取 |
| `nativeEvent.keyCode === 229` | macOS Chromium 的边界情况：确认组字那次回车，`compositionend` **先于** `keydown` 派发，此时 `isComposing` 已是 `false`，只剩 229 这个哨兵值 |
| `compositionend` 后同一宏任务内的临时标记 | 兜住上面两条之外的同任务顺序差异 |

**刻意不用持久标志位判断「组字中」**：某些输入法 / 场景下 `compositionend` 不触发，
标志位会永久卡在 `true`，表现是**回车彻底发不出去**（社区有 Windows 上的真实案例）。
所以第 3 条只活一个宏任务，由定时器保证清掉。

用法：`const ime = useImeGuard()`，把 `ime.compositionProps` 展开到输入元素上，
然后在 `onKeyDown` 的**第一句**写 `if (ime.isImeKey(event)) return`。
输入框（`composer.tsx`）与侧栏的模型输入框（`sidebar.tsx`）都挂上了 ——
后者不拦的话，浏览器会顺手提交那个 `<form>`，等于拿半截拼音去切模型。

验证分两层：`ui-smoke.js` 跑纯函数真值表（其中「普通回车不能被拦」这条用来防止
守卫把回车卡死）；`desktop:smoke` 在真实窗口里派发
`compositionstart → keydown(isComposing) → compositionend → keydown(229)`，
断言**组字中发送 0 次、组字刚结束发送 0 次、普通回车发送 1 次**。

---

## 7. 怎么验证

`desktop:smoke` 现在由 `scripts/smoke-desktop.js` 包一层，先造一个**临时工作区**再跑：

- 测试会话写进临时目录，**不再落到你真实的 `.YuanMy/sessions`**
  （早先每次冒烟都会在你侧栏里留下一条「只回答两个字：好的」）；
- 顺便造出「两个项目」的 fixture，让**项目树的懒加载**能被真正验证
  （折叠的项目点开前 0 条会话、点开后从磁盘读出来）。

```bash
npm run verify              # typecheck + 构建 + 界面链路 + 内核链路
npm run desktop:ui-smoke    # 纯 Node：静态契约 + 归约器回放 + Markdown 真渲染
npm run desktop:host-smoke  # 真起 host；加 --keep 保持，加 -p "…" 跑真实回合
npm run desktop:host-smoke -- -p "用 tree 看下 app/desktop"
npm run desktop:smoke       # 真开窗口，验证窗口/preload/渲染进程/内核后自动退出
```

`ui-smoke.js` 不需要窗口，分四层：

1. **静态契约** —— `data-testid` 是否都在源码里、IPC 频道名两边一致、
   渲染进程只调用 preload 暴露的方法、preload 是否仍是 CommonJS、构建产物是否比源码新；
2. **归约器回放** —— 直接 import 那个纯函数，按真实顺序灌事件，断言消息结构
   （正文被工具切成两块且顺序正确、结果按 callId 回填、中断/错误/重启的状态迁移）；
3. **输入法守卫真值表** —— `isImeKeyEvent()` 的 8 条断言，含两条防回归：
   「组字中的回车要拦」与「普通回车**不能**拦」；
4. **Markdown 真渲染** —— 用 `react-dom/server` 把 Streamdown 渲染成 HTML，
   断言 `# 标题` → `<h1>`、`**粗体**` → `data-streamdown="strong"`、表格/列表/代码块
   都被解析，且**没有把 Markdown 源码原样贴出来**。

**加界面功能后，往这个脚本里补一条断言**，比手动点窗口可靠得多，CI 里也能跑。

`desktop:smoke` 还有三个「踩过坑才加的」东西，改动这个脚本时别删：

- **逐行立即输出**（`say()`）：原先攒到最后一起打印，一卡住就什么都看不到；
- **总看门狗**（180s 强制失败退出）：曾经因为一个探针 `ReferenceError` 让 Promise
  永不 settle，把 CI 死等到超时；
- **转发渲染进程的 console**：界面侧的异常（React 抛错、CSP 拦截、未处理的 Promise）
  只有这条通道能看到 —— 上面那个 `ReferenceError` 就是它一句话点出来的；
- **布局探针**：注入长推理并展开，断言外壳没有被内容撑高（见上一节）；
- **项目树探针**：折叠当前项目（会话必须从 DOM 消失）→ 再展开 → 点开另一个项目并等懒加载。

> 探针脚本与界面是两套作用域：`SMOKE_WAIT_TURN` 必须自带助手函数，
> 不能借用 `SMOKE_PROBE` 里的（借用过一次，报 `text is not defined`，
> 而且现象是「界面好像卡住了」，极难定位）。

> `desktop:smoke` 用**独立的 userData 目录**（`<tmp>/YuanMy-Agent-smoke`），
> 所以它可以在你正开着桌面端的时候照跑不误。这一点是必须的：早先它和运行中的
> 实例抢单实例锁，失败后走的是 `app.quit()`，于是**安静地退出、什么都没测**，
> 而 `verify` 会把它当成通过。现在拿不到锁会明确报错并以非零码退出。

`desktop:smoke` 是**真窗口**验证：开窗口 → 等内核就绪 → 用
`webContents.executeJavaScript` 反向读取 React 渲染出来的 DOM（状态灯、侧栏字段、
拖拽区数量、平台与磨砂玻璃标记），所以「窗口开了但界面是白的 / preload 没注入 /
React 没挂载」这类问题一定会被它抓到。加 `YuanMy_SMOKE_PROMPT` 还能在真实窗口里
跑完一个完整回合（走渲染进程的 `window.YuanMy.sendPrompt`，即用户点「发送」那条路径），
并断言 Markdown 真的被解析成标题/粗体/代码块：

```bash
YuanMy_SMOKE_PROMPT="用 tree 看一下 app/desktop，然后用 markdown 汇总" npm run desktop:smoke
# [desktop] 窗口可见 · 启动耗时 254ms
# [smoke] renderer · status=就绪 · bridge=object · React 已挂载=true
# [smoke] 外观 · platform=darwin · 磨砂玻璃=native · 拖拽区 2 处
# [smoke] turn · 完成 · 1 次工具调用 · 工具卡片 1 张
# [smoke] markdown · 块 1 · 代码块 0 · 粗体 0 · 标题 1 · 列表 1
# 退出码 0 表示全绿
```

---

## 8. 已知限制与下一步

- **不能打包**：目前只有开发态运行。出安装包需要补 `electron-builder` 配置与签名，
  可参考 DSH 的 `apps/desktop`（它的做法是把整个运行时打进 asar）。
- **bundle 偏大（~10 MB）**：见第 1 节的说明与两条瘦身路线（去 code 插件 / 换 `app://` 协议）。
- **只有一个会话窗口**：换会话 = 重启内核。要做多会话需要把 `host` 从「单例」改成
  「按会话 id 管理多个子进程」，协议里再加会话维度。
- **没有历史回放**：会话 JSONL 已经落盘（`<cwd>/.YuanMy/sessions/…`），
  但界面还没读它；`--resume` 目前只能从主进程传参（可以先用
  `restart({ resume: '<会话 id>' })` 试）。
- **没有附件 / 图片**：`dsh-attachment-local` 已经在内核里挂好了，
  补一条「把文件路径塞进用户消息」的协议字段就能用起来。
- **代码块没有「复制」按钮与行号**：Streamdown 支持，但需要在
  `markdown.tsx` 里补自定义 renderer。
- **Windows / Linux 未验证**：磨砂玻璃、`titleBarOverlay`、菜单角色、
  `desktop:smoke` 的 `VAR=1` 语法都按平台分了支，但只在 macOS 上跑过。
  Linux 保留原生标题栏（否则没有关闭按钮），代码块与磨砂玻璃会自动退回不透明样式。
