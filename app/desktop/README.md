# YuanMy Agent 桌面客户端

Electron 外壳。**复用 `app/cli/` 的同一套 DSH 内核装配**，只把「终端渲染」换成「窗口界面」。

```
npm run desktop          # 打开窗口
```

> **客户端全部是 TypeScript**（`app/desktop/**` 下没有手写的 `.js`），但有两条
> 「谁负责擦类型」的分工：
>
> | 文件 | 谁执行 | 说明 |
> | --- | --- | --- |
> | `main.ts` / `ipc.ts` / `host/*.ts` / `cli/*.ts` | Electron 自带的 Node 24 | **默认开类型擦除**，直接跑 `.ts`，不需要构建步骤 |
> | `scripts/*.ts` | 系统 node（≥22.6，本机 24） | 同上；`npm run build:renderer` 直接跑 `.ts` |
> | `preload.ts` | **先构建成 `preload.cjs`**，再由 Electron 加载 | 沙箱化 preload 走 Electron 自己的 CJS 加载器，**不认识 `.ts`** |
> | `renderer/src/*.tsx` | 浏览器（打包成 IIFE） | 由 `<script src>` 加载，不走 Node 模块系统 |
>
> ⚠️ **`preload` 是全项目唯一需要构建的一环，而且不能省**：把 Electron 的
> `webPreferences.preload` 指到 `preload.ts` 会**静默失败**（`window.YuanMy` 不存在，
> 界面只会说「preload 脚本没有加载」，看不出真因）。实测：同一个文件指 `.ts` 时
> `window.probe === null`，指构建出来的 `.cjs` 时正常。
> 另外 **Electron 加载 preload 时会忽略 `"type": "module"`**，一律按 CommonJS 执行
> （官方文档 *ES Modules (ESM) in Electron*：「Preload scripts will ignore
> `type: module` fields」），沙箱化 preload 也不支持 ESM `import` ——
> 所以产物必须是 CJS，由 `scripts/build-renderer.ts` 用 esbuild 打成自包含的
> `preload.cjs`（`electron` 留作外部依赖）。官方 DSH 桌面端也是这个分工
> （`lib/main.js` 走 ESM，preload 是构建出来的 `preload-app.cjs`）。

---

## 目录

| 总览 | 架构 | 界面 | 打包 |
| --- | --- | --- | --- |
| [0. 客户端代码地图](#0-客户端代码地图)<br>[0.1 技术栈与官方文档](#01-技术栈与官方文档)<br>[0.2 自研 vs 成熟组件](#02-自研-vs-成熟组件能不能换) | [1. 三个进程，一条数据流](#1-三个进程一条数据流)<br>[2. 为什么内核跑在子进程里](#2-为什么内核跑在子进程里)<br>[3. IPC 契约](#3-ipc-契约加一个功能要改哪几处)<br>[4. 启动时序](#4-启动时序)<br>[5. 安全基线](#5-安全基线) | [6. 界面是怎么长出来的](#6-界面是怎么长出来的)<br>— 数据流 / 视觉 / 侧栏 / 会话条目<br>— 侧栏背景 / 设置界面 / 恢复会话<br>— 输入框 / 指令 token / 统计 / 布局<br>— 会话刻度尺 / 预览面板 / 轨迹视图 / 输入法 | [7. 打包：Electron Forge](#7-打包electron-forge)<br>[8. 已知限制与下一步](#8-已知限制与下一步) |

---

## 0. 客户端代码地图

`app/desktop/` 下一个手写的 `.js` 都没有，全部是 `.ts` / `.tsx`：

```
app/desktop/
  main.ts                  Electron 主进程：窗口/菜单/生命周期、IPC 收口、子进程生命周期、窗口材质
  ipc.ts                   IPC 频道名 + ShellState / LaunchConfig / ShellEvent（只被主进程引用）
  preload.ts               安全桥源码（唯一需要构建的一环 → preload.cjs，见开头说明）
  host/                    内核宿主**子进程**（与主进程分进程，见第 2 节）
    index.ts               装配内核、收 IPC 请求、推事件
    bridge.ts              DSH 事件 → 界面词表（回合结论的唯一映射点）
    history.ts             会话日志 → Item[]（恢复会话时的回放）
    sessions.ts            工作区/项目/会话清单（跨项目靠 project roots）
    protocol.ts            跨进程词表：HostEvent / HostRequest / HostReadyInfo / isHostEvent
  renderer/
    index.html             唯一页面（CSP + 两个相对路径的产物）
    src/main.tsx           React 入口
    src/app.tsx            外壳布局、标签栏、滚动策略
    src/use-agent.ts       唯一的 reducer：事件 → 界面状态（**按会话分视图**）；所有动作（send/steer/attach/…）
    src/composition.ts     输入法（IME）组字守卫
    src/icons.tsx          lucide-react 的包装层（尺寸 16 / 线宽 1.75 / `Icon*` 命名收敛）
    src/components/        界面组件（每个文件一个关注点）
      sidebar.tsx          项目→会话的树、搜索、底栏状态
      sidebar-cylinder.ts  侧栏柱面粒子：**纯模拟**（可注入随机源，能 Node 里推演）
      sidebar-backdrop.tsx 侧栏粒子的 canvas 那半边（rAF/DPR/暂停/颜色）
      composer.tsx         输入区 + 触发符菜单接线 + 键盘总闸
      mention-menu.tsx     触发符候选（纯逻辑 + 列表 UI）
      menu.tsx             通用浮层菜单（键盘 / ARIA / 点外关掉；输入框三个下拉共用）
    src/ui/beautifului/    界面底座（vendored，MIT）：foundation.css + atoms/ + primitives/
      ../tool-names.ts     工具 → 中文功能名 / 说明（纯表 + 兜底规则；`@` 菜单用）
      editor/              Tiptap：chip 节点、文档↔文本、触发符规则、suggestion 插件、扩展集
      message.tsx          一条会话条目（用户/助手/提示/纠偏；带 data-item-id）
      tool-run.tsx         一段连续工具调用（ToolChips 的数据装配 + chip 点开预览）
      trace.tsx            轨迹视图：按圆点分状态的时间线（可折叠长步骤）
      message-rail.tsx     右侧会话刻度尺（等距短横线 + 白色长横条 + 滚轮/点击/拖动）
      message-rail-model.ts 上面那把尺子的**纯逻辑**（indexAt / rulerShift，可 Node 里跑）
      preview-panel.tsx    右侧预览面板（报告 / 代码 / 图片 / 文本 / 最近文件）
      markdown.tsx         Streamdown 封装（助手正文）
      rich-text.tsx        纯文本染色组件（用户消息/工具参数/轨迹）
      rich-text-tokens.ts  上面那个的**纯逻辑**（tokenizer）
      settings-panel.tsx   技能/命令/MCP 的查看编辑模态
  scripts/
    audit-css.ts           样式审计：HEAD 有、现在缺、但仍被 className 引用的类 = 误删
    build-renderer.ts      构建渲染进程（esbuild + PostCSS/Tailwind）+ 打 preload.cjs
    build-app.ts           打包用的 staging（生产依赖 hoisted + 运行时文件）
  forge.config.ts          Electron Forge 配置（asar.unpack / makers / fuses）
```

**不在 `app/desktop/` 但属于客户端的东西**：`app/cli/`（内核装配，桌面端与终端共用）、
`app/mcp/butian/`（内置 MCP 服务器，由 host 子进程按相对路径拉起）。

**这一轮清理掉的**（都确认过没人引用）：`components/top-bar.tsx`（整份文件 —— 标签栏早就
内联进 `app.tsx` 了）、`icons.tsx` 的 `IconFolder`、`rich-text.tsx` 里没人 import 的再导出、
`sidebar-cylinder.ts` 里只服务于临时脚本的两个统计函数、`protocol.ts` 的 `HostLaunchConfig`
与 `isHostEvent`（后者写 TS 时又**真的需要**了，于是带着真实调用点回来了）、CSS 里 7 条
`.tokenbar*`（旧版统计条）与 `.sidebar__label*` / `.project-tree` / `.project__path` / `.stack`
（旧侧栏结构）以及没人用的 `--ds-transition-duration-slow`。

**再清理掉的一批**（同样逐个查过引用）：`atoms/StreamText.tsx`（整份 —— 上游的流式文字
构件没接进界面）、`icons.tsx` 里「轨迹按角色分色」时代的 8 个图标（`IconUser` / `IconReasoning`
/ `IconReply` / `IconTool` / `IconBug` / `IconNote` / `IconShell` / `IconGoal`，轨迹改成圆点配
色后就没有宿主了）、`options.ts` 的 `isSupportedModel`、`mcp-config.ts` 的 `serializeMcpConfig`、
`Button.tsx` 的 `ButtonVariant` 类型、`menu.tsx` 没人传的 `triggerClassName` / `className`；
CSS 侧删掉 `.topbar__title`、`.btn--primary` / `.btn--stop`（连同只为它们存在的
`--dsw-alias-button-primary-fill` / `-hover` 两支令牌）、`.preview__pre`（纯文本预览改走
`CodeBlock` 后失效）、`.msg__meta .shimmer`（`Shimmer` 用的是内联渐变，`shimmer` 这个类名
从来没落到元素上），以及 `foundation.css` 里所有**没有落盘构件**的 COMPONENT-SPECIFIC 块
（StreamingText / FilterTable / InsightCards / RecordsTable / component nav / `primitive-*`
间距 / `theme-switching` / `.home-reveal` / `eq-bounce`）—— 见 vendored README 的改动表。

> 唯一保留的 `.js` 是 `app/opencli/**`：opencli 只发现 `~/.opencli/clis/<site>/<命令>.js`，
> **不认 `.ts`**（见 `app/opencli/README.md`），所以它们的归属单独放在 `tsconfig.js.json`。

---

## 0.1 技术栈与官方文档

**只列真正在用的**（`package.json` 里挂着但没被 import 的不算）。改这些子系统之前，
先看对应的官方文档 —— 本仓库的注释只写「为什么这么用」，不重复 API。

### 壳与打包

| 组件 | 用在哪 | 官方文档 |
| --- | --- | --- |
| Electron 44 | 整个壳（`main.ts` / `preload.ts`） | https://www.electronjs.org/docs/latest/ |
| Electron Forge 7 | 打包（`forge.config.ts`、`npm run package/make`） | https://www.electronforge.io/ |
| └ 导入已有项目 | 本仓库的接入方式 | https://www.electronforge.io/import-existing-project |
| └ Makers（zip/dmg） | `out/make/**` | https://www.electronforge.io/config/makers |
| └ Fuses 插件 | `RunAsNode` 必须为 true（内核子进程靠它） | https://www.electronforge.io/config/plugins/fuses |
| @electron/fuses | 上面那个插件背后 | https://github.com/electron/fuses |
| Electron Fuses 概念 | 「为什么 RunAsNode 不能关」 | https://www.electronjs.org/docs/latest/tutorial/fuses |

### 界面

| 组件 | 用在哪 | 官方文档 |
| --- | --- | --- |
| React 19 | 全部组件；reducer 在 `use-agent.ts` | https://react.dev/ |
| └ `useReducer` | 事件 → 状态的那一个 reducer | https://react.dev/reference/react/useReducer |
| Tailwind CSS v4 | **只给 Streamdown 用**（自己的组件写语义类） | https://tailwindcss.com/docs |
| Streamdown | 助手正文的 Markdown 渲染（`markdown.tsx`） | https://streamdown.ai/ |
| └ `@streamdown/code` / `cjk` | 代码高亮（Shiki）/ 中文排版 | https://shiki.style/ |

### 输入框（编辑器）

| 组件 | 用在哪 | 官方文档 |
| --- | --- | --- |
| Tiptap 3 | 输入框（`components/editor/*`） | https://tiptap.dev/docs |
| └ Suggestion 工具 | `/` `@` `#` 的触发与匹配 | https://tiptap.dev/docs/editor/api/utilities/suggestion |
| └ Placeholder | 空输入框的提示语 | https://tiptap.dev/docs/editor/extensions/functionality/placeholder |
| └ 自定义节点 | chip（`editor/chip.ts`） | https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node |
| ProseMirror | Tiptap 之下的模型/视图；`someProp` 顺序、DOM 输出 | https://prosemirror.net/docs/ref/ |
| └ 与 Tiptap 的关系 | 「什么时候要直接读 PM 文档」 | https://tiptap.dev/docs/editor/core-concepts/prosemirror |

### 内核（host 子进程侧）

| 组件 | 用在哪 | 官方文档 |
| --- | --- | --- |
| DeepSeek Harness（DSH） | 内核本身（40+ 个 `@deepseek-ai/dsh-*` 包） | https://www.npmjs.com/package/@deepseek-ai/dsh-agent |
| Cordis | DSH 的插件/服务容器（`kernel.ts` 里 mount 的就是它） | https://github.com/shigma/cordis |
| MCP TypeScript SDK | `app/mcp/butian/`、外挂 MCP 客户端 | https://github.com/modelcontextprotocol/typescript-sdk |
| Zod | MCP 工具入参校验 | https://zod.dev/ |
| node-pty | 终端型子进程（`dsh-subprocess-local` 带进来） | https://github.com/microsoft/node-pty |
| koffi | Windows 上的原生调用（同一批依赖带进来） | https://koffi.dev/ |

### 构建与依赖

| 组件 | 用在哪 | 官方文档 |
| --- | --- | --- |
| esbuild | 渲染进程打包 + `preload.cjs` | https://esbuild.github.io/api/ |
| PostCSS | 接 Tailwind v4 的 CSS 管线 | https://postcss.org/ |
| TypeScript | 三个 tsconfig（见根 README） | https://www.typescriptlang.org/docs/ |
| pnpm | 依赖管理（打包那节解释为什么要 hoisted） | https://pnpm.io/ |

---

## 0.2 自研 vs 成熟组件：能不能换

「这段手写代码有没有现成的成熟组件可以替」——逐个过了一遍。结论分三档：
**换**（明显划算）、**可换**（有得有失，看后续需求）、**不换**（换掉更糟）。

### 换（建议做，风险小）

| 自研 | 现成方案 | 为什么值得换 |
| --- | --- | --- |
| `settings-panel.tsx` 的模态 | [`@radix-ui/react-dialog`](https://www.radix-ui.com/primitives/docs/components/dialog) | 手写的模态只做了「点击遮罩关闭」。**焦点陷阱、`aria-modal`、Esc 语义、打开时锁定背景滚动、关闭后把焦点还回去**这些都要自己补 —— 现在一个都没有。Radix 是 headless 的（样式还是我们的 CSS），加一个依赖换一整套可访问性 |
| `composer.tsx` 里的 `Dropdown` → 已抽成 `components/menu.tsx` | [`@radix-ui/react-dropdown-menu`](https://www.radix-ui.com/primitives/docs/components/dropdown-menu) 或 [`@floating-ui/react`](https://floating-ui.com/docs/react) | **本轮已经把缺的补齐**（方向键 / Home / End、`role=menu` + `aria-haspopup/expanded`、Esc 关闭并把焦点还回触发器、点外面关掉、向上向下弹、限高滚动），并且输入框三个下拉共用（`+` / 权限 / 模型）。仍建议后续换 Radix：能省掉翻页/子菜单/碰撞翻转这些还没做的部分；但**输入框里的 `@` 候选菜单不能换**（它必须由编辑器持有焦点与按键，见下方那条） |

### 可换（有得有失）

| 自研 | 现成方案 | 权衡 |
| --- | --- | --- |
| `sidebar-backdrop.tsx` 里的 rAF/可见性/媒体查询 | [`usehooks-ts`](https://usehooks-ts.com/)（`useDocumentVisibility` / `useMediaQuery` / `useResizeObserver` / `useInterval`） | 能省 ~40 行样板。不换的理由：这几个 hook 加起来不到 50 行，而且里面两处是**为这个场景特意调的**（每帧不读布局、`dt` 夹上限），用通用 hook 反而要再包一层 |
| `host/protocol.ts` 的手写类型 + `isHostEvent` | [Zod](https://zod.dev/) schema（**已经在依赖里**，MCP 用的就是它） | 跨进程边界（子进程帧、渲染进程请求）用 schema 校验比手写判断更稳，还能顺便得到类型。代价：协议词表要写成 schema，读起来不如类型别名直观。建议**只换边界上的两处**，纯类型别名保留 |
| `scripts/build-renderer.ts`（esbuild + PostCSS + Tailwind 手写管线） | [`@electron-forge/plugin-vite`](https://www.electronforge.io/config/plugins/vite) | 官方路径、自带 HMR、少维护一份脚本。不换的理由：脚本才 120 行、一次构建 0.3s，而且已经踩平了两个坑（`file://` 下必须 IIFE、Tailwind 扫 pnpm 符号链接要 `realpath`）。换成 Vite 要重新解决这两件事 |
| ~~`icons.tsx` 的 12 个手写 SVG~~ | [`lucide-react`](https://lucide.dev/) | **已经换掉了**（图标从 12 个涨到 30+ 时换的）：`icons.tsx` 现在只是包装层，统一尺寸 16 / 线宽 1.75 / 保留 `Icon*` 命名，组件侧一行没改。按需具名 import，Tree-shaking 后只进用到的那些 |

### 不换（换掉更糟）

| 自研 | 「看起来像」的现成方案 | 为什么不换 |
| --- | --- | --- |
| `composition.ts` 输入法守卫 | 各种 `is-composing` 小包 | 它们给的是一个布尔标记；这里要的是**三个信号**（`isComposing` / `keyCode 229` / `compositionend` 后同宏任务的临时标记），每一条都有实测原因（见第 6 节）。而且 Tiptap 那条路还要额外判 `view.composing`（合成 Enter），现成包都不覆盖 |
| `rich-text-tokens.ts` 指令染色 | `linkify-it` / `linkifyjs` | 它们只认 URL；这里认的是**项目自己的词表**（`/命令`、`mcp__*`、技能句式、路径启发式），而且判据要与输入框的触发符规则**共用同一份** |
| `sidebar-cylinder.ts` 柱面粒子 | `tsParticles` / `particles.js` / `three.js` | 粒子库都是「发射器 + 生命周期」模型，做不出「整段柱面按角度投影、切成网格、随鼓面滚动」这种**几何驱动**的效果。引 three.js 能画，但为了一层背景多 600KB 与一整套 3D 概念不划算 |
| `mention-menu.tsx` 的候选列表 | `cmdk` / `downshift` | 触发匹配与键盘（↑↓/Enter/Tab/Esc）**已经由 Tiptap 的 suggestion 插件负责**，菜单只是一个列表。引入 combobox 库会和编辑器抢焦点与按键，反而要写更多胶水 |
| `use-agent.ts` 的 reducer | `zustand` / `jotai` / Redux | 状态只有「一条事件流 → 一棵状态树」，`useReducer` 是 React 原生解法；换状态库只增加概念，不减少代码 |
| `message.tsx` / `tool-run.tsx` / `trace.tsx` | 无 | 它们是**这个产品的语义**（回合、工具调用 run、轨迹），没有通用组件可替 |
| `message-rail.tsx` 会话刻度尺 | 没有对口货（`react-scrollspy` / `rc-slider` / 各种 minimap） | scrollspy 只给「当前在哪一节」，不给「点刻度跳过去 + 尺子自己滑」；`rc-slider` 是**表单控件**（取值 0~100），语义完全不对。这里要的是「一把可滚动的尺子」，几何与选中规则都是自己的 |
| `main.ts` 的窗口材质 / 菜单 / 单实例 | 无 | 都是 Electron 原生 API 的直接用法，没有中间层可省 |

> 一句话：**越靠近「协议与几何」的自研越该留，越靠近「通用交互外壳」的自研越该换。**
> 上面第一档（两个 Radix 组件）是性价比最高的两步。

---

## 1. 三个进程，一条数据流

```
┌──────────────────────── Electron 主进程 (main.ts) ────────────────────────┐
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
| `main.ts` | JS（ESM） | Electron 主进程：窗口、菜单、生命周期、IPC 收口、**多 host 槽位**（一会话一进程）、窗口材质 |
| `preload.cjs` | JS（**CommonJS**） | 安全桥：把一组函数挂到 `window.YuanMy`，此外什么都不暴露 |
| `ipc.ts` | JS（ESM） | IPC 频道名 + shell 状态形状（只被主进程引用） |
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
- **`preload.cjs` 必须是 JS**：沙箱化 preload 的 `require` 只认 `electron`，
  更没有 TypeScript 加载能力，所以它只能是一段自包含的 CommonJS。
- **`main.ts` 保持 JS**：Electron 主进程直接执行它，而 Electron 自带 Node 不保证
  开启类型擦除，`.ts` 不一定能跑。想改造的话得先引入构建步骤（或确认目标
  Electron 版本的 Node 支持 `--experimental-strip-types`）。

类型检查分两个项目跑：

```bash
npm run typecheck    # tsc --noEmit（Node 侧） && tsc --noEmit -p app/desktop/renderer/tsconfig.json
```

### 渲染进程为什么需要构建

Markdown 用 [Streamdown](https://streamdown.ai/)（React 组件）渲染，它需要 React 运行时
和 Tailwind 生成的样式；浏览器跑不了 JSX，`file://` 下也没有裸包名解析。
所以 `scripts/build-renderer.ts` 用 esbuild + PostCSS 把它们**打成两个文件**：

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

渲染进程能做的事，全部由 `preload.cjs` 的 `api` 对象定义。加一个动作的完整链路：

1. `ipc.ts`：往 `IPC` 表里加频道名（例如 `theme: 'YuanMy:theme'`）；
2. `main.ts`：加 `ipcMain.handle(IPC.theme, (event) => { assertSender(event); … })`；
3. `preload.cjs`：在 `CHANNEL` 与 `api` 里各加一条（**沙箱化 preload 不能 require 本地文件，
   所以频道字面量必须重复一份**）；
4. `renderer/src/` 里调用 `api.theme(...)`（组件或 `use-agent.ts`）。

第 3 步的两处重复是最容易出错的地方：`ipc.ts` 与 `preload.cjs` 的频道名必须逐字一致，
渲染进程能调的方法必须在 preload 里都暴露出来。**加界面动作时对着这两份表逐个核对。**

想让界面显示一种**新的内核事件**，则是另一条链路：

1. `host/protocol.ts`：往 `HostEvent` 联合类型加一个分支（顺便更新 `isHostEvent`）；
2. `host/bridge.ts`：在对应事件里 `this.send({ type: '...' })`；
3. `renderer/src/use-agent.ts`：在归约器的 `switch` 里加 `case`，再到 `components/message.tsx` 里决定怎么渲染。

渲染进程里 `case` 的事件类型必须来自 `host/protocol.ts` 的 `HostEvent`，
或者是 `ipc.ts` 里 `ShellEvent` 那两个（主进程自己产生的事件）。

---

## 4. 启动时序

```
main.ts: app.whenReady().then(onReady)      ← 注意：不是顶层 await，见下
  ├─ registerIpc()          先装 handler，避免界面抢跑
  ├─ buildMenu()
  ├─ createWindow()         窗口立刻显示（先出界面，不空等）
  └─ attach(config)         spawn host → host 发 ready → 状态置为 ready
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

所以 `main.ts` 把所有「需要 ready」的工作放进 `onReady()`，用 `.then()` 注册；
事件监听（`window-all-closed` / `activate` / `before-quit`）则同步注册，它们不需要等 ready。
注意这**不是**「顶层 await 不能用」—— `host/index.ts` 就大量用了顶层 await，
它跑在普通 Node 进程里，没有这个限制。

界面用 `getState()` + `onEvent()` **两条腿**拿状态：先订阅事件再拉一次快照，
这样无论内核是在界面订阅之前还是之后就绪，都不会漏掉 `ready`。

---

## 5. 安全基线

| 措施 | 位置 | 作用 |
| --- | --- | --- |
| `contextIsolation: true` | `main.ts` | 网页脚本与 preload 处于不同 JS 世界 |
| `nodeIntegration: false` | `main.ts` | 网页拿不到 `require` / `process` |
| `sandbox: true` | `main.ts` | preload 也在沙箱里，只能 `require('electron')` |
| `contextBridge` 白名单 | `preload.cjs` | 网页只能看到 9 个函数，看不到 Electron 对象 |
| CSP `script-src 'self'` | `renderer/index.html` | 界面不加载任何远程脚本 |
| Streamdown 内置净化 | `streamdown` 依赖 | Markdown 走 `rehype-harden` + `rehype-sanitize` 后再渲染 |
| 链接只当按钮 | `markdown.tsx` | Streamdown 把链接渲染成 `<button>`，点击经 `window.open` → 主进程转系统浏览器 |
| `assertSender` | `main.ts` | 每个 handler 校验调用方是不是本窗口 |
| `setWindowOpenHandler` | `main.ts` | 新窗口一律拒绝，http(s) 交给系统浏览器 |

> CSP 里 `style-src` 带 `'unsafe-inline'`：Streamdown / shiki 会在运行时注入 `<style>`
> （代码高亮主题）。样式注入不构成脚本执行风险，而 `script-src` 依然是收紧的。

---

## 5.5 界面底座：Beautiful UI（vendored）

界面构件来自 [Beautiful UI](https://www.beautifului.dev/)（作者 Shane Levine，
**MIT License, Copyright (c) 2026 Shane Levine**）。它走的是 shadcn registry
（`https://www.beautifului.dev/r/<名字>.json`），**不是 npm 包**，所以源码是
**vendored** 进仓库的：`renderer/src/ui/beautifului/`（含它自己的 README，写清了来源、
改动与升级方式）。

为什么能直接用：它只 import `react` + 几个小库（`class-variance-authority` / `clsx` /
`tailwind-merge` / `shadow-plugin`…），**没有任何 Next.js 依赖**；类名是 Tailwind v4 的，
和我们 `styles/app.css` 的 `@import "tailwindcss"` + `@theme` 路线同一套。

接入方式（三步）：

1. `styles/app.css` 在 `@import "tailwindcss"` 之后 `@import "../src/ui/beautifului/foundation.css"`；
2. `index.html` 的 `<html>` 写死 `class="dark"` —— foundation 用 `.dark` 开关它那套暗色令牌，
   YuanMy 只有暗色一套，不做主题切换；
3. `--font-inter` / `--font-mono-face` 指到项目现有两套字体（上游靠 Next.js 的 `next/font` 注入）。

### 哪些上游构件没法直接用（记录取舍）

| 构件 | 为什么没直接嵌 | 我们怎么办 |
| --- | --- | --- |
| `PromptBar`（712 行） | 它是**展示件**：自带 `<textarea>`、自播放 walkthrough（`demo`）、`glimm` 的 WebGL 扫光、Figma/Slack/Gmail 品牌标；嵌进来就得放弃 Tiptap（被明确要求保留） | 取它的**字段样式**（`border-line` + `bg-surface` + `shadow-card` + 14px 圆角 + `focus-within:border-line-strong`）套在我们的 `.composer__box` 上 |
| `ChatComposer` | 它是「消息列表 + 输入框」的整块演示（`ChatMessage` 是 demo 数据） | 只用它的视觉语言；消息流仍走我们的归约器与 Streamdown |
| `SidebarNav` | 它是固定主导航（Home/Invite/Settings）+ **扁平** recents；我们的侧栏是「项目 → 会话」两级树（跨项目、可折叠、懒加载） | 取它的侧栏外观与交互（搜索字段、行样式、折叠态），树的结构与逻辑保留（阶段 4） |
| `ToolChips` | 可复用，但内建**演示时序**（定时逐条放行、固定最小高、自动展开） | vendored 补丁加 `live` / `compact` / `preview`，真实数据驱动（见 vendored README 改动表） |
| `ThinkingState` | 补不动了：宽度写死 380px、行 key 用文本本身（流式时每个 delta 重建元素，`fade-up` 从 opacity 0 重播 → 整块看着是**空白**，也就是「没有流式输出」的真相）、整段推理挤成一行 | **自研** `components/reasoning.tsx`：吃满内容区、流式限高 132px 并自动滚到底、结束自动收起成一行「思考了 N 字」、点开看全文；上游那份已删除 |

### ⚠️ 一次自己造成的样式事故（以及为什么现在有 `npm run audit:css`）

删「轨迹时间线」那批死样式时，我按**区间**删（从轨迹分节注释到下一个分节注释为止），
而那一大段里夹着**下拉菜单、提及菜单、统计行、纠偏气泡、指令 token、输入框 chip** 的样式 ——
它们的类名都还在 TSX 里，属于活样式。删完编译不报错、类型检查也过，只有真看界面才发现。

现在这件事有两道防线：

1. **审计脚本**：`npm run audit:css` 拿「上一个提交的 CSS 选择器集合」与当前 CSS 做差集，
   再回到 `renderer/src` 里逐个验证「还有没有 className 在用」——有就是误删，退出码 1。
   （本次修复后它报「363 条选择器、缺 62 条、其中没有仍被引用的」，那 62 条正是故意删掉的
   `tool-card` / `filecard` / `reasoning` / 轨迹时间线 / `setbtn` 等。）
2. **删样式只按选择器删**，不要按行区间删；删完跑一次审计脚本再继续。

误删的那批已从 `git show HEAD:...` 按选择器取回，并把能迁移的旧令牌换成 foundation 令牌
（`app.css` 第 14 节「恢复」有说明）。

### 三处必须知道的坑

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| 上游 `foundation.css` **括号不配平**（84 左 vs 85 右） | Tailwind 解析到那里**整份 foundation 被丢掉且不报错** —— 表现是「令牌与工具类全没了、界面像没上样式」 | vendored 时删掉那段孤儿块（`.records-footer-hint` + 多余右花括号），RecordsTable 自己的 CSS 里有这条规则 |
| `--color-accent` **撞名**：上游当品牌色，Streamdown（shadcn 主题）当 hover 底色 | `bg-accent` 主按钮渲染成灰色 | 全局给品牌语义（`--color-accent: var(--accent)`），Streamdown 那份收进 `.sd { --color-accent: … }` |
| 上游原子构件**不透传原生属性** | `title` / `aria-*` 传不进去（我们到处用 tooltip） | vendored 时给根元素加 `...props`（已在 README 的改动表里登记） |

品牌色沿用 YuanMy 那支低饱和蓝紫（`--accent: oklch(0.62 0.16 285.5)` 一族），
只换色相、不动它的阴影/描边/圆角结构 —— 这是设计系统留的口子。

**历史令牌的过渡办法**：界面里还留着大量早期自研的 `--ym-*` / `--dsw-*` 变量，
逐个替换既慢又容易漏。凡是**语义重合**的，在 `:root` 里就地改成 foundation 的别名：

```css
--ym-accent: var(--accent);            /* 品牌色一族：一处改色全站跟上 */
--ym-accent-text: var(--accent-ink);
--ym-nav-current-fill: var(--hover);   /* 侧栏当前项 → 他们的 hover / hover-2 */
--ym-surface: color-mix(in srgb, var(--ink) 55%, transparent);   /* 柱面粒子 */
```

于是「换设计系统」这件事在样式层是**逐块推进**的：改过的块直接写 foundation 令牌，
没轮到的块通过别名自动跟着走，不会出现「一半旧色一半新色」的断层。
（阶段 7 收尾时再决定哪些 `--dsw-*` 可以彻底删掉 —— 玻璃侧栏与柱面粒子还要用其中的
几支静态色阶。）

### 迁移分阶段（未完成的记在这里）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | foundation 令牌 + 字体 + 暗色开关；`lib/utils.ts`（`cn`）+ atoms 落盘 | ✅ |
| 1 | 原生构件替换：`Button`（发送/停止/设置/预览按钮）、`ValuePill`（统计行）、`EntityChip`（项目/会话徽标）、`Shimmer`（运行中） | 🔄 已接 Button + ValuePill |
| 2 | 对话面板：~~`ThinkingState`（推理）~~ → 改为自绘 `components/reasoning.tsx`（吃满宽度、流式限高、结束自动收起，见 §6）、`ToolChips`（工具调用 run，行内明细 + chip 点开预览）；`tool-card.tsx` / `file-card.tsx` 与它们的 CSS 已删 | ✅ |
| 2b | `CodeBlock`：预览面板的**纯文本 / 日志**已接入（行号 + 文件名头 + 一键复制）；工具结果暂仍在 ToolChips 行内（要全文去预览面板） | 🔄 |
| 3 | 输入区与浮层：输入框外壳照 `PromptBar` 的字段样式（`border-line` / `bg-surface` / `shadow-card` / 14px 圆角 / 聚焦转 `line-strong`），编辑内核仍是 Tiptap；三个下拉与 `@` `/` 候选菜单统一到 `surface + line + 10px + shadow-raised`，触发按钮直接用他们 `Button` 的 `quiet/xs` 变体 | ✅ |
| 4 | 侧栏：取 `SidebarNav` 的观感（品牌行 14px/ink-2、新会话 = 它的 CTA 规格、搜索字段 `bg-field` + `shadow-hairline`、行高亮 7px/`hover-2`、当前项 `hover`/`ink`、计数 tabular-nums、状态点用 `--green/--red`）+ 项目行首字母圆牌（`Monogram`）；**树的结构与逻辑保留**（它是扁平的 recents，装不下两级树）。柱面粒子背景保留 | ✅ |
| 5 | 右侧：预览面板换成 foundation 层级（面板底 = `--canvas`、描边 `--line`、角标 = `accent-tint/accent-ink`、列表行 7px + `hover-2`、头部按钮改用他们的 `Button`）+ 新增「复制全文」；纯文本 / 日志走 `CodeBlock`（代码与报告仍 Streamdown）；刻度尺换成 `--accent / --ink-2 / --orange / --green` 分类色、当前刻度 = `--ink`、提示框 = `surface + line + raised` | ✅ |
| 6 | 轨迹页：**自绘时间线**（行 = 一步，状态用 6px 圆点的颜色表完成/进行中/失败，可展开完整明细）。~~先用上游 `TaskRows`~~ —— 它的绿勾徽章 / 绿药丸 / 44px 卡片行是 TODO 清单的语汇，与消息流格式对不上，已被用户否掉并删除该文件；设置面板按 foundation 令牌重写（模态 + 页签 + 行 + 编辑器 + 标签），按钮改用他们的 `Button` | ✅ |
| 7 | 收尾：`Shimmer`（生成中/运行中的文字）、`EntityChip`（搜索结果里的项目）、`LoadingState`（冷启动的「正在启动内核」）；清理 13 个确认无人引用的变量；新增 `npm run audit:css`；打包验证（`npm run package` 产物实测启动正常） | ✅ |

**迁移已完成。** 现在这套界面的分工是：

| 层 | 来自 |
| --- | --- |
| 设计令牌（颜色/描边/圆角/阴影/字体/关键帧） | Beautiful UI `foundation.css`（vendored）+ 我们对 `--accent` 一族的品牌色覆盖 |
| 原生构件 | `atoms/`：`Button` / `EntityChip`(+`Monogram`) / `ValuePill` / `Shimmer` |
| 区块构件 | `primitives/`：`ToolChips`（工具 run）/ `CodeBlock`（文本预览与日志）/ `LoadingState`（冷启动） |
| 继续自研 | 思考块（`reasoning.tsx`）、轨迹时间线（`trace.tsx`）（这两处上游的 `ThinkingState` / `TaskRows` 都已删除）、会话刻度尺、通用浮层菜单（`menu.tsx`）、侧栏柱面粒子背景、`MessageRail` 的几何 |
| 明确不换 | Tiptap 编辑器内核、Streamdown markdown 渲染 |

验证入口：`npm run typecheck`、`npm run build:renderer`、`npm run audit:css`、
`npm run package`（打包产物实测：桥 18 个方法、`html.dark`、`--surface/--ink/--accent` 都在、
玻璃侧栏与输入框 14px 圆角照旧）。

**不换的两样**（用户明确要求）：Tiptap 编辑器内核、Streamdown markdown 渲染 ——
只换它们外面的壳。**上游没有对应物、继续自研**的：右侧会话刻度尺、通用浮层菜单
（`menu.tsx`）、侧栏柱面粒子背景。

## 5.6 应用图标（logo）

图标是 `app/desktop/assets/` 下的三份文件，同一张图的三种用途 —— 但**尺寸规范分两档**，
别拿一份去顶另一份：

| 文件 | 用途 | 尺寸规范 |
| --- | --- | --- |
| `logo.png`（128²） | 侧栏品牌行那枚方片，构建时由 esbuild 内联成 data URL（`loader: { '.png': 'dataurl' }`） | **铺满画布**，CSS 画成 16px 方片、圆角 4px |
| `icon.png`（1024²） | 开发态 macOS Dock 图标（`app.dock.setIcon`，仅 `!app.isPackaged`）、Windows/Linux 的窗口图标（`BrowserWindow.icon`） | **Apple 图标网格**，见下 |
| `icon.icns` | 打包产物：`forge.config.ts` 的 `packagerConfig.icon` 指向 `assets/icon`，`build-app.ts` 把整个 `assets/` 复制进 staging | 同 `icon.png` |

来源：`~/.YuanMy/ip-as-logo/<日期>-ghost/B1.jpg`（ip-as-logo 技能出的「圆头小幽灵」方片，
白 + 淡紫、浅底）。派生脚本：`python3 app/desktop/scripts/make-icons.py`
（要 Pillow，**不参与每次构建**，换图时才跑；源图可用 `YUANMY_ICON_SRC=<路径>` 覆盖）。

### 两档尺寸规范，别搞混

**系统图标要按 Apple 的网格留白。** 画布 1024²，方片本体只有 **824² 居中**（80.47%），
本体圆角取自身的 **22.45%**（824 → 185），本体外面**透明**。
`macOS` 上所有 App 图标都是这个留白比例；铺满画布的图标在 Dock 里会比邻居「胖一圈」，
一眼就不像系统应用。注意透明的只是**方片外面** —— 方片本体仍是不透明的浅紫底，
别把背景抠掉（那样图案会在浅色桌面上「浮」着）。实测：`icon.png` 的不透明 bbox
正好是 `100,100 → 923,923`，四角 alpha = 0。

**侧栏 logo 反过来，要铺满画布。** 它是界面里 16px 的一个「表面」，尺寸和圆角由 CSS
（`.sidebar__logo { width:16px; height:16px; border-radius:4px }`）决定；图里再留白的话，
16px 盒子里实际图案只剩 ~13px，和旁边的 13px 标题、项目行的 `Monogram`（`size-4` = 16px）
都对不齐。

### 两个静默失效点（都踩过）

1. **`packagerConfig.icon` 必须给绝对路径**。`@electron/packager` 的
   `normalizeIconExtension()` 把 `icon` 原样交给 `fs.pathExists`，相对路径是按**进程 cwd**
   （仓库根）解析的 —— 写 `'assets/icon'` 它会去找 `<仓库根>/assets/icon.icns`，
   找不到就**静默回落成 Electron 默认图标**：打包一路 ✔，只有 Dock 上图标不对。
   现在用 `fileURLToPath(new URL('./assets/icon', import.meta.url))`，staging 与开发目录都成立。
2. **图标要进 staging 的自检清单**。`build-app.ts` 的 `mustHave` 里加了 `assets/icon.icns` ——
   否则哪天复制规则一改，产物又悄悄变回默认图标。

> 拷进 `.app` 后文件名仍是 `electron.icns`（packager 的 `CFBundleIconFile` 默认值就是它），
> 但**内容是我们的 icns**（sha256 与 `app/desktop/assets/icon.icns` 一致），
> plist 指向的也是这个文件，所以 Dock / Finder 显示的是我们的图标。

## 6. 界面是怎么长出来的

### 数据流：事件 → 归约器 → 组件

`renderer/src/use-agent.ts` 是**唯一**把 host 事件翻译成 UI 数据的地方，
它是一个纯函数归约器（所以能在 Node 里直接回放测试）。产出的一条会话由若干条目组成：

```
{ kind: 'user',      text }
{ kind: 'note',      level, text }                  系统提示
{ kind: 'assistant', turnId, reasoning, blocks[], meta }
```

助手条目的 `blocks` 里现在有**三种**块：`reasoning`（一段思考）、`text`（正文）、`tool`（工具调用）。
推理按位置排在 blocks 里，所以「思考 → 动作 → 再思考」是照着真实顺序画的；
`item.reasoning` 只是整回合推理的拼接，**渲染不要用它**（用就会把所有思考堆回消息最上方）。

助手条目的 `blocks` 是**有序**的，于是「先说话 → 调工具 → 再说话」被如实还原：

```
blocks: [ {type:'text', text:'我先看目录。'}
          {type:'tool', callId, name, args, result, isError}
          {type:'text', text:'这是一个 Electron 壳。'} ]
```

| 事件 | 归约结果 |
| --- | --- |
| `ready` | 状态置 ready，侧栏拿到模型 / 会话 / 目录 / 凭据 / 工具 |
| `restarting` | 给**那个会话的视图**打 `switching` 标记（内容留着，等 `history` 整段替换） |
| `text-delta` | 追加到**最后一个** text 块；上一个动作是工具就新起一块 |
| `reasoning-delta` | 追加到 `blocks` 末尾的**推理块**（末尾不是推理块就新起一块 → 「想一段 → 做一步 → 再想一段」按真实位置排布）；同时拼进 `reasoning`（只给刻度尺摘要用） |
| `tool-call` | push 一个 `tool` 块（`result: null` = 运行中） |
| `tool-result` | 按 `callId` 回填 `result`（一行摘要）与 `output`（**完整输出**，上限 `TOOL_OUTPUT_LIMIT`）；找不到对应调用就补一张卡片，不丢信息 |
| `turn-end` | 写 `meta`（结论 + 工具次数），解除忙碌 |
| `notice` / `fatal` / `host-error` | 追加系统提示；致命错误把状态切成不可用 |
| `workspace` | 刷新侧栏的项目 / 会话清单（就绪后、每轮结束、以及界面主动请求时各来一次） |
| `usage` | 累加 token 计量（每个模型 step 一帧），并记下最近一次调用的明细 |

### 整窗磨砂玻璃：侧栏亮、主区深

**整窗**都是系统材质的磨砂玻璃（macOS `vibrancy: 'sidebar'` / Windows acrylic）。
网页这边只负责**染色**，而且两层刻意用不同的深度 —— 深浅差本身就是层级：
侧栏浮起、主区下沉。动态（柱面粒子）不受影响，它画在玻璃**上面**。

| 层 | 颜色 | 谁刷的 |
| --- | --- | --- |
| 系统材质（模糊 + 饱和度） | 由系统给 | Electron `vibrancy`，**必须在网页内容下面透出来** |
| 侧栏染色层 | `--ym-sidebar-tint` = violet-900 @ 47% | `.sidebar` |
| 侧栏内部的 hover / 当前项 | 白色 4.5% / 5.5% / 10% | 在 `.sidebar` 作用域里重定义令牌 |
| 柱面粒子 | `--ym-surface` / `--ym-shard` | canvas（不变） |
| 主区染色层（对话区 / 预览面板） | `--ym-main-tint` = **violet-950 @ 78%** | `.main-column` / `.preview` |
| 顶栏 | 透明（在主列内部，露出的就是同一层） | `.topbar` |

主区不能刷成不透明（那样「整窗都是玻璃」就只在左半边成立），也不能和侧栏一样浅
（阅读区要压得住字、正文和壁纸不能互相干扰）。

#### ⚠️ 玻璃不通，八成是「有一层不透明底」把材质盖住了

系统材质在**网页内容之下**：网页只要有一层铺满窗口的不透明底色，材质就完全看不见 ——
表现是「开了 vibrancy，界面还是死的一块深灰」。整条链路都得让路：

```css
html[data-vibrancy='native'],
html[data-vibrancy='native'] body,
html[data-vibrancy='native'] .app-shell { background: transparent; }
```

**`.app-shell` 是最容易漏的那个**：它原来刷的是 `--dsw-alias-bg-base`，正好盖住侧栏那一列。
过一遍的清单：`.app-shell` → `.sidebar`（染色）→ `.main-column`（染色）→
`.topbar`（必须透明，它在主列内部）→ `.preview`（跟主区同一层染色）。

怎么用像素证明它真的透了（agent 看不了截图时尤其有用）：截一张 PNG，**看 alpha 通道**
（透明的地方 alpha 应该 < 255）。侧栏与主区都该是半透明，只是主区的 alpha 更高（更深）：

```
主区 (700,400): rgb(13,12,19) a=199     ← 78% 不透明 = 材质能透出来，但更深
侧栏 (120,470): rgb(21,19,30) a=121     ← 47% 不透明 = 更亮、材质更明显
```

把 `.main-column` 的底色改回不透明，主区那一点会变成 `a=255` —— 那就是「主区不透」的判据。

#### 两个连带决定

- **侧栏内部的填充色也要跟着半透明**：搜索框、hover、当前项在玻璃上会变成一块块不透明的
  补丁。做法是在 `.sidebar` 作用域里重定义那几个令牌（自定义属性会继承，规则自己就变了），
  而不是写十几条覆盖规则。没材质时这些令牌保持原来的实色（见 `--ym-nav-current-fill` 那组）。
- **不用 CSS 的 `backdrop-filter`**：窗口本身是透明的，backdrop 后面没有可模糊的内容，
  模糊只能由系统材质提供（在 Linux 上就是没有，退回实色底）。

### 视觉：Codex 配色 + 原生磨砂玻璃

- **配色**（`styles/app.css` 的 `@theme`）：近单色。底色 `#0d0d0d`，层次靠
  `surface` 的微差与半透明白描边拉开；主按钮是白底黑字；只有成功/警告/失败
  三种状态用彩色。**没有渐变，也没有紫蓝**。
- **Streamdown 换肤**：Streamdown 内部用的是 shadcn 那套 token 名
  （`bg-muted`、`text-muted-foreground`、`border-border`、`text-primary`…）。
  Tailwind 只为**已定义**的 token 生成工具类，缺了会被静默丢掉（行内代码/链接/表格就没样式），
  所以 `@theme` 里把这一整套别名都映射到了上面的色板。
- **磨砂玻璃**：由**窗口材质**提供，不是 CSS。
  `main.ts` 的 `windowMaterial()` 在 macOS 用 `vibrancy: 'sidebar'`、
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
main.ts                                    host（sessions.ts）
<userData>/projects.json                   roots = [当前项目的库]
  { version, projects: [                   + 每个「最近打开」项目的 <path>/.YuanMy/sessions
      { path, lastOpenedAt }, …            ↓
  ] }                                      locateProjects(roots)
  ↓ 启动 host 时                          · 逐根扫项目目录，按日志头里的 cwd 分组
  env YuanMy_PROJECT_ROOTS=a:b:c           · 按 cwd 去重，**先扫的根优先**（当前库说了算）
```

几条刻意定的规则：

- **只在 host 起来了才登记**（`attach` 成功之后），启动失败的路径不会攒进表里；
- 登记只是**线索**：路径可能早被删了、库可能还不存在，host 读不到就跳过，
  **读写失败一律不影响启动**（顶多是侧栏少列一个项目）；
- 有界：登记最多 20 条，单次最多**多扫 8 个根**（`DEFAULT_MAX_EXTRA_PROJECTS`），
  项目清单总数仍受 `DEFAULT_MAX_PROJECTS` 限制；
- `list-project-sessions` 用**同一套根与同一套去重**，否则会出现
  「列出来的」和「点开的」不是同一个项目的诡异现象；
- 项目要**被打开过一次**才会进登记 —— 没跑过 YuanMy 的项目不会凭空出现在树里。

> ⚠️ 会话只属于它的项目。`main.ts` 的 `attach()` 只认「调用方明确给出的 `resume`」，
> 不会把一个项目的会话 id 带到另一个项目去 —— 否则会拿着旧项目的 id 去新项目里找。
> 侧栏点会话时同时给出目标 cwd 和该项目的会话 id（这是**合法**组合）；
> 点「切换」/「打开工作目录」则不给 `resume`，于是新项目里开一个新会话。
> 早先的判据是「cwd 变没变」，点别的项目下的会话会用**全新会话**启动、
> 界面一片空白 —— 就是用户报的「切换工作区中的会话后读不到历史」。

**侧栏刻意不放的东西**（都是重复或只在排查时才有用的「参数」）：
状态行 → 并进底栏一个小圆点；模型名 → 就是下面那个输入框；会话 id → 树里已高亮；
凭据 → **只在缺失时**以警告形式出现（左下角底栏只有状态点 / 设置 / 版本号）。

点击会话 = `attach({ cwd, resume: id, reuse })`（CLI 的 `--resume` 早就通了，
这里只是给它一个界面）。点击其它项目的「切换」= `attach({ cwd })`，
即用新工作目录启一个新会话。`reuse` 的取值与「挂回」的语义见下一节。

`title` 的正式来源是 `@deepseek-ai/dsh-session-title`（写 `session/title` 日志事件）。
本项目**暂时没挂它**（它还需要 `dsh-invariants` 那套 companion 插件），
但读取端已经优先认这个事件 —— 以后挂上，或用 DSH 自己的 CLI 建过会话，标题会自动变好。

### 侧栏背景：整块柱面被切成小块、向右滚动、消散

侧栏背后是**一段柱面**（轴垂直，我们看到它正面那一小段曲面）：整段曲面按 13px 的小方块
切成网格，随机有小块被**切下来**——底下的格子留空、那一块向右**滚**出去（自转 +
略放大 + 渐隐）直到什么都看不见。整段柱面还在慢慢向右转，所以网格也在连续右移。
强度**上面最强、向下平滑衰减到 0**：上半部分是这层网格，下半部分是安静纯背景。

```
              光的来向
                 ↓
    ╭─────────────────────╮   ① 柱面：左右边缘转过去了 → 格子被投影压窄 + 变暗，
    │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ │      中间最亮，光带略微偏左（高光）
    │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ │   ② 网格：整段曲面按 13px 切开
    │ ▪▪▪▫▫▪▪▪▪▪▫▫▪▪▪▪▪▪▪ │   ③ 切下来：随机有小块脱离表面，底下的格子留空
    │ ▪▪▫▫▫▪▪▪▫▫▪▪▪▪▪▪▪▪▪ │      → 向右滚 + 自转 + 略放大 + 渐隐
    │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ │   ④ 强度：上强下弱，到 78% 高度处归零
    ╰─────────────────────╯
```

| 现象 | 由什么决定 |
| --- | --- |
| 柱面感 | 屏幕 x = R·sin θ（格子被投影压窄：中间 12.8px → 边缘 8.1px）+ `cylinderShade` 的明暗（中间比边缘亮 1.9 倍）与高光带 |
| 切成小块 | 曲面按 `cell`(12px) + `gap`(1px) 切格子，每格有自己的「静止 / 被切下来」周期 |
| 整体向右滚动 | `drumSpeed` = 7px/秒：整段曲面在转，网格与「哪块料在哪一格」一起右移 |
| 消散 | 被切下来的那块：`easeOut` 右移 34px + 滚动式自转 + 略放大 + 渐隐到 0 |
| 上强下弱 | `verticalIntensity(y) = (1 − y/0.78H)^2`，**同时**乘在表面亮度与消散幅度上 |

代码分两半，界线还是「能不能在 Node 里推演」：

| 文件 | 管什么 |
| --- | --- |
| `components/sidebar-cylinder.ts`（纯，不 import 任何 DOM） | 柱面投影与明暗、纵向强度、每块的周期与消散曲线 |
| `components/sidebar-backdrop.tsx` | canvas / DPR / rAF / 帧率 / 暂停条件 / 颜色 / 两遍绘制 |
| `components/sidebar.tsx` | 把 `<SidebarBackdrop />` 放进 `<aside>`，内容裹进 `.sidebar__scroll` |

纯的那半随机源是**注入**的（组件传 `Math.random`，真值表传固定种子），所以几何与曲线
都能在 Node 里直接验：**46 项真值表**（见下）。

#### 三条几何上的硬约束（都写成真值表了）

1. **位移必须按角度算，不能按屏幕像素。** 柱面是弯的：边缘处「一格」的屏幕间距比弧长
   少 4.7px。按像素位移的话，材料每滚过一格就会在边缘跳一下。
2. **两侧要多铺两列。** 鼓面位移不是整格时，可见的那段弧会在材料上滑动不到一格 ——
   不把多出来的那两列画上，侧栏最左会出现一条会呼吸的空缝。真值表直接量
   「相邻格子之间只有缝、没有洞」（最大缝 ≤ gap + 0.6px）。
3. **鼓面按整圈取模，不能按一格取模。** 一圈 = `columns` 格 = 角度上正好 2Θ，
   几何与材料映射都回到原样；按一格取模会让材料映射突然错开一列，画面跳变。

#### 三条不做就会出事的规则

1. **必须尊重 `prefers-reduced-motion`**：系统里开了「减弱动态效果」的人是真的会被持续动的
   东西弄难受，而这个效果**信息量为零**。命中时直接不启动循环，并把 canvas 清空。
2. **窗口不可见时必须停**（`visibilitychange`）：除了省电，还因为 **Chromium 本来就会在
   窗口被遮挡/最小化时暂停 rAF** —— 这时画布会冻在最后一帧，所以要主动清掉，
   回来时再从头继续（场的状态保留，碎屑接着滚）。
3. **`dt` 要夹上限**（48ms）：切回前台/系统卡顿后 `now − last` 可能是好几秒，
   不夹的话所有碎屑会「闪现」到远处。

另外两条是性能要求：**每帧不读布局**（尺寸只在 `ResizeObserver` 里读一次并缓存）、
帧率压到 **30fps**、DPR 上限 **1.25**。三者的开销是叠加的 —— 光栅化开销几乎正比于
**覆盖的像素数**，而这层网格的覆盖率约 23%：

| 配置 | 渲染进程 CPU（`TaskDuration` 口径） |
| --- | --- |
| 60fps + 每帧读 `clientWidth` + DPR 2（最初版） | ~20% |
| 30fps + 缓存尺寸 + DPR 1.5 | 9.6% |
| **30fps + 缓存尺寸 + DPR 1.25（现在）** | **~7%** |
| 系统「减弱动态效果」命中（效果停） | 0.1%，画布已清空 |

觉得费电就把 `MAX_DPR` 降到 1、或把 `FRAME_INTERVAL_MS` 改成 `1000/24`：观感几乎不变，
开销按比例再降。

#### 侧栏的 DOM 结构为此改过一次

```
<aside class="sidebar">          ← 底色/描边/position:relative，**不滚动**
  <canvas class="sidebar__fx">   ← 绝对定位、inset 0、z-index 0、pointer-events: none
  <div class="sidebar__scroll">  ← z-index 1，这里才滚动
    品牌 / 搜索 / 项目树 / 底栏
```

⚠️ **粒子层不能放进滚动容器**：canvas 是绝对定位的，塞进 `overflow-y: auto` 那一层就会
跟着会话列表一起滚，看上去像「网格粘在列表上」。所以滚的是内层、粒子留外层。
（`elementFromPoint` 实测命中 `.sidebar__brand`，画布不吃鼠标事件。）

#### 观感与调参

实测（264×800 的侧栏）：峰值不透明度 ~34%（刚被切下来那一瞬间）、网格本体每格
~5%、覆盖率 23%；纵向分布上四分位 : 中段 : 下四分位 = 52125 : 24867 : **0** 像素。
要调的话：

| 想要的效果 | 改哪 |
| --- | --- |
| 更亮/更淡、切下来的块更亮 | `DEFAULT_OPTIONS.surfaceAlpha` / `shardAlpha` |
| 上面更集中 / 铺得更靠下 | `fadeHeight`、`fadePower` |
| 格子大小、网格密度 | `cell`、`gap` |
| 更多/更少的块在滚 | `restRatio`（越小，同时在滚的越多）、`cycleMs` |
| 滚得更快更远 | `drumSpeed`（整体）、`rollPx`、`rollSpin`（切下来的那块） |
| 柱面弯得更厉害 | `curvature`（0.95 ≈ 54°，平面就填 0） |
| 光从哪来 | `light` |
| 色调 | `app.css` 的 `--ym-surface` / `--ym-shard`（从官方令牌派生，不写死 rgb） |

> 说明：**柱面在背景层，文字仍是平的**（把整块侧栏做 3D 旋转会让文字发虚、可读性变差）。
> 如果确实想要连文字一起弯，那是另一件事：给 `.sidebar` 加 `transform: perspective(...) rotateY(...)`，
> 代价是文字渲染变模糊、命中区域也要重新对齐。

#### 会话条目：单行 24px，比项目行更小

会话行是**单行**的（图标 + 标题 + 右端时间）：`min-height: 24px`、`padding: 3px 6px`、
`border-radius: 6px`、12px/16px。它必须比项目行（`padding: 5px 6px` + 13px/500 ≈ 32px）
**更小更淡** —— 层级由「缩进 + 竖线 + 字号 + 行高」表达，而不是靠把会话做成卡片。

早先它是**两行**（标题 + 时间上下叠，一行 ≈ 42px）：比项目行还厚，一屏放不下几条，
整块读起来像一排卡片而不是一棵树。时间挪到右端之后，不同长度的标题看起来也在同一列。

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

#### 想让一个 skill「只由用户主动使用」：命令专用 skill

技能与命令是两个生命周期（见 `app/cli/commands.ts` 开头的表）：技能是**模型**按需加载的
能力包（描述常驻上下文），命令是**用户**敲 `/名字` 触发的一次性流程（零上下文成本）。
两者可以拼起来 —— 这就是「需要主动使用」的 skill：

1. `SKILL.md` 的 frontmatter 写 `disable-model-invocation: true`：它**不进模型的会话目录**
   （模型看不到、也不会自己加载），设置界面里显示成 `命令专用`；
2. 再写一个同名命令 `.agents/commands/<名字>.md`，用 `include:` 把 `SKILL.md` 内联进来：
   用户敲 `/名字` → 命令正文 + 技能正文 + 本次输入拼成**这一回合**的用户消息
   （`expandCommand()`；技能正文的 frontmatter 会被剥掉）。

现在仓库里有两个例子：`/report`（报告成稿）与 `/ip-as-logo`（极简方形 IP 吉祥物，
来自 [s1dashu/ip-as-logo-skill](https://github.com/s1dashu/ip-as-logo-skill)）。

⚠️ **不要**给「命令专用技能」插入技能 chip：输入框 `/` 菜单里那种 chip 落库是
「用 skill 工具加载 X 后按它执行：」，而内核的 `skill` 工具**明确拒绝**加载非
模型可调用的技能（`not available for model invocation`）—— 所以 `/` 菜单里的技能组
现在只列 `invocation === 'global'` 的技能，命令专用的一律走上面的命令入口
（这段过滤在 `components/mention-menu.tsx` 的 `buildTriggers`/`buildMentions` 里）。

### 多会话：切走不打断、切回就挂回

一个会话一个 host 子进程（槽位），键是 `sessionKey(cwd, sessionId)`（`host/protocol.ts`）。
`main.ts` 的 `attach(request)` 有三种走法：

| 情形 | 走法 |
| --- | --- |
| 渲染进程见过这个会话，且这边还留着它的 host（多半是**后台还在跑**） | **挂回**：只换前台，不动进程 —— 后台进度一点不丢，也不经过「正在切换」 |
| 目标空闲被回收了 / 从没打开过 | **重启**：起一个新 host，带 `--resume` 回放历史 |
| 别的会话正在跑 | **原样留着**，跑完自己收掉（`spawnSlot` 的 `turn-end` 分支） |

几条规则：

- **空闲的立刻回收**：每次 `attach` 都会收掉「不是目标、又不在忙」的槽位 ——
  每个槽位都是一整个内核，没有理由让空闲的占着。同时最多 `MAX_LIVE_SLOTS = 6` 个；
  超了会**明确告诉用户**「这个后台任务已被中断」，不静默杀。
- **`reuse` 由界面给**：界面知道「这个会话我有没有视图」（`knownViews`）。没有视图
  （第一次打开、界面重载）就不谈挂回 —— 挂回一个空视图只会显示空白，不如重启回放历史。
- **`activeBusy` 关掉一个竞态**：界面的 `busy` 是乐观状态（点发送就先置位），
  主进程要等 `prompt` 请求到达才知道；用户「刚发出就切走」时靠这个提示保住那一轮。
- **每一帧都打 `hostId`**：渲染进程按它把事件路由到各自的会话视图（`Store.views`），
  对组件只暴露当前那一份（`project()`）—— 所以「多会话」对组件完全透明。
- **`workspace` 帧的 `current` 标记不可信**：每个 host 都会把「它自己」标成当前会话；
  而且挂回时压根不会来新的 `workspace` 帧。所以标记在**投影时**现算
  （`markCurrent` / `markCurrentProject`）。
- **界面重载而内核还活着**时走 `history:replay`（让 host 把落盘历史重发一遍），
  而不是重启 —— 重启会杀掉还在跑的那一轮。

### 恢复会话：历史回放由 **host** 提供

点侧栏里的一个会话 = 用 `--resume <会话 id>` 起一个内核（能挂回就挂回，见上一节）。
内核恢复的是 **agent 的上下文**，界面这边还是空的（实时帧只描述「之后」发生的事），
所以 host 会在 `ready` 之后补一帧 `history`：

```
点击会话 → IPC.attach({ cwd, resume, reuse }) → 挂回活着的 host，或带 --resume 起一个
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

#### 切换要丝滑：内容只在 `history` 帧到达时替换

切会话 = 重启内核（约 0.5 秒）。早先这段时间界面会**连着抖四下**，因为收到 `restarting`
就无条件清空：

| 早先的表现 | 为什么 |
| --- | --- |
| 消息区白掉，闪出「正在启动内核…」 | `items` 被清空 |
| token 统计 / 轮次 / 耗时归零 | `usage`、`turns`、`lastTurnMs` 被重置 |
| 模型下拉变空、被禁用 | `models` 被清空 |
| 已展开的其他项目显示「读取中…」 | `projectSessions` 被清空 |

这些数据在切换前后**其实都还有效**（模型来自内核配置，内容马上就会被历史覆盖），
没有理由先抹掉再填回来。现在分成两条路（`use-agent.ts` 的 `restarting`）：

| 情形 | 做什么 |
| --- | --- |
| **冷启动**（还没有内核） | 老路：清空 + `booting`（界面上本来就是空的） |
| **已经有内容**（切会话 / 切项目 / 重启内核） | **什么都不清**，只打 `switching` 标记；内容等 `history` 帧**整段替换** |

配套的四件事：

1. **host 一定会发 `history`**，新建会话发的是**空历史**（`sendHistory(undefined)`）。
   界面因此只需认这一种「内容现在是 X」的信号 —— 早先「读不到日志就什么都不发」，
   于是新会话永远等不到那一帧，只能靠 `restarting` 清空。
2. **`switching` 由 `history` 帧解除，不由 `ready`**：`ready` 先到、历史后到，
   在 `ready` 就放开的话，用户此时按回车发的消息会被随后到达的历史覆盖掉。
   挂回还活着的 host 时则由 `attached` 立刻解除（视图本来就是实时的），
   另有 3 秒超时兜底，避免那一帧永远不来时把界面锁住。
3. **点下去的那一行要有回应**：`.session--opening`（和 hover 同档的底色 + 压暗）。
   否则点完 0.5 秒内什么都没变，用户会以为没点上、再点一次。
4. **内容替换时淡入**：`.messages__inner` 按 `sessionId` 换 key，配一条 160ms 的
   `ym-swap-in`（`prefers-reduced-motion` 下自动关掉），把「闪一下」变成「过渡一下」。

实测（从 Node 侧每 100ms 采一次渲染进程的 `TaskDuration`，不受页面自身影响）：

```
+ 100ms  task=  1ms  当前=旧会话   提示=正在切换…（输入会保留）
+ 200ms  task=  0ms  当前=旧会话
+ 300ms  task=  1ms  当前=旧会话
+ 400ms  task=  3ms  当前=旧会话
+ 500ms  task= 11ms  当前=新会话   提示=就绪        ← 只有这一次 11ms 的提交
+ 600ms  task=  1ms  当前=新会话
```

也就是说：**切换期间渲染进程基本空闲**（页面可交互、hover/滚动/打字都正常），
唯一的开销是替换那一帧的 11ms。全程没有出现「正在启动内核…」的占位。

#### 连点两个会话：靠「代际」保证最后一次赢

手快连点两个会话时，第一次的内核会被第二次收掉，而它晚到的 `history` / `workspace`
帧会盖到第二次的界面上（表现：先闪一下 A 的会话，或者干脆停在 A）。两道守卫：

- `main.ts` 的 `AgentHost.generation`：每次 start / stop 都 +1，回调里捕获自己那一代，
  **不是当前代就直接丢弃**（message / error / close 三处）——
  上一版只靠 `this.child !== child` 判断，那只覆盖了 close，覆盖不了 message；
- `main.ts` 槽位上的 `dead` 标记 + 事件上的 `hostId`：被收掉的槽位不再转发任何帧，
  即使转发了，渲染进程也只会把它们归到那个（已经没有前台的）会话视图上。
  早先那个全局 `restartGeneration` 因此不再需要 —— 正确性现在由「槽位自己」保证。

实测：先点「session B」、80ms 后再点「say hi」，+800ms 停在 **say hi**（最后一次点击），
无报错、提示回到「就绪」。

### 输入框：Tiptap 富文本 + 触发符 chip + 回合中途调整目标

输入框是 **Tiptap**（ProseMirror）编辑器，不是 textarea：选中的命令/工具/技能/文件会变成
**chip**（带底色的内联原子节点），在输入框里就能看出「这条消息用了什么」。

```
打字                 →  ProseMirror 文档（doc > paragraph > text | chip | hardBreak）
Enter / 发送按钮      →  docToText(doc).trim()  →  纯文本  →  host / 内核
```

**触发符**（`components/mention-menu.tsx` 给候选，`components/editor/*` 管编辑器）：

| 触发符 | 选什么 | chip 上显示 | 落库文本 |
| --- | --- | --- | --- |
| `/` | 命令 + **全局**技能（按组分列） | `/名字` / 技能名 | 命令落 `/名字`（host 展开，见下）；技能落「用 skill 工具加载 … 后按它执行：」。`disable-model-invocation` 的「命令专用技能」不列在这里（插进来会报错），走各自 `/命令` |
| `@` | MCP 工具（按中文 server 名分组，功能名排序） | **中文功能名**（`补天 · 白帽排行`） | `用 mcp__<server>__<tool> 工具：`（**原名照旧**，见「`@` 菜单：显示中文功能名」一节） |
| `#` | 工作目录里的文件 | 相对路径 | 相对路径（`read` 与文件卡片都认相对路径） |

↑↓ 选择、Enter/Tab 确认、Esc 关闭；点一下也能选（用 `onMouseDown` 而不是 `onClick` ——
否则编辑器先失焦、光标位置就丢了）。菜单项的名字**按类型上色**，颜色就是它落进输入框后的
chip 颜色（`--ym-tok-*`）。

**`/` 只认整条消息的第一个位置**：host 的 `matchCommand` 只认 `^/名字`，出现在句中时给一个
点了没用的选项反而误导。`@` `#` 要求**词首**（`editor/triggers.ts` 的 `triggerAllowed`）：

- 空白 / 左右括号引号 / 中英标点 / **中日韩文字**之后都算词首 —— 中文不用空格分词，
  `帮我把#composer` 是正常写法（最早漏了汉字这条，`#` 在中文后面永远弹不出菜单，实测踩到）；
- 拉丁字母、数字后面**不算**：`foo@bar`、`C#code`、`https://x` 都不会弹菜单。
- 这份边界判据（`isBoundaryChar`）与**消息记录的 token 染色共用同一份**：输入框里认出来的
  东西，落到会话记录里必须还是同一种颜色。

**选中后插的是 chip，不是一段文本**（`components/editor/chip.ts`）：`atom: true` + 不声明
`content`，于是 ProseMirror 给它 `contenteditable="false"`，光标进不去、退格一次删掉整个、
方向键一次跨过去。显示的文字（`label`）与落库的文字（`text`）是两回事，四个构造器集中在
`editor/chip-text.ts`。⚠️ **不要用 `editor.getText()`**：chip 是 atom、没有文本，`getText()`
会把它整个丢掉，`/report` 选完发出去等于空消息。序列化只走 `editor/doc-text.ts` 的
`docToText()`（纯函数，可被真值表脚本直接跑）。

`#` 的候选来自 host（`files:list` → `files` 帧）：只读一次目录树**有界**（最多 4000 个文件）、
跳过 `node_modules`/`.git`/构建产物/点目录、并缓存 30 秒 —— 按一次键不能卡住。排序是
「匹配位置 → 是否点文件 → 路径长度」（点文件靠后：不然刚打出一个 `#` 时前几条全是
`.DS_Store`，看着像坏了）。菜单是「**先开菜单、后到货**」：候选到了靠
`SuggestController.refresh()` 重算，并且按 `state.filesQuery` 丢弃过期结果。

#### 键盘只有一条路径：输入法 → 菜单 → 提交

ProseMirror 取 `handleKeyDown` 的顺序是「**view 自己的 props 先，然后才是各插件**」
（`EditorView.someProp` 先查 `_props`），Tiptap 又把 `editorProps` 直接摊进 view props。
所以 composer 里的 `handleKeyDown` 是唯一的总闸，按这个顺序问：

1. `view.composing || ime.isImeKeyNative(event)` → 交给输入法；
2. `controller.key(event)` → 菜单开着时方向键/Enter/Tab/Esc 归菜单；
3. Enter（不带修饰键）→ 提交；Esc → 中断本回合。

⚠️ 第 1 步为什么**必须**有 `view.composing`：ProseMirror 在「DOM 变化看起来像按了 Enter」时
会**自己合成**一个 Enter 键事件（`readDOMChange` → `keyEvent(13, 'Enter')`，即
`document.createEvent('Event')`）再走一遍 handleKeyDown 链 —— 那个事件**没有 `isComposing`、
`isTrusted === false`**，只有 `keyCode === 13`。输入法用回车确认候选词时，提交动作恰好产生
一次「新增段落」的 DOM 变化，于是这个合成 Enter 打进来：只信 `event.isComposing` 的守卫会
**放行**，半成品就被当成消息发出去（本项目实测踩到，日志里能看到一次 `compositionend` 都没有
却收到了 `keyCode 13`）。`view.composing` 是 ProseMirror 自己的组字状态，此时仍为 `true`。

> 顺带一条：非 Android 上 ProseMirror 的组字状态**只由 `compositionend` 清除**
> （`timeoutComposition = android ? 5000 : -1`）。真实输入法一定会发 `compositionend`；
> 但用 CDP 的 `Input.imeSetComposition` 造组字时不会 —— 那时 `view.composing` 会一直是 true，
> Enter 就彻底不响应（看着像守卫坏了，其实是测试手法不完整）。

**回合中途调整目标**：输入框**不再因为「正在生成」而禁用**。空闲时 Enter 是发一轮
（`prompt`）；**生成中 Enter 是纠偏**（`steer`）：

```
点击/回车 ──▶ IPC steer ──▶ host ──▶ kernel.agent.steer(message)
                                        └─ 运行中：在**下一个 step 边界**消费
                                           空闲时：直接开一个回合
```

为什么用 `steer` 而不是再发一个 `prompt`：后者是**排队**（这轮跑完才轮到它），
而「调整目标」要的是立刻改方向。实测日志（同一轮内、工具调用之后）：

```
── turn/start turn=1
   step/start step=1 → tool/call glob
   step/start step=2
   user[user] :: 目标调整：不要逐个读了，直接给出结论。   ← 这个边界被消费
   tool/call read ×5
   step/start step=3
── turn/end turn=1 reason="completed"
```

两点如实说明：

- **已经发出的请求不撤回**：纠偏在下一个 step 生效，所以那一批已经在跑的工具调用仍会跑完
  （上例里 step 2 的 5 次 read）。
- **它是「一轮里的插话」，不是新一轮**：会话记录里单独一种条目（`SteerItem`），
  界面上是更矮更淡、靠右的「目标调整」气泡，轨迹里标 `GOAL` —— 事后回看不会误以为是新提问。
  也正因为会在助手条目后面追加内容，`activeAssistant()` 改成**从后往前找最后一条助手条目**
  （只看末项的话，流式增量会被拆到两个气泡里）。

#### 编辑器扩展集：刻意做小

`components/editor/kit.ts` 只开「打字本身」要用的东西（Document / Paragraph / Text /
HardBreak / UndoRedo / TrailingNode / Placeholder / Chip / 三个 suggestion）。
StarterKit 的其余部分（标题、列表、引用、代码块、加粗…）全部 `false`：它们的**输入规则**会在
用户正常打字时生效 —— `# ` 变标题、`- ` 变列表 —— 而 `#` 正是文件触发符。用户想写
`#123 ` 却看着输入框变成大标题，是功能变成了 bug。要加功能时请逐个打开，并想清楚它的输入规则
会不会和 `/` `@` `#` 打架。


### 指令 token：不同指令不同样式

`/命令`、`@工具`、`#文件`、技能名混在一句话里时，全是同一种灰字 —— 扫一眼分不出
哪个是命令、哪个是工具、哪个是文件，而它们恰恰是「这条消息让 agent 干了什么」的关键。
所以纯文本的地方走 `components/rich-text.tsx` 渲染，按类型染色：

| 类型 | 识别 | 样式 | 色相 |
| --- | --- | --- | --- |
| 命令 | 词首的 `/名字` | `.tok--command` | 强调色（和发送按钮同族：都是「要执行的动作」） |
| 工具 | `mcp__<server>__<tool>` | `.tok--tool` | 青绿（外部能力，和本地命令区分） |
| 技能 | 「用 skill 工具加载 `<名字>`」里的名字 | `.tok--skill` | 紫（可复用的指令包） |
| 文件 | `#路径`，或**看起来像路径**的裸词 | `.tok--file` | 中性灰 + 等宽（它只是「东西」，不该抢眼） |

渲染点：用户消息、中途目标调整、工具卡片的参数与错误结果、轨迹明细。
**助手正文不走这里** —— 它是 Markdown，模型自己会用反引号包住工具名（`markdown.tsx` 管）。

**输入框里的 chip 用同一组颜色令牌**（`--ym-tok-*`，`.chip--command` 等）：在输入框里看到的
颜色，就是它落进会话记录后的颜色 —— 用户不需要学两套配色。菜单项的候选名字也按类型上色。

两条实现上的取舍（都踩过）：

- **只认「有把握」的**：`#` 前缀一律认；裸词必须**含 `/` 且末段带扩展名**才当路径。
  否则 `and/or`、`HTTP/2`、`24/7` 也会被染色，反而更乱。
- **必须有真词边界**（`isWordBoundary` → `isBoundaryChar`：空白 / 左右括号引号 / 中英标点 /
  **中日韩文字**）。扫描是逐字符推进的，中途会停在词内部 —— 宽松判据下
  `https://example.com/x.md` 会被切出 `xample.com/x.md` 染成文件 chip。真值表里专门有这条负例。
  汉字算边界是后来补的：中文不用空格分词，`见app/cli/main.ts` 这种写法必须能染色
  （同一个判据也管输入框的触发符，见上面「输入框」一节）。

纯逻辑（`tokenizeRichText` / `looksLikePath` / `isWordBoundary` / `isBoundaryChar`）在
`rich-text-tokens.ts` 里，与组件分文件，就是为了能在 Node 里直接 import 跑真值表 ——
`.tsx` 带 JSX，纯 Node 加载不了。`editor/doc-text.ts` / `editor/chip-text.ts` /
`editor/triggers.ts` 同样是为了这个（都只 import 类型或纯函数）。

> 顺手修掉的一个隐形 bug：`font-family: var(--ds-font-family-mono)` 里的变量**从来没定义过**
> （真实名字是 `--ds-font-family-code`），于是「文件路径用等宽」这条一直是空转 ——
> 无效值在计算时退化成 `inherit`，看起来跟没写一样。现在四处引用都改成真名字了。

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

展示上是**会话累计**（每帧累加），鼠标悬停（或 Tab 聚焦）统计条最左边那个胶囊会弹出
**明细卡**（`composer.tsx` 的 `UsageDetail`）：未命中 / 命中 / 写入 / 计费输入合计 /
输出（含推理）/ 命中率，再加一段「最近一次调用」的四个数。判定与累加都是纯函数
（`billedInputTokens` / `cacheHitRate` / `accumulate`）—— 改这里时盯住两点：
没有输入 token 时命中率是 `null`（显示 `—`），以及三种输入 token 都要进分母。

明细卡的两个交互细节（都写在 CSS 注释里，别删）：
弹出的卡片是 `.usage` 的**子元素**（指针移进去不触发 `mouseleave`，否则一闪就没），
`::before` 再补一块**透明桥接区**跨过胶囊与卡片之间的空隙；
`tabIndex={0}` 让键盘用户也能看到（`:focus-visible` 时给胶囊描一圈强调色）。

### 工作台布局（左侧工作区 + 右侧对话/轨迹）

```
┌───────────────┬───────────────────────────────┬────────────┐
│ 工作区  [+新会话]│  对话 | 轨迹        <cwd>  [▤] │ 预览面板    │ ← 标签栏（拖拽区）
│ [搜索会话   ]  ├───────────────────────────────┤（可隐藏）   │
│ ▾ 项目         │  对话面板：推理行 / Markdown /  ─┤ README.md  │
│    ● 会话  时间 │  工具行 / 文件卡片（预览+打开） ─┤ 报告/代码/ │
│ ▸ 另一个项目   ├───────────────────────────────┤ 图片/最近   │
│ ─────────────  │ [+][完全访问][模型▾][强度▾][发送]│ 文件        │
│ ● 就绪 设置 v1 │  3.2k in/88 out · 3.0s · 1 轮  │            │
│  ● 会话运行中  │  （悬停 token 胶囊 → 明细卡）    │            │
└───────────────┴───────────────────────────────┴────────────┘
                    ↑ 右侧一列「会话刻度尺」（对话太长时点刻度跳转）
```

新增的构件与它们的**真实数据来源**：

| 构件 | 数据来自 |
| --- | --- |
| 搜索框 | 前端过滤会话标题 / id；命中后切成跨项目平铺结果（找会话时层级是干扰） |
| 标签栏「对话 / 轨迹」 | 同一个 `state.items`，轨迹走 `traceSteps()` 摊平（纯函数） |
| 工具调用 run（ToolChips） | `fileActionOf()` 认出 read/write/edit 的路径；点 chip **预览**（`IPC.previewRead`），「用系统程序打开」在预览面板里（主进程 `shell.openPath`） |
| 会话刻度尺（最右） | `railMarks()` 一条条目一道刻度；「当前读到第几条」由真实 DOM 位置算（`indexAt`） |
| 预览面板（右侧列） | 「最近文件」= `recentFiles()`（倒着捞会话里碰过的文件，路径去重）；内容按扩展名分流渲染 |
| 权限下拉 | **如实显示现状**：本地 provider 无沙箱无审批，所以只有「完全访问」一项 |
| 模型下拉 | 内核 `ctx.llm.listModels(provider)`（`ready.info.models`），再按**本地清单**过滤 |
| 强度下拉（`low` / `high` / `max`） | 适配器对**这个模型**申报的 `reasoning.efforts`（host 的 `modelEfforts` 调 `ctx.llm.resolveModelInfo`），只挑出三档「强度」；选中走 `set-effort` |

##### 推理强度：走 `agent/request` waterfall，不重建 agent

和换模型完全同一条路：host 里一个 `route: { model, effort }`，`agent/request` 的
waterfall 监听者把它写进即将发出的请求配置（`reasoningEffort`），于是**正在跑的回合
不受影响**，只有下一次请求用新档位。

- 档位**来自模型**（`resolveModelInfo().reasoning.efforts`，DeepSeek 适配器申报
  `off / low / high / max`），不是界面写死的常量；适配器不申报时退回内置的三档兜底；
- 下拉里**只露 `low | high | max`**：`off` 是「关掉推理」，不是一档强度，
  放进同一个下拉会让人以为它是最低档 —— 要它就用启动参数 `--effort off`；
- host 侧对传进来的值做一次白名单校验（`EFFORTS`），非法值**保持原样**并回一帧
  `effort-changed` —— 界面永远显示真实生效的档位，不会显示一个假的选择。

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

### 会话刻度尺：等距短横线 + 白色长横条

对话一长就没法快速回看：翻记录只能滚轮子，想问「刚才那份报告在哪」得滚半天。
右侧这一列把整段会话压成一把**竖尺**，一条条目一道刻度：

```
   ────        普通刻度：14×2px 短横，按角色微调颜色（你=蓝紫 / 助手=灰 / 提示=琥珀）
   ────────    当前刻度：30×3px **白色长横条** + 一点辉光（"我读到哪儿了"）
   ↑ 尺子比窗口长时整体上下滑动，让当前刻度停在窗口中间（两端不越界）
```

三条交互，都是「一眼定位、一下跳过去」：

| 操作 | 行为 |
| --- | --- |
| 在尺子上**滚轮** | 一格一格选（一格 = 一条条目），选择即跳转 —— 这就是「可滚动选择的刻度尺」 |
| **点**某道刻度 | 平滑滚到那一条（`behavior: 'smooth'`） |
| 在尺子上**拖** | 连续选（每滑过 10px = 一格） |
| 悬停 | 浮出提示框：角色角标 + 摘要（最多 5 行）+「N 次工具」；正在跑的那条带「运行中」。**移开即渐隐**（160ms 淡出并轻推 6px 收回） |
| 滚消息 | 尺子自动跟着走：**屏幕上最后那条可见的条目 = 当前刻度**（判定线在视口底边往上 8px），滑到中间 |

> 尺子本体只有「刻度 + 提示框」两层：没有独立的轨道/滑块 —— **当前那道刻度本身就是指示器**
> （它最长、最亮，且会随选中项滑到窗口中间）。所以美化它时改的是三类刻度色与提示框，
> 不是去补一个滑块。
>
> 有尺子时**消息区不再画系统滚动条**（`.main-column--rail .messages { scrollbar-width: none }`）：
> 两个指示器同时出现纯属噪音，位置与跳转都交给尺子。滚动本身一点没动
> （滚轮 / 触控板 / 键盘 / 程序化 `scrollTop` 照旧），去掉的只是那根可见的条。
> 只加 `.main-column--rail` 前缀，是因为**只有对话面板有尺子** —— 轨迹面板
> （以及刚开的新会话、条目不足两条时）仍然保留滚动条，否则那里一个位置提示都没有。
| 键盘 | 焦点在刻度上时 ↑/↓ 换一条 |

「当前是哪一条」只认一条规则：**屏幕上最后那条可见的条目**（判定线 = 视口底边往上
`ANCHOR`=8px）。取底边而不是顶边是刻意的 —— 用户眼睛停在屏幕最后那条上，滚到会话末尾时
当前刻度就该是**末尾那一条**；用顶边的话它会停在屏幕中间某条，跟看到的东西对不上。

这条规则还决定了「点刻度跳到哪」：如果只是把条目顶到视口顶，短的条目会被后面几条挤出
「最后可见」的位置，出现「点第 10 条、高亮跑到第 13 条」。所以落点由纯函数
`jumpTop()` 给：**条目比视口高就顶到上方**（它的范围本来就盖住判定线），否则**让它的
底边贴住判定线**（下方留 8px 余量）。这样「点哪条就亮哪条」恒成立 —— 有 126 组几何的
性质测试盯着（遍历条目高度 × 视口高度 × 下标，断言跳完 `indexAt(jumpTop(...)) === i`）。

数据分成两半，这是这个构件唯一需要理解的地方：

- **有哪些刻度**：`railMarks()`（`use-agent.ts` 的纯函数）—— 角色、摘要、工具数、
  是否还在跑。摘要压成单行、140 字截断。
- **刻度在哪儿**：只能问真实 DOM。markdown 渲染出来的高度只有浏览器知道，
  所以 `measure()` 量每个 `[data-item-id]` 的顶边位置，再交给纯函数 `anchorOf()` /
  `indexAt()` / `jumpTop()` / `rulerShift()`（`components/message-rail-model.ts`，
  无 DOM，能在 Node 里跑真值表）。

四个踩过的坑，都写在代码注释里，这里留个索引：

| 坑 | 表现 | 处理 |
| --- | --- | --- |
| `setPointerCapture` 抢走 click | 点刻度没反应，滚到的是「鼠标位置居中处」 | 捕获只在**拖动**时用，且监听挂 `window`（不改 click 落点） |
| 窗口被遮挡时 rAF 被暂停 | 尺子停在 0 位置、点什么都没反应 | **首次测量同步做**；换选中项也同步算（只有重新测量走 rAF） |
| 平滑滚动中途改写选中项 | 点第 10 条，尺子一路抖最后停在别处 | 跳转期间上锁（`lockRef`），动画结束解锁 |
| 按内容长度成比例画刻度 | 一条巨长的工具输出占掉半把尺子，「第几条」数不清 | 刻度**等距**；内容高度只用来算「当前第几条」 |
| 当前刻度按「视口顶边」算 | 滚到会话末尾时高亮停在屏幕中间某条，跟看到的东西对不上 | 判定线挪到**视口底边往上 8px**（`anchorOf()`）；跳转落点同步改成 `jumpTop()`，否则点第 10 条会亮到第 13 条 |
| 提示框移开不消失、或消失得太生硬 | 悬停信息一直挂在界面上；直接卸载又没有任何过渡 | 分成两份状态：`tipVisible` 先置 false 让 CSS 淡出，`TIP_FADE`(160ms) 之后再清内容卸载；离开**刻度**就触发，划到相邻刻度时 enter 会撤掉定时器（既不残留也不闪） |

> 尺子占 34px 宽（`.main-column--rail .composer` 把输入框右内边距从 24 加到 58），
> 目的是让输入框与消息区**中心对齐** —— 只让消息那一行窄 34px 的话，两者中心会差 17px。

### `@` 菜单：显示中文功能名，不显示变量名

`@` 弹出的 MCP 候选一律用**中文功能名**（「补天 · 白帽排行」），因为
`mcp__butian__butian_rank` 这种名字是给模型看的，不是给人看的。真正发给模型的东西
一个字都没变：插进输入框的 chip 落库时仍是 `用 mcp__butian__butian_rank 工具：`
（`label` 与 `text` 在 `editor/chip-text.ts` 里本来就是分开的两件事）。

| | 之前 | 现在 |
| --- | --- | --- |
| 分组 | `butian` | **补天**（server 的中文名；认不出的 server 显示 `MCP · <id>`） |
| 名字 | `mcp__butian__butian_rank` | **白帽排行**（功能名） |
| 说明 | 英文 description | 中文描述（英文的不显示，免得中英混排） |
| chip 上显示的字 | `mcp__butian__butian_rank` | **补天 · 白帽排行**（落库文本仍是原名指令） |

名字与说明集中在 `renderer/src/tool-names.ts`（纯表 + 兜底规则，无 JSX、无 DOM，
能在 Node 里跑真值表）：

- **补天 MCP**：7 个工具的 `title` 本来就是中文（`app/mcp/butian/server.ts`），抄一份到表里；
  `toolOrder()` 顺便定死菜单里的顺序（项目大厅 → 排行 → 平台数字 → 我的空间 → …）。
- **内置工具**：13 个也逐个写了中文名与说明（`read` → 「读取文件」）。**目前没有界面在展示
  它们**（工具清单已按需求从侧栏移除），这张表是 `toolDisplay()` 的完整契约：任何地方要显示
  工具名，调它就有中文，不必各写一份。
- **认不出来就不编**：用户自己挂的 MCP server（或内核换了工具名）显示
  `MCP · <server id>` + 功能名兜底为原名；说明只在服务端给了**中文**描述时才有。
  宁可露出变量名，也不能瞎起一个会让人误判的中文名。
- 描述里给模型看的 markdown 记号（补天的「（\*\*需要登录 Cookie\*\*）」）会先洗掉；
  搜索同时匹配原名与中文名 —— `@butian` 和 `@排行` 都能找到「白帽排行」。

### 通用浮层菜单（`components/menu.tsx`）

输入框那三个下拉（`+` / 权限 / 模型）现在共用同一个菜单组件（原先各写各的）。
抽出来的同时把「一个真菜单该有的东西」补齐了：

| 能力 | 说明 |
| --- | --- |
| ↑ / ↓ / Home / End + Enter / Space | 键盘能整条走完；高亮与鼠标悬停是**同一种视觉**（`--cursor`），不用分辨自己用哪种方式选的 |
| `role="menu"` / `menuitem` + `aria-haspopup` / `aria-expanded` | 读屏软件知道「这是菜单、现在开着」 |
| Esc 关闭并把焦点**还给触发器** | 关掉之后接着按 ↓ 还能再打开 |
| 点外面关掉（`pointerdown` 捕获阶段） | 不再用「整屏遮罩」那种做法 —— 遮罩会挡住底下一切交互，而且它本身就只是个「点了就关」的 hack |
| 向上 / 向下弹、贴左 / 贴右、限高滚动 | 输入框在底部，菜单一律往上弹；条目多时能滚（`overscroll-behavior: contain`，滚到底不会把消息流带着滚） |
| `block` 非选项行 | 「先说清楚再给选项」的整段说明（权限菜单那段「无沙箱」） |

⚠️ 一个容易踩的坑：**打开时定位高亮的 `useEffect` 依赖里只能有 `open`**。
`entries` 是调用方每次渲染现拼的数组，把它放进依赖会变成「鼠标划过某项 → 重渲染 →
effect 又把高亮弹回第一项」，键盘和鼠标互相打架。

`@` 候选菜单**不用**这个组件：它必须由编辑器（ProseMirror）持有焦点与按键，
库或自定义浮层来抢焦点都会把输入框的键盘逻辑搞乱 —— 它的长相走 `.mention*` 那套 CSS。

### 预览面板：右侧可隐藏的报告 / 代码 / 图片视图

挖洞时 agent 会不停产出**报告（markdown）、PoC（代码）、抓包（文本）、截图（图片）**。
以前只能「用系统程序打开」，一开就是一个外部程序，来回切窗口反而打断思路。
这个面板把这些东西直接画在界面里，按类型分流渲染：

| 类型（主进程按扩展名判定） | 渲染方式 |
| --- | --- |
| `markdown`（`.md` / `.mdx`） | Streamdown —— 和对话正文同一套（`.sd` 作用域），排版天然一致 |
| `code`（`.ts` / `.py` / `.json`…） | Streamdown + `@streamdown/code`（Shiki 高亮，语言由主进程按扩展名给） |
| `image`（`png/jpg/gif/webp/svg`…） | data URL 的 `<img>`（下面那条 CSP 决定了必须走 data URL） |
| `text`（`.txt` / `.log` / `.csv`…） | 等宽 `<pre>` |
| `binary` / 超大 | 不硬撑：显示原因 + 「用系统程序打开」的出口 |

怎么用：

- 顶栏最右的 **▤** 开关面板；面板头部有「返回文件列表」和「用系统程序打开」。
- 点对话里**文件卡片的主体** → 面板自动展开并显示那个文件；点「打开」仍然走系统程序。
- 没选文件时显示**最近文件**：`recentFiles()` 倒着捞这次会话碰过的文件（路径去重，
  最近的在前）—— SRC 场景下最关心的永远是刚生成的那份。
- 换会话 / 换项目会清掉当前选中的文件（否则面板里挂着上一个项目的文件，看着像这次产出的）。

四条实现上的取舍：

- **读文件在主进程**（`IPC.previewRead` → `readForPreview()`）：扩展名判断、体积上限
  （文本 1MB / 图片 8MB）、相对路径按工作目录解析都在那边。渲染进程没有 `fs`，
  只按 `kind` 画。
- **图片必须走 data URL**：CSP 是 `default-src 'none'; img-src 'self' data:`，
  `file://` 不在白名单里 —— 想让 `<img>` 显示本地截图，只能把字节读出来做 data URL。
- **代码高亮用围栏包一层**再交给 Streamdown：围栏长度取「正文里最长反引号串 + 1」——
  PoC 脚本里出现 ``` 很常见，固定三个反引号会被提前闭合。
- **读取代际号**（`generation`）丢弃过期结果：快速连点两个文件时，先发的那次可能后回来。

### 轨迹视图：按角色分色的一条时间线

「轨迹」标签把会话摊平成 agent 做过的每一步（`traceSteps()`），重点不是好看，
而是**扫一眼就能分出谁在说话、哪一步开始跑偏**：

```
●─ 你     #1   run bash: echo packaged-ok
│            run bash: echo packaged-ok
●─ 推理   #2   （紫色斜体、默认更淡：思考过程读的人少，但要能跳过）
│            第 1 轮：先看看用户到底要什么…
●─ 工具   #3   bash
│            {"command":"echo packaged-ok"}    ← 等宽字体
●─ 助手   #4   第 1 轮结论：…                  ← 最亮的正文色
```

| 角色 | 节点图标（lucide） | 颜色 | 说明 |
| --- | --- | --- | --- |
| 你 | `user` | 蓝紫 `--ym-accent-text` | 与输入框、发送按钮同族 |
| 助手 | `messages-square` | 近白 | 「结果」用最亮的颜色 |
| 推理 | `brain` | 紫 + 斜体 | 读的人少，弱化但不丢 |
| 工具 | `wrench` / `square-terminal` | 青绿 + 等宽 | 与 `@tool` token 同色；`shell*` 用终端图标 |
| 提示 / 目标调整 | `info` / `target` | 琥珀 / 蓝紫 | 系统口吻，与用户输入区分 |
| 失败 | `circle-alert` | 红（压过角色色） | 整行淡红底 + 「失败」角标 |

两个细节：**超过 220 字的步骤默认折三行**，右上角「展开」按需展开（一份 200 行的报告
不该顶掉后面十几步）；竖线用 `::before` 画在轨道上，首行的线从节点中心开始、
末行的线到节点中心结束，线不出头。

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

#### 富文本输入框还要多一道：`view.composing`

Tiptap 的键盘回调在 ProseMirror 里，拿到的**不一定是真事件**。上面那三个信号建立在
「事件是浏览器派发的 KeyboardEvent」这个前提上，而 ProseMirror 会**自己合成**键事件：
`readDOMChange` 在「这次 DOM 变化看起来像是按了 Enter」时，用
`keyEvent(13, 'Enter')`（= `document.createEvent('Event')`）再走一遍 `handleKeyDown` 链。
那个事件里 **`isComposing` 根本不存在**（`'isComposing' in event === false`）、
`isTrusted === false`，只有 `keyCode === 13`。

输入法用回车确认候选词，正好会产生一次「新增段落」的 DOM 变化 —— 于是这个合成 Enter 打进来，
三个信号全部落空，半成品被当成消息发出去（实测踩到：日志里连一次 `compositionend` 都没有，
却收到了一个 `keyCode 13`）。所以 `composer.tsx` 的 `handleKeyDown` 第一句是：

```tsx
if (view.composing || ime.isImeKeyNative(event)) return false
```

`view.composing` 是 ProseMirror **自己**的组字状态，在这个时刻仍为 `true`，是唯一可靠的
判据。它不会带来新的风险：真事件在组字期间本来就被 ProseMirror 的 `inOrNearComposition`
挡在 `handleKeyDown` 之外（`editHandlers.keydown` 开头就 `return`），这一句补的正是
「合成事件绕过那道门」的洞。

用法：`const ime = useImeGuard()`，把 `ime.compositionProps` 展开到**外层容器**上
（组字事件会从 contenteditable 冒泡上来），然后在键盘处理的**第一句**写
`if (ime.isImeKeyNative(event.nativeEvent)) return`（原生回调直接传 `event`）。
富文本输入框（`composer.tsx`）与侧栏的模型输入框（`sidebar.tsx`）都挂上了 ——
后者不拦的话，浏览器会顺手提交那个 `<form>`，等于拿半截拼音去切模型。

**改这里时的自查**（用中文输入法真打一次最快）：组字中按回车**不能**发出消息、
组字刚结束那一次回车也**不能**、而普通回车**必须**能发出去。
第三条同样重要 —— 守卫写错会把回车彻底卡死。

> 用 CDP 的 `Input.imeSetComposition` 造组字来验时要注意：它不会发 `compositionend`，
> 而非 Android 上 ProseMirror 的组字状态**只由 `compositionend` 清除**
> （`timeoutComposition = android ? 5000 : -1`）。于是 `view.composing` 会一直是 `true`，
> 之后所有回车都不响应 —— 看着像守卫坏了，其实是测试手法不完整，刷新页面即可。


---

## 7. 打包：Electron Forge

```bash
npm run app:build        # 只生成 staging（build/app/），排查打包问题时用
npm run package          # → out/YuanMy Agent-darwin-arm64/YuanMy Agent.app
npm run make             # → out/make/…（zip + dmg）
```

（`package` / `make` 内部都是 `app:build` + `electron-forge <命令> build/app`。）

### 为什么要先搭一个 staging 目录，而不是直接打包仓库根

Forge 的 `package` 会把项目目录整个复制进 `app.asar`，再按 `package.json` 的生产依赖
做一次 prune。仓库根不满足它的两个隐含假设：

| 假设 | 这个仓库的现实 | 后果 |
| --- | --- | --- |
| `node_modules` 是**扁平**布局 | pnpm 是「符号链接 + `.pnpm` 同级解析」 | prune 的依赖遍历看不到那些边，**删掉还要用的包** |
| 依赖关系写在 `dependencies` | DSH 用 **`peerDependencies`** 装配内核 | prune 不认 peer，把半个内核装配线删掉 |

所以 `scripts/build-app.ts` 先物化一个**自包含目录** `build/app/`：

```
build/app/
  package.json          # 生成：main=desktop/main.ts + config.forge + 生产依赖 + electron 精确版本
  forge.config.ts       # 从 app/desktop/ 复制
  pnpm-workspace.yaml   # 复制 + nodeLinker: hoisted
  node_modules/         # pnpm install --prod（**扁平真实文件**，93MB）
  desktop/…             # main.ts / ipc.ts / preload.cjs / host/*.ts / renderer/{index.html,dist}
  cli/…  mcp/…          # host 运行时 import 的 CLI 与会内置 MCP 服务器
```

目录结构照抄 `app/desktop/`：`main.ts` 里所有资源路径都是
`new URL('./xxx', import.meta.url)`，布局不变，主进程代码一行都不用改。

### 打包形态下内核怎么跑：**不依赖系统 Node**

`main.ts` 的 `resolveHostRuntime()` 分三种情形：

| 情形 | 用什么 |
| --- | --- |
| `YuanMy_NODE_BIN` 显式指定 | 照用（逃生口） |
| **打包后** | **App 自带的那颗 Electron 二进制** + `ELECTRON_RUN_AS_NODE=1` |
| 开发时 | npm/pnpm 注入的 node，退回 PATH（现状不变） |

Electron 44 自带的 Node 是 **24.21**（与开发机一致），`--experimental-strip-types` 照旧可用，
所以 host 仍然是「直接跑 `.ts`、不构建」。实测（`PATH` 里连 `node` 都没有）：

```
$ env PATH=/usr/bin:/bin "out/…/YuanMy Agent.app/Contents/MacOS/YuanMy Agent"
→ 界面「就绪」，跑一轮 bash 工具调用 → echo no-node-needed ✓
```

MCP 子进程也是 `process.execPath` 拉起的（`app/cli/kernel.ts` 的 `availableMcpSpecs`），
所以 `ELECTRON_RUN_AS_NODE` 必须一路传下去：它通常能靠 scrubbed parent env 自动继承
（名字不匹配敏感词规则），但那里**显式兜底**了一份 —— 不传的后果是子进程以 GUI 身份启动，
不报错也不干活，只在 Dock 里多一个图标。

⚠️ 这条链路决定了 `forge.config.ts` 里 **`FuseV1Options.RunAsNode` 必须保持 `true`**
（Forge 模板默认关掉它）。关掉的表现是「窗口能开、agent 永远不可用」。

### 四个踩过的坑（都是**静默失效**型）

1. **`asarUnpack` 在这里不存在。** 那是 electron-builder 的键名；`@electron/packager`
   只认 **`asar.unpack`**（glob 字符串）。写错的后果是它被原样忽略、只有
   `AutoUnpackNativesPlugin` 兜住了 `.node`：
   - `sharp` 的 `libvips-cpp.*.dylib`（**只有 .dylib、没有 .node**）留在 asar 里 →
     `Library not loaded: @rpath/libvips-cpp.8.18.6.dylib`；
   - `node-pty` 的 `spawn-helper`（**没有 .node 后缀的可执行文件**）留在 asar 里。
2. **Forge 的 prune 不认 `peerDependencies`。** 现象：打包一路 ✔，启动后
   `Cannot find package '@deepseek-ai/dsh-credentials' imported from …/app.asar/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`。
   已用 `prune: false` 关掉（staging 本来就是按需物化的，没有开发依赖可删）。
3. **staging 目录必须自己声明「我是 Forge 项目」。** Forge 的 `resolveDir()` 从目标目录
   逐级**向上**找标记（`config.forge` / `devDependencies['@electron-forge/cli']`），
   staging 一个都不占时会一路找到**仓库根**，然后把仓库当成要打包的项目 ——
   报错却是 `Failed to locate module "@standard-schema/spec" from …/YuanMy/node_modules/…`，
   完全不提「项目目录认错了」。所以生成的 `package.json` 里写了
   `config: { forge: './forge.config.ts' }`，并保留 `devDependencies.electron`（精确版本，
   它同时是 `getElectronVersion()` 的数据源）。
4. **别在块注释里写裸 glob。** `**` + `/` + `*` 这种字面量会**提前结束块注释**，
   报出来的是莫名其妙的 `Unexpected token '.'`。`build-app.ts` 里为此加了一条
   `node --check forge.config.ts` 的语法自检（Forge 自己的报错不给行号）。

另外两条小的：`devDependencies.electron` 只是给 Forge 看版本号，**不用真装** ——
但 Forge 的依赖遍历要求声明的包**物理存在**，而它的向上查找循环
（`dirname(dirname(testPath))`）会跳过仓库根，所以 staging 里放了一个只有
`package.json` 的占位包（prune 关掉后它会留在 asar 里，1KB，无害）。

### 产物与签名

```
out/YuanMy Agent-darwin-arm64/YuanMy Agent.app      # 未压缩的 .app（约 395MB）
out/make/YuanMy Agent-0.1.0-arm64.dmg               # 146MB，拖进 Applications
out/make/zip/darwin/arm64/YuanMy Agent-…-0.1.0.zip  # .app 的压缩包（自动更新要的形态）
```

`out/` 与 `build/` 都在 `.gitignore` 里。

**没有做开发者签名与公证**（需要 Apple Developer 证书）：产物是 **ad-hoc 签名**的
（Apple Silicon 上必须如此，否则连本机都跑不起来），本机双击可以开；拷到别的机器会被
Gatekeeper 拦，需要「右键 → 打开」或 `xattr -dr com.apple.quarantine`。要正式分发就得加
`packagerConfig.osxSign` + `osxNotarize`，以及一枚 Developer ID 证书。

---


## 8. 已知限制与下一步

- **不能打包**：目前只有开发态运行。出安装包需要补 `electron-builder` 配置与签名，
  可参考 DSH 的 `apps/desktop`（它的做法是把整个运行时打进 asar）。
- **bundle 偏大（~10 MB）**：见第 1 节的说明与两条瘦身路线（去 code 插件 / 换 `app://` 协议）。
- **多会话有成本**：现在每个「切走但还在跑」的会话都是一个独立内核子进程。
  空闲的会在切换时立刻回收，同时最多 6 个（超了会明确告知用户哪个后台任务被中断）。
  真要做「几十个会话常驻」得换成更轻的形态（例如内核里支持会话切换，而不是一进程一会话）。
  （挂回一个还活着的内核 < 1s 且不重启；重启 + 历史可见 ≈ 300ms~1s，见「多会话」一节。）
- **跨项目列表靠一份「最近打开过」的登记**（不是靠共享会话库）：内核 `stateDir`
  默认 `<cwd>/.YuanMy`，每个项目一份库，所以桌面端维护
  `<userData>/projects.json` 并在启动 host 时把清单交过去，由 host 多扫几个根。
  代价与边界见「项目树为什么能跨项目」一节：项目要**被打开过一次**才会进登记，
  登记最多 20 条、单次最多多扫 8 个根。
- **输入框是「纯文本 + chip」，不是排版编辑器**：Markdown 语法、加粗、列表都没有
  （理由见「编辑器扩展集：刻意做小」—— 输入规则会和 `#` 触发符打架）。
  Enter 发送、Shift+Enter 换行、Cmd+Enter 也是换行（Tiptap 的 `Mod-Enter` 默认绑定，
  我们没抢它）。要加富文本能力，记得同时想清楚它的**输入规则**会不会和 `/` `@` `#` 冲突。
- **没有附件 / 图片**：`dsh-attachment-local` 已经在内核里挂好了，
  补一条「把文件路径塞进用户消息」的协议字段就能用起来。
- **代码块没有「复制」按钮与行号**：Streamdown 支持，但需要在
  `markdown.tsx` 里补自定义 renderer。
- **Windows / Linux 未验证**：磨砂玻璃、`titleBarOverlay`、菜单角色都按平台分了支，
  但只在 macOS 上跑过。
  Linux 保留原生标题栏（否则没有关闭按钮），代码块与磨砂玻璃会自动退回不透明样式
  （`html[data-vibrancy="none"]` 下主区保持原来的不透明淡紫黑）。
