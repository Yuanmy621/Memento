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
> 所以这里的 `require('electron')` 是有效的（实测 `window.YuanMy` 能拿到 bridge）。
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
3. **可单独调试**。`npm run desktop:host` 能在完全没有 Electron 的情况下
   把内核跑起来（输出是 NDJSON，可以直接 `| jq` 看）。

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

第 3 步的两处重复是最容易出错的地方：`ipc.js` 与 `preload.js` 的频道名必须逐字一致，
渲染进程能调的方法必须在 preload 里都暴露出来。**加界面动作时对着这两份表逐个核对。**

想让界面显示一种**新的内核事件**，则是另一条链路：

1. `host/protocol.ts`：往 `HostEvent` 联合类型加一个分支（顺便更新 `isHostEvent`）；
2. `host/bridge.ts`：在对应事件里 `this.send({ type: '...' })`；
3. `renderer/src/use-agent.ts`：在归约器的 `switch` 里加 `case`，再到 `components/message.tsx` 里决定怎么渲染。

渲染进程里 `case` 的事件类型必须来自 `host/protocol.ts` 的 `HostEvent`，
或者是 `ipc.js` 里 `SHELL_EVENT_TYPES` 那一组（主进程自己产生的事件）。

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

#### 项目树为什么能跨项目：一份「最近打开过」的登记

内核的 `stateDir` 默认是 `<cwd>/.YuanMy`，所以**每个项目一份会话库**，
项目自己的 `.YuanMy` 里看不到别的项目。只扫当前项目那一个根的话，树里永远只有
**一个**项目 —— 换到别的项目，上一个就直接消失了。数据位置不动，改用一份线索补齐：

```
main.js                                    host（sessions.ts）
<userData>/projects.json                   roots = [当前项目的库]
  { version, projects: [                   + 每个「最近打开」项目的 <path>/.YuanMy/sessions
      { path, lastOpenedAt }, …            ↓
  ] }                                      locateProjects(roots)
  ↓ 启动 host 时                          · 逐根扫项目目录，按日志头里的 cwd 分组
  env YuanMy_PROJECT_ROOTS=a:b:c           · 按 cwd 去重，**先扫的根优先**（当前库说了算）
```

几条刻意定的规则：

- **只在 host 起来了才登记**（`restartWith` 成功之后），启动失败的路径不会攒进表里；
- 登记只是**线索**：路径可能早被删了、库可能还不存在，host 读不到就跳过，
  **读写失败一律不影响启动**（顶多是侧栏少列一个项目）；
- 有界：登记最多 20 条，单次最多**多扫 8 个根**（`DEFAULT_MAX_EXTRA_PROJECTS`），
  项目清单总数仍受 `DEFAULT_MAX_PROJECTS` 限制；
- `list-project-sessions` 用**同一套根与同一套去重**，否则会出现
  「列出来的」和「点开的」不是同一个项目的诡异现象；
- 项目要**被打开过一次**才会进登记 —— 没跑过 YuanMy 的项目不会凭空出现在树里。

> ⚠️ 会话只属于它的项目。`main.js` 的 `restartWith()` 里有条规则：换 cwd 时，
> **上一个**会话的 `resume` / `sessionId` 要丢掉 —— 否则会拿着旧项目的会话 id
> 去新项目里找。但「恢复另一个项目里的会话」是**合法**组合（侧栏会同时给出目标
> cwd 和该项目的会话 id），所以判据是「调用方有没有明确要求恢复」，
> 不是「cwd 变没变」。早先写成后者，点别的项目下的会话会用**全新会话**启动，
> 界面一片空白 —— 就是用户报的「切换工作区中的会话后读不到历史」。

**侧栏刻意不放的东西**（都是重复或只在排查时才有用的「参数」）：
状态行 → 并进底栏一个小圆点；模型名 → 就是下面那个输入框；会话 id → 树里已高亮；
工具清单 → 底栏 `13 工具` 点一下展开；凭据 → **只在缺失时**以警告形式出现。

点击会话 = `restart({ resume: id, cwd })`（CLI 的 `--resume` 早就通了，这里只是给它一个界面）。
点击其它项目的「切换」= `restart({ cwd })`，即用新工作目录启一个新会话。

`title` 的正式来源是 `@deepseek-ai/dsh-session-title`（写 `session/title` 日志事件）。
本项目**暂时没挂它**（它还需要 `dsh-invariants` 那套 companion 插件），
但读取端已经优先认这个事件 —— 以后挂上，或用 DSH 自己的 CLI 建过会话，标题会自动变好。

### 设置界面（技能 / 命令 / MCP）

左下角「设置」打开一个面板，三个标签看三类配置，都是**磁盘上的文本文件**：

| 标签 | 文件 | 界面做的事 |
| --- | --- | --- |
| 技能 | `.agents/skills/<名字>/SKILL.md` | 列表标出 `全局` / `命令专用`，点开编辑正文（含 frontmatter 里的调用政策） |
| 命令 | `.agents/commands/<名字>.md` | 列表 + 编辑；显示它 `include` 了哪些文件 |
| MCP | `<cwd>/.YuanMy/mcp.json` | 每个服务器一个启用/停用开关 + 直接编辑 JSON；改完点「重启内核」生效 |

几个刻意的取舍：

- **用文本框而不是表单**：这些东西本来就是 Markdown / JSON，表单会挡住 frontmatter
  和注释；而且技能的调用政策就是 frontmatter 里两行，表单反而更绕。
- **数据由 host 收集**（`settings:list` → `settings` 帧）：只有它知道内核里**真正加载了
  哪些 skill**。界面因此能做一件表单做不到的事 —— 把「盘上有、内核没加载」的
  `SKILL.md` 用 ⚠ 标出来（frontmatter 写坏时 provider 只 warn 一句就忽略，
  表现是「文件在、技能不生效」；真踩过：上游 `report` skill 的描述里有 `EN: `，
  YAML 判定成嵌套映射直接抛错）。
- **文件读写放在主进程**（`YuanMy:settings-read` / `settings-write`），并且只允许
  `.agents` / `.dsh` / `.YuanMy` / `~/.YuanMy`（外加 `$YuanMy_SKILL_DIRS`、
  `$YuanMy_COMMAND_DIRS`）之内的路径 —— 渲染进程能要求写文件，所以这里是**安全边界**，
  不能相信传来的路径（`resolve()` 之后比前缀，`../` 逃逸因此无效）。
- **开关 MCP 只改那一条的 `enabled`**，不用界面上的字段重写整个文件：界面拿到的是
  **合并后**的启动参数（含从内置定义继承的），原样写回会把继承值固化进配置、
  还会丢掉不认识的字段。
- **`settings` 帧不进 `ready`**：它要读盘、要问内核，没必要让每次启动都付这个成本；
  打开面板时再拉（`settings:list`）。改完文件会自动重拉一次，所以「大小 / 告警」跟着变。

### 恢复会话：历史回放由 **host** 提供

点侧栏里的一个会话 = 用 `--resume <会话 id>` 重启内核。内核恢复的是 **agent 的
上下文**，界面这边还是空的（实时帧只描述「之后」发生的事），所以 host 会在
`ready` 之后补一帧 `history`：

```
点击会话 → IPC.restart({ resume }) → host 带 --resume 起来
        → ready（内核就绪）→ workspace（侧栏清单）→ history（历史记录）
```

渲染进程收到 `history` 后**整段替换** `items`（不是追加 —— 回放与实时是两条独立
路径，混起来会重复），`usage` / `turns` 也一并重置成「历史总和」。

回放在 `host/history.ts` 里做，读的是会话日志本身（`session.v3.jsonl`）——
不另存一份 UI 状态，因为 agent 的上下文也是从这份日志重建的，两边必须是同一份内容：

| 日志事件 | 变成界面上的 |
| --- | --- |
| `user/message`（`source.kind === 'user'`） | 用户气泡 |
| `assistant/message` 的 `reasoning` / `text` 块 | 推理行 / 正文 |
| `tool/call` + `tool/result`（按 `callId` 配对） | 工具卡片 / 文件卡片 |
| `turn/end` | 回合结论（完成 / 中断 / 失败） |
| `assistant/message` 的 `usage` | 累加成会话 token 统计 |

几个必须记住的坑（都有测试盯着）：

- **`source.kind === 'skill-catalog'` 的 `user/message` 要过滤掉**。技能目录是注入给
  模型看的，不是用户说的话 —— 不过滤的话界面上会冒出一大段「用户消息」。
- **`turn/end` 的 `reason.kind` 比界面枚举长**（还有 `blocked` / `interrupted`）。
  映射统一放在 `protocol.ts` 的 `toOutcome`，实时路径（`bridge.ts`）与回放路径
  共用它 —— 各写一份的话，同一个回合「刷新前 / 刷新后」会显示成不同结论。
- **回合结束了却没有助手消息**（被打断、崩在第一步）时补一条「这一回合没有产生输出」
  的提示，而不是留一条光秃秃的用户消息让人以为界面丢了东西。
- **只回放最近 50 个回合**（`maxTurns`），被截掉多少如实告知。更早的内容 agent 仍然
  记得（它的上下文来自完整日志），这个差异不藏着。
- **回放必须幂等**：条目 id 由 `sessionId + 序号` 生成，读两次得到同样的 key。

判断回放是否正常，看一眼就够：点侧栏里的历史会话，**旧对话应该消失、历史应该出现**
（同项目与跨项目都要试）。如果历史是空的，先看 `--resume` 有没有真的传下去。

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
（`billedInputTokens` / `cacheHitRate` / `accumulate`）—— 改这里时盯住两点：
没有输入 token 时命中率是 `null`（显示 `—`），以及三种输入 token 都要进分母。

### 工作台布局（左侧工作区 + 右侧对话/轨迹）

```
┌───────────────┬──────────────────────────────────────┐
│ 工作区  [+新会话]│  对话 | 轨迹            <cwd>         │ ← 标签栏（拖拽区）
│ [搜索会话   ]  ├──────────────────────────────────────┤
│ ▾ 项目         │  对话面板：推理行 / Markdown /        │
│    ● 会话  时间 │  工具行 / 文件卡片（图标+名字+打开）    │
│ ▸ 另一个项目   ├──────────────────────────────────────┤
│ ─────────────  │  [+][完全访问][模型▾]         [发送]   │
│ ● 就绪 13 工具 │  3.2k in/88 out · 3.0s · 1 轮         │ ← 会话统计
└───────────────┴──────────────────────────────────────┘
```

新增的构件与它们的**真实数据来源**：

| 构件 | 数据来自 |
| --- | --- |
| 搜索框 | 前端过滤会话标题 / id；命中后切成跨项目平铺结果（找会话时层级是干扰） |
| 标签栏「对话 / 轨迹」 | 同一个 `state.items`，轨迹走 `traceSteps()` 摊平（纯函数） |
| 文件卡片 + 打开 | `fileActionOf()` 认出 read/write/edit 的路径；打开走主进程 `shell.openPath` |
| 权限下拉 | **如实显示现状**：本地 provider 无沙箱无审批，所以只有「完全访问」一项 |
| 模型下拉 | 内核 `ctx.llm.listModels(provider)`（`ready.info.models`），再按**本地清单**过滤 |

##### 模型清单：内核申报 + 本地白名单

适配器（`dsh-llm-deepseek`）申报的目录有 4 款：`deepseek-flash`（V4.1 旧版）、
`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`（实验视觉）。
YuanMy 只对用户暴露**两款主力**，清单定义在 `app/cli/options.ts` 的
`SUPPORTED_MODELS` —— 那里同时是 `--model` 的默认值来源，CLI 与桌面端因此不会漂移。

host 侧（`host/index.ts` 的 `listModels`）的规则：

1. **以本地清单为准过滤 / 排序**，顺序即产品意图（Flash 在前、Pro 在后）；
2. 名称与描述**优先用适配器给的**（它才是权威），缺失才用清单里的兜底名；
3. 读不到目录（离线、适配器不申报）就退回整份本地清单 —— 下拉框依然可用，
   而不是只剩一个当前值；
4. 一款都没匹配上（适配器换了模型族）时**宁可露出真实目录**，也不给空下拉框。

⚠️ 默认模型必须落在清单里，否则下拉框显示不出自己的当前值。
第一版的默认是 `deepseek-flash`，而白名单一过滤就把它删掉了 —— 两处必须一起改。
| 会话统计 | token 来自 `usage` 帧；耗时来自 `turn-end.durationMs`；轮次由归约器计数 |

两处刻意的取舍：

- **权限不做成能选的假开关**。YuanMy 的本地 provider 没有沙箱与审批，
  给一个「只读 / 工作区可写 / 完全访问」的选择器会让人**以为**有沙箱 ——
  假的安全控件比没有控件更糟。所以它只显示「完全访问」并说明怎么换成受限形态。
- **统计里的「耗时」是上一轮的墙钟耗时**，由 host 在回合前后量（`durationMs`），
  不是前端估算；「轮次」是本会话已完成的回合数。

### 视觉体系：炭黑 + 低饱和蓝紫

本版按工作台规格调整了配色（上一版是官方 DSH 的中性近白体系）：

- 底色**炭黑**（`rgb(17,17,19)`，侧栏 `rgb(23,23,26)`），白正文 + 浅灰次要文字；
- **强调色**：低饱和蓝紫 `rgb(126,134,222)`，只用在「活的东西」上 ——
  当前标签下划线、发送按钮、焦点环、链接、运行中状态点、当前会话图标；
- **选中会话是灰色高亮**（不用强调色填充），避免和「当前标签」抢注意力；
- **无多余装饰**：去掉了上一版的运行中扫光动画，运行中只用一个强调色小点 / 文字变色。

#### 当前项高亮：三层轻量信号，而不是一根硬竖条

第一版的当前会话是「贴行边、贯穿整行的 2px 硬竖条 + 文字直接跳到纯白 + 比 hover
深两档的底色」，观感很生硬：竖条看起来像描边，切换时底色又是「跳变」。
现在把「我在这里」拆成三层，每层都很轻，叠起来足够清楚：

| 层 | 做法 | 为什么 |
| --- | --- | --- |
| 形状 | `::before` 画 **2×14px 圆角药丸**，`left: 3px` 内缩、垂直居中 | 短、圆、不贴边 —— 看起来是刻意的标记，不是边框 |
| 字重 | `font-weight: 500` 承担主要强调 | 文字色因此不必从 secondary 直接跳到纯白 |
| 底色 | `bluish-800`（只比 hover 的 850 深一档） | 切换会话时是柔和的淡入，不是闪变 |

底色梯度是设计意图的一部分，**四档都不同**：
侧栏底 `900` < 当前项目 `875` < hover `850` < **当前会话 `800`**。
越靠近「你正在看的那个会话」越亮。当前项目刻意**不用**药丸：它是当前会话的容器，
展开后两行上下相邻，两层都用竖标会像两条重复的边框。

⚠️ 一条容易踩的样式坑：高亮规则的选择器权重高于通用 `:hover`，所以**必须显式补**
`.session--current:hover` 与 `.project-node--current … :hover`，否则当前项悬停没反应、
像「死了」。另外别退回「贴边硬竖条」：那正是被反馈「太生硬」的第一版。

令牌名仍沿用官方的 `--dsw-*`（除了 `--ym-accent*` 这组强调色），
所以官方调色板一变，同步令牌值即可。

### 视觉体系的令牌来源

界面的配色 / 圆角 / 字号 / 动效**不是自己定的**，而是照搬官方 DSH 桌面端（`apps/desktop`
加载的 Web 客户端 UI）那套设计令牌。做法是**沿用官方令牌名**（`--dsw-*`）：
以后官方调色板一变，同步令牌值即可，不用逐个组件找。

| 令牌 / 规格 | 来源 |
| --- | --- |
| 静态色阶 + 语义别名（`bg-base` / `label-*` / `border-l1..l4` / `state-*` / `specific-*`） | `packages/client/ui-theme/src/styles/design-platform.css` |
| 字体栈、动效曲线与时长 | `ui-theme/src/styles/base.css` |
| 滚动条（8px、无边框、两级色） | `ui-theme/src/styles/scrollbar.css` |
| 按钮（sm 28/圆角 14、md 36/圆角 18、主按钮近白填充） | `ui-primitives/src/Button.module.css` |
| 状态点（10% 光晕 + 60% 实心核两层） | `ui-primitives/src/StateDot.module.css` |
| 外壳栅格 + 侧栏 0.5px 发丝描边 | `ui-layout/src/client/AppFrame.module.css` |
| 用户气泡 r22 + `specific-bubble` | `ui-chat/.../MessageItem.module.css` |
| token 统计胶囊（13px / r24 / tabular-nums） | `ui-chat/.../StatsPills.module.css` |
| 工具行与推理行（无边框的「行」+ 运行中扫光） | `ui-chat/.../GenericCommandCard|ReasoningRow.module.css` |
| 内容轴 748px、正文 14px、流间距 16px | 同名 `--dsh-*` 变量 |

几个容易忽略但很定调的点：

- **底色是「bluish neutral」不是纯灰**：`bg-base` = `rgb(21,21,23)`，侧栏 `rgb(27,27,28)`；
- **主按钮是近白填充 + 深色字**（`rgb(249,250,251)` / `rgb(15,17,21)`），这套 UI 的主色不是彩色；
- **描边分四级**（6% / 12% / 16% / 20% 白）且大量用 **0.5px**：层级靠它和背景微差拉，不靠大色块；
- **工具调用与推理是「行」不是「卡片」**：无边框无底色，运行中跑一道 300px 扫光（`dsh-row-sweep`，2.6s）；
- **token 数字用 `tabular-nums`**，跳数时列不会左右抖。

改配色时**不要往组件里写死 hex**：一律走这些令牌，否则主题一改就散架。
注意 `body` 在磨砂玻璃开启时**必须是透明的**（让系统材质透出来），
真正刷底色的是 `.app-shell`。

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

**改这一块时的自查**：展开一段长推理，看外壳（含侧栏）高度是否**没有**超过视口、
滚动条是否出现在 `.messages` 内部而不是整个窗口上。把 `minmax(0, 1fr)` 去掉会立刻
复现老 bug（实测侧栏被拉到 1723px，底部内容顶出可视区）。

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

**改这里时的自查**（用中文输入法真打一次最快）：组字中按回车**不能**发出消息、
组字刚结束那一次回车也**不能**、而普通回车**必须**能发出去。
第三条同样重要 —— 守卫写错会把回车彻底卡死。

---


## 7. 已知限制与下一步

- **不能打包**：目前只有开发态运行。出安装包需要补 `electron-builder` 配置与签名，
  可参考 DSH 的 `apps/desktop`（它的做法是把整个运行时打进 asar）。
- **bundle 偏大（~10 MB）**：见第 1 节的说明与两条瘦身路线（去 code 插件 / 换 `app://` 协议）。
- **只有一个会话窗口**：换会话 = 重启内核。要做多会话需要把 `host` 从「单例」改成
  「按会话 id 管理多个子进程」，协议里再加会话维度。
  （换会话本身带**历史回放**，见「恢复会话」一节；实测重启 + 历史可见 ≈ 300ms。）
- **跨项目列表靠一份「最近打开过」的登记**（不是靠共享会话库）：内核 `stateDir`
  默认 `<cwd>/.YuanMy`，每个项目一份库，所以桌面端维护
  `<userData>/projects.json` 并在启动 host 时把清单交过去，由 host 多扫几个根。
  代价与边界见「项目树为什么能跨项目」一节：项目要**被打开过一次**才会进登记，
  登记最多 20 条、单次最多多扫 8 个根。
- **没有附件 / 图片**：`dsh-attachment-local` 已经在内核里挂好了，
  补一条「把文件路径塞进用户消息」的协议字段就能用起来。
- **代码块没有「复制」按钮与行号**：Streamdown 支持，但需要在
  `markdown.tsx` 里补自定义 renderer。
- **Windows / Linux 未验证**：磨砂玻璃、`titleBarOverlay`、菜单角色都按平台分了支，
  但只在 macOS 上跑过。
  Linux 保留原生标题栏（否则没有关闭按钮），代码块与磨砂玻璃会自动退回不透明样式。
