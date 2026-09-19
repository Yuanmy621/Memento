---
name: yuanmy-desktop-ui
description: 改 YuanMy 桌面端界面时的固定套路 —— 渲染进程为什么要重新构建、加一个界面动作/UI 帧要动哪几个文件、Streamdown 的 Tailwind token 为什么必须补、布局失控与输入法组字这两个已修 bug 的复现条件。当你要改 app/desktop/renderer 下的界面、加按钮/面板/消息类型、调主题配色、或者排查界面样式错乱与卡顿时使用。
---

# 改 YuanMy 桌面端界面

## 先记住：渲染进程需要构建

界面源码是 **TSX**（`app/desktop/renderer/src/`），由 esbuild + Tailwind 打成
`renderer/dist/renderer.js`（IIFE）与 `renderer.css`。改了源码**必须重新构建**：

```bash
npm run build:renderer     # 一次性；`npm run desktop` 会自动带上
npm run desktop:watch      # 改界面时开着它
```

忘了构建的表现是「改了源码但界面没变」——先跑一次 `npm run build:renderer` 再判断。

主进程（`main.js`）与 host（`host/*.ts`）**不需要**构建。

## 加一个界面动作：四步，缺一不可

以「切换主题」这种动作为例：

1. `app/desktop/ipc.js` —— 往 `IPC` 表加频道名；
2. `app/desktop/main.js` —— 加 `ipcMain.handle(IPC.xxx, (event) => { assertSender(event); … })`；
3. `app/desktop/preload.js` —— 在 `CHANNEL` 与 `api` 里**各加一条**
   （沙箱化 preload 不能 require 本地文件，频道字面量只能重复一份）；
4. `renderer/src/` —— 通过 `window.YuanMy.xxx()` 调用。

这三处的频道名/方法名必须逐字一致：`ipc.js` ↔ `preload.js` ↔ 渲染进程的调用。
改漏了不会报错，只会**静默失效**（界面点了没反应），所以要逐个核对。

**加一种内核事件到界面**是另一条链路：

1. `host/protocol.ts` 的 `HostEvent` 加分支（顺手更新 `isHostEvent`）；
2. `host/bridge.ts` 在对应事件里 `this.send({...})`；
3. `renderer/src/use-agent.ts` 的归约器加 `case`（这是唯一把事件变成界面状态的地方）；
4. `renderer/src/components/*.tsx` 里渲染；`message.tsx` 负责消息条目内的排布。

**加完自己点一遍**：`npm run desktop` 起来，把新加的东西真操作一次
（这个仓库现在没有自动化测试，所以手工验证是唯一的关口）。

## Streamdown 的样式：缺 token 会静默消失

Markdown 由 Streamdown 渲染，它内部用的是 **shadcn 那套 token 名**
（`bg-muted`、`text-muted-foreground`、`border-border`、`text-primary`…）。
Tailwind **只为已定义的 token 生成工具类**，缺了会被静默丢掉——表现是行内代码、链接、
表格描边突然没样式，看着像「Streamdown 没生效」。所以 `styles/app.css` 的 `@theme` 里
把这一整套别名都映射到了项目色板。**改配色时别删这些别名。**

组件里不要堆 Tailwind 工具类：Tailwind 是给 Streamdown 用的，自己的组件用语义类
（`.sidebar` / `.tool-card` / `.tokenbar` …）。要加类就写在 `styles/app.css`。

## 工作台布局与「哪些控件是真的」

主区顶部是**标签栏**（`对话` / `轨迹`），侧栏是「工作区 + 搜索 + 项目树」，
输入区有一排控件 + 下方会话统计。改这块时注意三件事：

1. **权限下拉是如实显示，不是可选项**。YuanMy 的本地 provider 无沙箱无审批，
   给一个假的「只读/可写/完全访问」选择器会让人以为有沙箱 —— **别把它做成能选的**。
2. **模型下拉 = 内核目录 ∩ 本地白名单**。选项来自 `ready.info.models`
   （host 侧 `listModels()` 读 `ctx.llm.listModels` 后按 `SUPPORTED_MODELS` 过滤），
   **不要**在前端写死；白名单在 `app/cli/options.ts`，同时是 `--model` 的默认值来源。
   适配器申报 4 款，只暴露 `deepseek-v4-flash` / `deepseek-v4-pro`。
   ⚠️ 默认模型必须落在白名单里，否则下拉框显示不出自己的当前值（有断言盯着）。
3. **统计数字各有来源**：token 来自 `usage` 帧（互斥计数，见下），耗时来自
   `turn-end.durationMs`（host 量的墙钟），轮次是归约器计数。别在前端估算。

文件卡片由 `fileActionOf()` 从工具名 + 参数认出；「打开」走主进程 `shell.openPath`。
轨迹视图走 `traceSteps()` 纯函数把 `state.items` 摊平 —— 这两个都是纯函数，
改动后自己走一遍：打开一个带工具调用的回合，确认文件卡片与轨迹两步都对得上。

## 视觉一律走官方令牌，别写死颜色

配色 / 圆角 / 字号 / 动效对齐官方 DSH 桌面端，并且**沿用了它的令牌名**（`--dsw-*`）：

| 要什么 | 用什么 |
| --- | --- |
| 底色 / 层次 | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1..3` |
| 文字三级 | `--dsw-alias-label-primary/secondary/tertiary/caption` |
| 描边四级 | `--dsw-alias-border-l1..l4`（大量用 **0.5px**） |
| 悬停 / 按下 | `--dsw-alias-interactive-bg-hover` / `-active` |
| 侧栏 | `--dsw-specific-sidebar-fill`、`-nav-item-hover`、`-nav-item-active` |
| 状态色 | `--dsw-alias-state-success/error/warn-primary`、`--dsh-state-ongoing`（运行中） |
| 圆角 / 高度 | 按钮 sm 28px/圆角 14px，气泡 22px，胶囊 24px，输入卡 12px |
| 版面轴 | `--dsh-chat-content-width`(748px)、`--dsh-content-font-size`(14px)、`--dsh-chat-flow-gap`(16px) |

令牌值来源是 `packages/client/ui-theme/src/styles/design-platform.css`（暗色主题分支）
与 `base.css` / `scrollbar.css`；构件规格在 `ui-primitives` 与 `ui-chat` 的 `.module.css`。
**改配色不要去组件里写死 hex**：一律引用这些令牌，否则主题一改就散架。
自查：全仓 `grep -nE '#[0-9a-fA-F]{3,6}' app/desktop/renderer/src` 应该没有结果。

两个反直觉但很重要的点：

- 主按钮是**近白填充 + 深色字**（`rgb(249,250,251)` / `rgb(15,17,21)`），不是彩色；
- `body` 在磨砂玻璃开启时**必须是透明的**（`html[data-vibrancy="native"]`），
  否则系统材质被盖住、侧栏不透；底色要量真正刷底的 `.app-shell`。

## 侧栏的树必须「看得出来」是树

侧栏是「项目 → 会话」两级树。**DOM 嵌套对了不等于看起来是树** —— 被反馈过一次：
项目名在 37px、会话标题只到 44px（差 7px），加上 8% 白的竖线，整块读起来就是一条平铺列表。

三条一起改才有层级感（`styles/app.css`）：

- **缩进要够**：`.session-list--child` 是 `margin-left: 24px + padding-left: 8px`，
  会话文字落在 ~54px，比项目名（~37px）右 17px。改完自己在窗口里看一眼，
  确认两级仍然一眼能分开（差 7px 那种就是没分开）；
- **竖线要看得见**：`border-left: 1px var(--color-line-strong)`（16% 白，不是 8% 的 line）；
- **层级也靠字体**：项目名 13px/600，会话 12px/400 且用 muted 色，别只依赖缩进。

另外项目行**不要**加整圈描边：描边会让它看起来和下面的会话是同级条目（现在只有淡底 + 左侧竖标）。

### 当前项高亮：别再用「贴边硬竖条」

被反馈过一次「高光太过生硬」。当时是 `inset 2px 0 0` 贯穿整行的硬竖条 + 文字跳到纯白 +
比 hover 深两档的底色 —— 竖条像描边，底色是跳变。现在拆成三层轻量信号：

| 层 | 做法 |
| --- | --- |
| 形状 | `.session--current::before` 画 **2×14px 圆角药丸**，`left: 3px` 内缩、垂直居中 |
| 字重 | `font-weight: 500`（让文字色不必从 secondary 跳到纯白） |
| 底色 | `--ym-nav-current-fill`（`bluish-800`，只比 hover 的 850 深一档） |

四档底色是设计意图：侧栏底 `900` < 当前项目 `875` < hover `850` < **当前会话 `800`**。
当前项目**不用**药丸（它是容器，两层都用竖标会像重影）。

⚠️ 高亮规则的选择器权重高于通用 `:hover`，**必须显式补** `.session--current:hover`
与 `.project-node--current … :hover`，否则当前项悬停没反应、像「死了」。
自查：改完在真窗口里看一眼（`npm run desktop`），确认底色是「托起来」而不是「描边」。

## 界面视觉问题要在真窗口里看，别靠猜

间距/层级/配色这类问题**看代码是判断不了的**，必须 `npm run desktop` 起来真看一眼。
（这个仓库不再带自动截图/探针，所以「看一眼」是唯一手段。）

需要把主观的「不好看」变成可判断的东西时，可以在 DevTools 控制台里量：

```js
getComputedStyle(document.querySelector('.session--current')).backgroundColor
document.querySelector('.session__title').getBoundingClientRect().left
```

**改界面时开着 `npm run desktop:watch`**，改完刷新窗口即可，不用重启。

## 恢复会话 / 切换会话：历史由 host 回放

点侧栏里的会话 = `--resume <id>` **重启内核**。要点：

- 内核恢复的是 agent 的上下文，**界面这边还是空的** —— 记录由 host 读日志发 `history` 帧
  （`host/history.ts`），渲染进程**整段替换** `items`（不是追加，否则和实时帧重复）；
- 实时路径（`bridge.ts`）与回放路径共用 `protocol.ts` 的词表和 `toOutcome()`。
  **改回合结论的映射只能改这一处**，否则同一个回合刷新前后会显示成不同结果；
- 回放要过滤 `source.kind === 'skill-catalog'` 的 `user/message`（那是注入给模型看的技能目录，
  不是用户消息）；`turn/end` 没有助手消息时补一条「没有产生输出」的提示；
- **换 cwd 不等于要丢掉 resume**：`restartWith()` 早先只要 cwd 变了就无条件清 `resume`，
  于是点别的项目下的会话会用**全新会话**启动（界面空白）——这正是用户报的
  「切换工作区中的会话后读不到历史」。判据是「调用方有没有明确要求恢复」，不是「cwd 变没变」；
- **重启后要补读已展开项目的会话**：`restarting` 清空 `projectSessions`，但
  `expandedProjects` 是组件 state 不跟着清 → 之前展开的项目变成空列表。
  `sidebar.tsx` 里那个 effect 负责补读（按「内核代次」记账，避免读失败后无限重试）。

## 侧栏是懒加载的树

侧栏是「项目 → 会话」两级树，数据**分两批**来：`workspace` 帧给项目清单 + **当前项目**的会话；
折叠的项目被点开时才发 `list-project-sessions` 去读那个项目（`project-sessions` 帧回来）。
改这块时注意：别把「所有项目的会话」塞进 `workspace` 帧 —— 那会让首屏随项目数变慢，
也会让首屏随项目数变慢（这是当初分两批读的全部理由）。

### 跨项目列表：会话库每项目一份，所以要扫多个根

⚠️ 内核 `stateDir` 默认 `<cwd>/.YuanMy` → **每个项目一份会话库**，项目之间互相看不见。
只扫当前项目那一个根，侧栏的树里就永远只有**一个**项目（换项目后上一个直接消失）。
现在靠一份线索补齐，**数据位置不动**：

- `main.js` 维护 `<userData>/projects.json`（`YuanMy_PROJECTS_FILE` 可覆盖），
  host 成功启动后登记当前项目；
- 启动 host 时用环境变量 `YuanMy_PROJECT_ROOTS`（冒号分隔）把清单交过去；
- `sessions.ts` 的 `rootsOf()` 把「当前项目的库 + 每个项目的 `<path>/.YuanMy/sessions`」
  拼成要扫的根，`locateProjects()` 逐根扫并**按 cwd 去重、先扫的根优先**；
- `rootsOf` 同时供 `listWorkspaceSessions` 与 `listProjectSessions` 使用 ——
  **两处必须一致**，否则会出现「列出来的项目点开是读不到」。

边界：登记最多 20 条、单次最多多扫 8 个根（`DEFAULT_MAX_EXTRA_PROJECTS`）；
路径被删、库不存在都只是跳过，**读写失败绝不影响启动**（顶多少列一个项目）。
没被 YuanMy 打开过的项目不会出现在树里。

## 两个已修的 bug —— 改布局/输入框前先看

### 布局失控（症状：展开推理后侧栏「样式变了」并卡死）

`.app-shell` 必须写 `grid-template-rows: minmax(0, 1fr)`，且 `.main-column` / `.messages`
要有 `min-height: 0`。只写 `height: 100%` 时 grid 行是隐式 `auto`，会被内容撑高：
侧栏被拉到和内容一样高（实测 800→1723px，底部内容顶出可视区），`.messages` 失去内部滚动，
长内容直接把渲染进程卡死。超长不可断片段用 `overflow-wrap: anywhere`（`break-word`
不参与 min-content 计算，仍可能撑开）。**改完务必展开一段长推理手动确认**：
外壳高度不该超过视口，滚动条应该在 `.messages` 内部。

### 输入法组字（症状：中文打词按回车就把半成品发出去）

`renderer/src/composition.ts` 的守卫必须放在 `onKeyDown` 的**第一句**：

```tsx
onKeyDown={(event) => {
  if (ime.isImeKey(event)) return      // ← 必须是第一句
  if (event.key === 'Enter' && !event.shiftKey) submit()
}}
```

判定用三个信号（`isComposing` / `keyCode 229` / `compositionend` 后的临时标记），
细节见该文件注释。**不要**改成持久标志位：`compositionend` 不触发时会永久卡住，
表现是回车彻底发不出去。表单里的输入框（如侧栏模型输入）也要挂，否则组字回车会提交表单。

## 改完怎么验

```bash
npm run build:renderer     # 或者一直开着 npm run desktop:watch
npm run typecheck          # 三个项目：Node 侧 TS + 渲染进程 TSX + Node 侧 JS
npm run desktop            # 真开窗口，把改的地方操作一遍
```

**没有自动化测试**，所以「操作一遍」要具体：改侧栏就跑一次会话切换、
改输入框就用中文输入法打一个词、改布局就展开一段长推理。

`app/desktop/README.md` 里有每个子系统的设计说明与坑。
