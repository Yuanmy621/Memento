---
name: Memento-desktop-ui
description: 改 Memento 桌面端界面时的固定套路 —— 渲染进程为什么要重新构建、加一个界面动作/UI 帧要动哪几个文件、Streamdown 的 Tailwind token 为什么必须补、布局失控与输入法组字这两个已修 bug 的复现条件。当你要改 app/desktop/renderer 下的界面、加按钮/面板/消息类型、调主题配色、或者排查界面样式错乱与卡顿时使用。
# 默认保持 Agent 纯净：命令专用，不进模型的会话技能目录；用 /名字 显式加载。
disable-model-invocation: true
---

# 改 Memento 桌面端界面

## 客户端全是 TypeScript，但 preload 必须构建

`app/desktop/**` 下**没有手写的 `.js`**。谁擦类型：

| 文件 | 谁执行 | 要不要构建 |
| --- | --- | --- |
| `main.ts` / `ipc.ts` / `host/*.ts` / `scripts/*.ts` | Electron 自带的 Node 24 / 系统 node | 不要（默认开类型擦除，直接跑 `.ts`） |
| `preload.ts` | Electron 的**沙箱** preload 加载器 | **要**：打成自包含的 `preload.cjs`（由 `build-renderer.ts` 顺带做） |
| `renderer/src/*.tsx` | 浏览器 | 要（esbuild + Tailwind） |

⚠️ **别把 `webPreferences.preload` 指到 `preload.ts`**：沙箱 preload 走 Electron 自己的
CJS 加载器，不认识 TS —— 它**静默失败**，界面只会说「preload 脚本没有加载」。
实测：同一个文件指 `.ts` 时 `window.probe === null`，指构建出来的 `.cjs` 时正常。
产物必须 CJS 的另一个原因：Electron 加载 preload 时忽略 `"type": "module"`。

唯一保留 `.js` 的是 `app/opencli/**`（opencli 只发现 `.js`，见该目录 README），
归属单独放在 `tsconfig.js.json`。

## 界面底座是 Beautiful UI（vendored，MIT）

**当前状态（已迁移完成）**：令牌全部来自 foundation；构件用它的
`Button/EntityChip/ValuePill/Shimmer`（atoms）与
`ToolChips/CodeBlock/LoadingState`（primitives）；
Tiptap 与 Streamdown 只换外壳；思考块 / 轨迹时间线 / 刻度尺 / 浮层菜单 / 柱面粒子是自研。
下面四条是改这块时必须记住的：

界面构件来自 <https://www.beautifului.dev/>（MIT）：源码在
`app/desktop/renderer/src/ui/beautifului/`（`foundation.css` + `atoms/` + `primitives/`），
接法、三处坑与分阶段迁移表都在 `app/desktop/README.md` 的「5.5 界面底座」一节。
动手前记住四条：

1. **改样式先看令牌**：`bg-page` / `text-ink-2` / `rounded-window` / `shadow-card` 这些类来自
   foundation 的 `@theme inline`，不要自己写死颜色；品牌色是 `--accent`（我们换成了蓝紫）。
2. **`foundation.css` 括号不配平**（上游 bug）：Tailwind 遇到它会**整份丢掉并且不报错** ——
   改完 foundation 一定要数一次括号，并在真窗口里确认 `--page` 这类令牌还在。
3. **`--color-accent` 撞名**：全局是 Beautiful UI 的品牌语义，Streamdown 的 `.sd` 作用域里才是
   shadcn 的 hover 底。加新样式时别在 `.sd` 里用 `bg-accent` 当品牌色。
4. **Tiptap 与 Streamdown 不换**（只换外壳）；刻度尺 / 浮层菜单 / 柱面粒子上游没有对应物，继续自研。
   ⚠️ **删 CSS 只按选择器删，别按行区间删**，删完必须跑 `npm run audit:css`：
   这个仓库踩过一次「按区间删轨迹样式，连带删掉菜单/提及/统计/token/chip 的活样式」——
   编译与类型检查都不报错，只有界面没样式。
5. **上游有一批构件是「展示件」不是可嵌组件**（`PromptBar` 自带 textarea + 自播放 walkthrough + glimm 扫光；
   `ChatComposer` 是整块消息列表 demo；`SidebarNav` 是扁平 recents；`ToolChips` 内建演示时序）。
   前三个只取**样式/结构**，`ToolChips` 用 vendored 补丁的 `live`/`compact`/`preview` 改成数据驱动；
   `ThinkingState`（推理）与 `TaskRows`（轨迹）**已经删掉换成自研**（`components/reasoning.tsx` /
   `components/trace.tsx`）—— 取舍表与原因在 README「5.5 界面底座」里。

## 先记住：渲染进程需要构建

界面源码是 **TSX**（`app/desktop/renderer/src/`），由 esbuild + Tailwind 打成
`renderer/dist/renderer.js`（IIFE）与 `renderer.css`。改了源码**必须重新构建**：

```bash
npm run build:renderer     # 一次性；`npm run desktop` 会自动带上
npm run desktop:watch      # 改界面时开着它
```

忘了构建的表现是「改了源码但界面没变」——先跑一次 `npm run build:renderer` 再判断。

主进程（`main.ts`）与 host（`host/*.ts`）**不需要**构建。

## 加一个界面动作：四步，缺一不可

以「切换主题」这种动作为例：

1. `app/desktop/ipc.ts` —— 往 `IPC` 表加频道名；
2. `app/desktop/main.ts` —— 加 `ipcMain.handle(IPC.xxx, (event) => { assertSender(event); … })`；
3. `app/desktop/preload.cjs` —— 在 `CHANNEL` 与 `api` 里**各加一条**
   （沙箱化 preload 不能 require 本地文件，频道字面量只能重复一份）；
4. `renderer/src/` —— 通过 `window.Memento.xxx()` 调用。

这三处的频道名/方法名必须逐字一致：`ipc.ts` ↔ `preload.cjs` ↔ 渲染进程的调用。
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
（`.sidebar` / `.composer__box` / `.session` …）。要加类就写在 `styles/app.css`。

## 工作台布局与「哪些控件是真的」

主区顶部是**标签栏**（`对话` / `轨迹`），侧栏是「工作区 + 搜索 + 项目树」，
输入区有一排控件 + 下方会话统计。改这块时注意三件事：

1. **权限下拉是如实显示，不是可选项**。Memento 的本地 provider 无沙箱无审批，
   给一个假的「只读/可写/完全访问」选择器会让人以为有沙箱 —— **别把它做成能选的**。
2. **模型下拉 = 内核目录 ∩ 本地白名单**。选项来自 `ready.info.models`
   （host 侧 `listModels()` 读 `ctx.llm.listModels` 后按 `SUPPORTED_MODELS` 过滤），
   **不要**在前端写死；白名单在 `app/cli/options.ts`，同时是 `--model` 的默认值来源。
   适配器申报 4 款，只暴露 `deepseek-v4-flash` / `deepseek-v4-pro`。
   ⚠️ 默认模型必须落在白名单里，否则下拉框显示不出自己的当前值（有断言盯着）。
3. **统计数字各有来源**：token 来自 `usage` 帧（互斥计数，见下），耗时来自
   `turn-end.durationMs`（host 量的墙钟），轮次是归约器计数。别在前端估算。

文件卡片由 `fileActionOf()` 从工具名 + 参数认出：**点卡片主体 = 右侧预览面板看内容**
（`IPC.previewRead`），点「打开」= 主进程 `shell.openPath`。轨迹视图走 `traceSteps()`
纯函数把 `state.items` 摊平（每步给 `label` / `token` / `preview` / `detail` 四样），
`components/trace.tsx` 画成时间线：状态靠**圆点颜色**（`.trace__dot--done/--running/--failed`），
不要徽章与药丸。这几处都是纯函数，改动后自己走一遍：打开一个带工具调用的回合，
确认工具行、预览面板、轨迹三步都对得上。

### `@` 菜单：中文功能名 + 通用菜单组件

`@` 弹出的 MCP 候选显示**中文功能名**（`renderer/src/tool-names.ts` 一张纯表 + 兜底规则），
**发给模型的东西一个字没变**（chip 的 `label` 是中文功能名、`text` 仍是
`用 mcp__<server>__<tool> 工具：`，见 `editor/chip-text.ts`）。

- 认不出来的工具（用户自己挂的 server）**不编中文名**：显示 `MCP · <server id>` + 原名，
  说明只在服务端给了中文描述时才有（英文 description 不显示，避免中英混排）。
- 顺序由 `toolOrder()` 定（项目大厅 → 排行 → …），不这么排会变成英文字母序。
- 菜单本身是 `components/menu.tsx`：键盘（↑↓/Home/End/Enter/Esc，Esc 把焦点还给触发器）、
  `role=menu` + `aria-haspopup/expanded`、`pointerdown` 点外关掉（**不用整屏遮罩**）、
  向上/向下弹、限高滚动。输入框三个下拉共用它。
- ⚠️ 打开时定位高亮的 `useEffect` **依赖里只能有 `open`**：`entries` 是每次渲染现拼的数组，
  放进依赖会「鼠标划过 → 重渲染 → 高亮弹回第一项」，键盘和鼠标打架。
- `@` 候选菜单**不能用**这个组件（也不能换 Radix/cmdk）：它必须由 ProseMirror 持有焦点与按键。
- 有尺子时消息区**不画系统滚动条**（`.main-column--rail .messages`），位置交给尺子；
  只对对话面板生效，轨迹面板仍保留滚动条。别把 `overflow-y` 一起改了 —— 去掉的只是可见的条。
- 顺带一条容易忽略的：`/` 菜单的技能组**只列全局技能**（`invocation === 'global'`）。
  命令专用技能（`disable-model-invocation`，如 `report` / `ip-as-logo`）插进来会落成
  「用 skill 工具加载 …」，而内核的 skill 工具明确拒绝这类技能 —— 它们的入口是 `/命令`。

### 左下角底栏：只有状态 / 设置 / 版本

按需求「左下角不展示工具、刷新」把这两处连同代码一起删了：工具清单（原来的就地 `<ul>`、
后来的 `ToolMenu` 菜单）与「刷新」按钮都已移除，底栏只剩状态点 + 设置 + 版本号。
⚠️ 但 **`refreshSessions` 这条链路要留着**：`use-agent.ts` 启动时会主动拉一次清单
（首帧推送丢了也能自愈），删了侧栏会永远是空的 —— 删掉的只是 hook 对外导出的那个动作。

### 右侧两个新构件：会话刻度尺 + 预览面板

| 构件 | 文件 | 一句话 |
| --- | --- | --- |
| 会话刻度尺 | `components/message-rail.tsx` + `message-rail-model.ts`（纯逻辑） | 一竖排**等距**短横线（14×2px），当前那条是**白色长横条**（30×3px）；滚轮/点击/拖动都能选，滚消息时尺子自动跟着滑 |
| 预览面板 | `components/preview-panel.tsx` | 右侧可隐藏的一列：markdown→Streamdown、代码→Streamdown+Shiki、图片→data URL、文本→`<pre>`；没选文件时列「最近文件」 |

改这两个时最该记住的四条（都是实测踩出来的）：

1. **刻度必须等距**，别按内容长度成比例（第一版按比例画，一条巨长的工具输出占掉
   半把尺子，「第几条」根本数不清）。内容高度只用来算「当前读到第几条」。
   而「当前是哪一条」= **屏幕上最后那条可见的条目**（判定线在视口**底边**往上 8px）：
   用顶边的话，滚到会话末尾时高亮会停在屏幕中间某条。这条规则也决定了跳转落点
   （`jumpTop()`：矮条目让底边贴判定线），否则「点第 10 条、高亮跑到第 13 条」。
2. **选中项更新要同步**（不欠 rAF 的债）：窗口被遮挡时 rAF 会被暂停，
   那时「尺子不动」会被当成坏了。只有**重新测量**（几百个 `getBoundingClientRect`）
   才交给 rAF 合并。
3. **别用 `setPointerCapture` 处理尺子上的点击**：捕获会让随后的 `click` 派发到轨道
   而不是刻度上，表现成「点了刻度却滚到鼠标位置居中处」。捕获只在拖动时用，
   且监听挂 `window`。
4. **图片预览只能走 data URL**：CSP 是 `img-src 'self' data:`，`file://` 不在白名单；
   代码高亮要**自己包一层围栏**再交给 Streamdown，围栏长度取「正文里最长反引号串 + 1」。
5. **悬停提示必须渐隐**（否则信息一直挂在界面上碍眼）：React 一卸载节点过渡就没了，
   所以拆成两份状态 —— `tipVisible` 先置 false 让 CSS 淡出，`TIP_FADE`(160ms) 之后再
   `setHover(null)` 卸载；出现用 `animation`（挂载时一定会跑）、消失用 `transition`。
   leave 挂在**刻度**上（不是整条尺子），划到相邻刻度时 enter 撤掉定时器即可不闪。
   ⚠️ 关键帧与 `--out` 里的 `transform` 都要带上 `translateY(-50%)`（那是居中定位），
   漏掉的话提示框会一边淡出一边往下跳半格。

预览面板的「最近文件」来自 `recentFiles()`（倒着捞会话里出现过的文件、路径去重）；
换会话/项目会清掉当前选中项（否则面板里挂着上一个项目的文件）。

## 输入框：Tiptap 富文本 + 触发符 chip + 「中途调整目标」

输入框是 **Tiptap（ProseMirror）**，不是 textarea：`/` `@` `#` 选中的东西插成 **chip**
（带底色的内联原子节点）。相关文件都在 `components/editor/`：

| 文件 | 管什么 |
| --- | --- |
| `kit.ts` | 扩展集（刻意做小：**没有**标题/列表/引用/加粗，理由见下） |
| `chip.ts` | chip 节点（`atom: true`，`contenteditable="false"`，`class="chip chip--命令/tool/skill/file"`） |
| `chip-text.ts` | 四种 chip 各自「显示什么 / 落库什么」（纯逻辑，只 import 类型） |
| `doc-text.ts` | **唯一的**序列化：文档 → 纯文本（纯逻辑） |
| `triggers.ts` | `/` `@` `#` 的允许规则（纯逻辑） |
| `suggestions.ts` | 三个 Tiptap suggestion 插件 + `SuggestController`（菜单状态机） |

改输入框时记住这几条，都容易被改回去：

1. **不要用 `state.busy` 去禁用输入框**。回合进行中输入框必须可用：Enter 在空闲时是
   发一轮，在生成中是**纠偏**（`steer`，内核在下一个 step 边界消费）。
   禁用它是被明确否掉的行为（用户要先按停止再重发，等于白扔已跑出的进度）。
2. **键盘只有一条路径，在 `composer.tsx` 的 `editorProps.handleKeyDown` 里**，顺序是
   「输入法 → 菜单 → 提交/中断」。ProseMirror 取 `handleKeyDown` 是**先 view props、后插件**
   （`EditorView.someProp` 先查 `_props`），所以这个顺序是确定的；不要在插件的
   `render().onKeyDown` 里再处理半截键。
3. **`editorProps` 与扩展只在首帧建一次**：里面要用的数据（命令/技能/工具/文件）、回调、
   `state.busy` 一律走 ref（composer 里的 `sourceRef` / `actionsRef`），直接闭包会永远停在
   首帧的值上 —— 表现是「内核启动后加载出来的命令表进不了菜单」「回合中按 Enter 不纠偏」。
4. **菜单项的选中用 `onMouseDown`**（不是 `onClick`）—— 否则编辑器先失焦、光标位置丢失。
5. **不要用 `editor.getText()`**：chip 是 atom、没有文本，`getText()` 会把它整个丢掉
   （`/report` 选完发出去等于空消息）。序列化只走 `doc-text.ts` 的 `docToText()`。
6. **不要给 StarterKit 打开标题/列表/引用/代码块**：它们的输入规则会在正常打字时生效
   （`# ` 变标题、`- ` 变列表），而 `#` 正是文件触发符。要加功能逐个打开并想清楚冲不冲突。

### 触发符规则：`@` `#` 要求词首，汉字算词首

`triggers.ts` 的 `triggerAllowed(trigger, from, charBefore)`：

- `/` **只在整条消息的第一个位置**（`from === 1`）—— host 的 `matchCommand` 只认 `^/名字`；
- `@` `#` 要求词首，判据是 `rich-text-tokens.ts` 的 **`isBoundaryChar`**（与消息记录的
  token 染色**共用同一份**）：空白 / 左右括号引号 / 中英标点 / **中日韩文字**。
  ⚠️ 汉字那条不能删：中文不用空格分词，`帮我把#composer` 是正常写法 —— 最早漏了它，
  `#` 在汉字后面永远弹不出菜单（实测踩到）。反例也要保住：`foo@bar`、`C#code`、`https://x`
  都不该弹。

`#` 的候选是**异步**来的（host 的 `files:list`，有界 + 30s 缓存）。菜单是「先开菜单、后到货」，
靠 `SuggestController.refresh()` 重算，并按 `state.filesQuery` 丢弃过期结果，别把「后到的旧结果」
直接铺上去。另外 `askedQuery` 的初值必须是 `null` 而不是 `''`：空查询（刚打出 `#`）是合法的一次
请求，用空串当初值会让它跟「已经问过」撞车，于是光打一个 `#` 永远没有候选。

Esc = 「这个触发词我不要菜单」（走 `exitSuggestion`，同一触发词内不再弹，打空白或把触发词
删掉后复位）；失焦 = 只收起菜单（`controller.hide()`），回来接着打字还会弹。

### ⚠️ 输入法：`event.isComposing` 不够，还要 `view.composing`

中文组字时回车是「确认候选词」。第一句必须同时判两件事：

```tsx
if (view.composing || ime.isImeKeyNative(event)) return false
```

`view.composing` 不是保险，是**必需**：ProseMirror 在「DOM 变化看起来像按了 Enter」时会自己
合成一个 Enter 键事件（`readDOMChange` → `keyEvent(13, 'Enter')` = `document.createEvent('Event')`），
那个事件**没有 `isComposing`**、`isTrusted === false`，只有 `keyCode === 13`。输入法用回车确认
候选词正好产生一次「新增段落」的 DOM 变化 → 合成 Enter 打进来 → 只信 `event.isComposing` 的
守卫会放行，半成品被当成消息发出去（实测踩到，日志里连一次 `compositionend` 都没有）。

组字事件（`ime.compositionProps`）挂在**外层 `.composer__box`** 上（从 contenteditable 冒泡上来）。

给会话记录加新条目类型时（`SteerItem` 就是这么加的）：协议里加进 `Item` 联合类型 →
`use-agent.ts` 的 `traceSteps()` 加分支（否则轨迹里会漏）→ `components/trace.tsx` 的
`KIND_LABEL` 补标签（那个 Record 是穷尽的，漏了会编译报错，是好事）→ `message.tsx` 渲染。

## 推理（思考）：按位置排、流式限高、结束自动收起

三条硬约束，改这块时别破坏（都是用户点名的问题）：

1. **推理是 `blocks` 里的一种块**（`ReasoningBlock`），不是整回合拼成一个字符串。
   归约器的 `appendReasoning()` 只把增量接到**末尾那块推理**上；中间夹了正文/工具就新起一块。
   用 `item.reasoning`（整回合拼接，只给刻度尺摘要）渲染 = 所有思考又堆回消息最上方。
   回放路径（`history.ts`）同样按日志里的块顺序落 reasoning / text / tool。
2. **宽度吃满内容区**。上游 `ThinkingState` 写死 `max-w-95`（380px），推理只在左半边换行，
   右边一片空白、块还被拉得特别长。
3. **流式期间限高 + 自动滚底**，结束自动收起成一行「思考了 N 字」（点开看全文，限高 320px）。
   上游的行 key 用的是**文本本身**，流式时每个 delta 都换 key → React 重建元素 →
   `fade-up` 从 `opacity: 0` 重播 → 整块看着是空白（用户报的「没有流式输出」就是这个）。
   文本节点的 key 必须稳定（按块的位置），增量只让文本变长。

自检口径（真窗口）：流式期间 `.reasoning__body` 的 `opacity` 应为 1、`maxHeight` 132px、
`scrollTop` 贴着底、`textContent.length` 持续变大；回合结束后 `aria-expanded="false"`、
`gridTemplateRows` 为 `0px`；一段推理的行高是 28px。

## 工具输出：折叠看首行，点开看全文

`tool-result` 帧同时带两样东西：`summary`（一行摘要，`summarizeResult` 的口径）和
`output`（**完整输出**，`clampToolOutput` 兜底到 `TOOL_OUTPUT_LIMIT`）。折叠的工具行
显示 `output` 的**首行**（`ToolChips` 的 `preview`）+ 完整参数 chip；点行展开的是
**不截断**的原文（`whitespace-pre-wrap` + `max-h-[320px] overflow-y-auto`），
明细首次展开才挂载。改这块时别退回「8 行 + 省略号」：真实 bash 输出几十行，
那样等于什么都没给（用户报的「展示残缺」）。回放路径（`history.ts`）必须一起给
`output`，否则切会话以后点开是空的 —— 两条路径共用 `clampToolOutput()`。

## 指令 token 的样式：纯文本要染色，Markdown 不要碰

用户在输入框里用 `/` `@` `#` 选出来的东西，落到会话记录里要**按类型染色**
（`components/rich-text.tsx` + 纯逻辑 `rich-text-tokens.ts`）：命令=强调色、
工具=青绿、技能=紫、文件=中性等宽。加渲染点时别漏了这几处：
用户消息、目标调整、工具卡参数与错误结果、轨迹明细。

⚠️ 四条容易改坏的地方：

1. **助手正文不要套 RichText** —— 那是 Markdown，模型自己会用反引号包住工具名，
   套上去会把 `` `mcp__x` `` 里的反引号也染色。
2. **识别判据宁紧勿松**：裸词必须「含 `/` 且末段有扩展名」才算路径，
   否则 `and/or`、`HTTP/2` 会被染色。
3. **必须要求真词边界**（`isWordBoundary` / `isBoundaryChar`）。扫描逐字符推进，判据一松就会从
   `https://example.com/x.md` 中间切出 `xample.com/x.md` 当成路径 —— 真踩过。
   反过来，**汉字必须算边界**：中文不用空格分词，`见app/cli/main.ts` 也要染色，
   同一份判据还管着输入框的触发符（见上）。
4. **输入框里的 chip 与记录里的 token 共用 `--ym-tok-*` 颜色**：加一种 chip 类型时
   `.chip--x` 与 `.tok--x` 一起加，别让用户在输入框里看到一个颜色、发出去变另一个。
   文件路径类一律等宽，变量名是 `--ds-font-family-code`（**没有** `--ds-font-family-mono`，
   写错了会静默退化成 inherit）。

改完**先跑一遍真值表**：纯逻辑在 `.ts` 里就是为了能在 Node 里直接 import
（`node --experimental-strip-types` 跑个临时脚本，正例 + 负例 + 「拼回去与原文本逐字相同」）。
仓库里不放测试文件，所以这一步是手动的 —— 别省。
输入框相关的纯逻辑有四个模块可测：`doc-text.ts`（序列化）、`chip-text.ts`（四种 chip 的文案）、
`triggers.ts`（触发符规则）、`rich-text-tokens.ts`（染色）。最值钱的一条是**跨模块**的：
「chip 落库的文本，恰好被记录端认成同一种 token」—— 它保证输入框和会话记录不会各说各话。

## 切会话必须丝滑：内容等 `history` 帧再换

侧栏点会话 = 重启内核（约 0.5 秒）。**这段时间界面不能抖**，四条硬约束：

1. **`restarting` 不要无条件清空**（`use-agent.ts`）：已经有内容时只打 `switching` 标记，
   `items` / `usage` / `turns` / `models` / `info` / `projectSessions` **全部保留**，
   等 `history` 帧到了再整段替换。清空会连着抖四下：消息区白掉闪出「正在启动内核…」、
   统计归零、模型下拉变空、已展开项目显示「读取中…」。
2. **host 每次就绪都要发 `history`**（`host/index.ts` 的 `sendHistory`），新会话发**空历史**。
   界面只认这一种「内容现在是 X」的信号 —— 不发的话新会话永远等不到，只能退回清空那条路。
3. **`switching` 由 `history` 解除，不由 `ready`**：`ready` 先到、历史后到，
   在 `ready` 就放开会让用户在「内容马上要被覆盖」时发的消息丢掉（另有 3 秒超时兜底）。
4. **连点两个会话要靠代际守卫**：`main.ts` 的 `AgentHost.generation`（message/error/close
   三处都要判，只判 close 不够）+ `restartGeneration`（被取代的那次不写状态、不报错）。
   没有它就会出现「点 A 又点 B，结果停在 A」。

配套的观感两件：点下去的那一行加 `.session--opening`（否则 0.5 秒内毫无变化，
用户会重复点）；内容替换时 `.messages__inner` 按 `sessionId` 换 key + 160ms 的
`ym-swap-in` 淡入（`prefers-reduced-motion` 下关掉）。

**怎么验**：从 Node 侧每 100ms 采一次 `Performance.getMetrics` 的 `TaskDuration`，
同时读界面状态。合格线是「切换期间渲染进程基本空闲（每 100ms ≤ 3ms），
只有替换那一帧有十几毫秒」，且全程**不出现**「正在启动内核…」。
⚠️ 别在页面里用 `setTimeout` 自测卡顿：那样量到的是 CDP 往返的假象（曾经误判成主线程卡了 1 秒）。

## 会话条目的规格：单行 24px，必须比项目行小

`.session` 是**单行**（图标 + 标题 + 右端时间）：`min-height: 24px`、`padding: 3px 6px`、
`border-radius: 6px`、12px/16px；项目行是 32px（`padding: 5px 6px` + 13px/500）。
层级靠「缩进 + 竖线 + 字号 + 行高」，**不要**把会话做成两行的卡片（早先 42px，
比项目行还厚，一屏放不下几条）。改完在真窗口里量一下：
`document.querySelectorAll('.session')[0].getBoundingClientRect().height` 应该是 24。

## 品牌行 / 图标：界面里 16px，系统图标按 Apple 网格

侧栏品牌行照 macOS 侧栏头部来：`.sidebar__logo` **16×16 + 圆角 4px**、标题 **13px/600**、
`gap: 6px`、`padding: 8px 10px 6px`（darwin 再被 `padding-top: 34px` 顶下来给红绿灯）。
16px 恰好等于项目行 `Monogram` 的 `size-4`，一行里三个东西（图标 / 标题 / 右侧 26px 的
「新会话」按钮）视觉宽度才对得上。**踩过**：一开始 logo 给的是 20px / 圆角 6px、标题 14px，
整行像网页标题栏 —— 用户一眼就说「太大了，参考 macOS 的应用 UI 尺寸」。

`assets/` 下三份图标是**两档尺寸规范**，别互相顶：

| 档 | 文件 | 规范 |
| --- | --- | --- |
| 界面内 | `logo.png`(128²) | **铺满画布**，尺寸与圆角全交给 CSS（16px / 4px） |
| 系统 | `icon.png`(1024²) / `icon.icns` | **Apple 图标网格**：画布 1024²、方片本体 824² 居中（80.47%）、本体圆角 22.45%、本体外透明 |

系统图标铺满画布是**错的** —— macOS 上所有 App 图标本体都只占画布的 ~80%，
100% 的图标在 Dock 里比邻居胖一圈。透明只给**方片外面**，本体仍是不透明的浅紫底
（抠掉背景图案会在浅色桌面上「浮」着）。派生脚本 `app/desktop/scripts/make-icons.py`
（要 Pillow，不参与构建）；自检口径：`icon.png` 不透明 bbox = `100,100 → 923,923`、
四角 alpha = 0，`iconutil -c iconset` 回解出来的每一档都应是 80.47% 左右。

## 侧栏背景的柱面网格：纯模拟与 DOM 分开

侧栏背后是一层「整段柱面被切成 13px 小方块、随机的块向右滚出去消散」的背景
（`components/sidebar-cylinder.ts` 纯模拟 + `components/sidebar-backdrop.tsx` canvas）。
改它时记住：

1. **纯逻辑必须留在 `.ts` 里**（不 import DOM），随机源靠**注入**（组件传 `Math.random`，
   真值表传固定种子）—— 柱面投影、纵向强度、周期与消散曲线都能在 Node 里直接验。
   合并进 `.tsx` 就再也验不了了。
2. **三条几何硬约束**（真值表盯着，改几何时别破坏）：
   - 鼓面位移**按角度**算，不按屏幕像素（边缘处一格的屏幕间距比弧长少 4.7px，按像素会跳）；
   - 稠密列要**两侧各多铺 2 列**（`DENSE_PAD`），否则左边缘会有一条会呼吸的空缝；
   - 鼓面**按整圈取模**，不按一格（按一格会让材料映射错开一列，画面跳变）。
   自检口径：相邻格子之间只有缝没有洞（最大缝 ≤ gap + 0.6px）、整行盖满（缺口 < 2px）。
3. **三条暂停规则不能删**：`prefers-reduced-motion` 命中就不启动并清空画布；窗口隐藏时停
   （Chromium 本来也会暂停 rAF，画布会冻在最后一帧）；`dt` 夹 48ms。
   停下来的路径上还挂了一个 1.5s 的复查定时器（`scheduleResumeCheck`）——因为
   `matchMedia` 的 `change` 事件在某些环境下不一定派发，只靠它会「设置改回去了画面还是死的」。
4. **每帧不读布局**：尺寸只在 `ResizeObserver` 里读一次并缓存。加上 30fps + DPR 1.25，
   开销从 ~20% 降到 ~7%（`TaskDuration` 口径，覆盖率约 23% 的整面网格）。
5. **粒子层不能放进滚动容器**：`.sidebar` 只负责底色/描边/`position: relative`，
   滚动在 `.sidebar__scroll`（z-index 1），canvas 是 `.sidebar` 的绝对定位子节点（z-index 0）。
6. 颜色走 `--ym-surface` / `--ym-shard`（`app.css`，从官方令牌 `color-mix` 派生）；
   canvas 的 `fillStyle` 支持 `color-mix()`，但**写错的颜色不报错、只会静默保留上一个值** ——
   改完要真读一次像素。

**验这种「看不清的视觉效果」的办法**（agent 看不了截图时尤其有用）：在页面里把 canvas
降采样成 ASCII 图打印出来 —— 一眼就能看出「有没有网格、切没切开、在不在滚、上面是不是更强」：

```js
const fx = document.querySelector('.sidebar__fx'), ctx = fx.getContext('2d')
const img = ctx.getImageData(0, 0, fx.width, fx.height)   // 按 2×6 设备像素取平均 → 一个字符
```

配套的两个数值口径：`alpha > 2` 的像素占比（覆盖率）与最大 alpha（亮度），
以及**上/中/下三段各自的有像素数**（用来验证「上强下弱」，实测 52125 : 24867 : 0）。

⚠️ 量之前先确认 `document.visibilityState === 'visible'`：**开着 `Memento_DEV=1` 时
DevTools 是独立窗口，会把应用窗口遮住 → Chromium 暂停 rAF → 效果冻住**，
这时量出来是「0 像素、0% CPU」，很容易误判成效果坏了。

## 设置界面：技能 / 命令 / MCP 的查看编辑## 设置界面：技能 / 命令 / MCP 的查看编辑

`components/settings-panel.tsx` 是一个居中模态：左边列表（`.setrow`），右边文本框
（`.setedit__area`）。加东西时记住这几条：

- **数据来自 host**：`settings:list` → `settings` 帧 → `use-agent.ts` 的
  `state.settings`；打开面板时 `loadSettings()` 拉一次，**写完文件会自动重拉**
  （列表里的大小/告警要跟着变）。
- **文件读写走主进程**（`window.Memento.settingsRead/settingsWrite`），主进程有白名单
  （只允许配置与技能/命令目录）。**别在渲染进程里想办法绕过它** —— 那是安全边界。
- **编辑的是纯文本**：技能是 Markdown（含 frontmatter）、MCP 是 JSON。所以用 textarea，
  不要改成结构化表单。
- **保存后未必生效**：技能/命令要重开内核（面板上有「重启内核」），MCP 一定要重启。
- 调用方式徽章有三种底色（`.settag--global/--command/--user-only`），
  对应内核的 `SkillInvocationPolicy`；别把「命令专用」标成红色之类的「错误色」，
  它是正常状态。

## 磨砂玻璃侧栏：材质被盖住是最常见的坑

侧栏是系统材质（macOS `vibrancy: 'sidebar'`），主区刷 `--dsw-alias-bg-base`（淡紫黑 `rgb(14,12,20)`）。
**材质在网页内容之下** —— 网页只要有一层铺满窗口的不透明底色，玻璃就完全看不出来
（表现：开了 vibrancy，侧栏还是死的一块深灰）。所以 `html` / `body` / **`.app-shell`**
三者都必须透明；主区不透明交给 `.main-column` 自己刷。

- **`.app-shell` 最容易漏**：它默认刷的就是基础底色，正好盖住侧栏那一列。
- 侧栏内部的实心块（搜索框、hover、当前项）也要在 `.sidebar` 作用域里换成白色半透明令牌，
  否则玻璃上会出现一块块补丁。做法是**重定义令牌**（会继承），别写十几条覆盖规则。
- 不用 `backdrop-filter`：窗口透明，backdrop 后面没有可模糊的内容。

**怎么证明玻璃真的透了**（agent 看不了截图时）：`Emulation.setDefaultBackgroundColorOverride`
设成 `{r:0,g:0,b:0,a:0}`（让「没画东西」的地方保持透明）→ `Page.captureScreenshot` →
解 PNG 看 alpha：侧栏区域的 alpha 应该 < 255（本仓库实测 ~121），主区应该是 255。
把 `.app-shell` 改回不透明再截一次，同一处会变成 255、**PNG 还会退化成 3 通道** —— 判据很硬。
（`/tmp/png-alpha.mjs` 那种 40 行的 PNG 解码器就够：node:zlib 解 IDAT + 反 filter。）

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

⚠️ 内核 `stateDir` 默认 `<cwd>/.Memento` → **每个项目一份会话库**，项目之间互相看不见。
只扫当前项目那一个根，侧栏的树里就永远只有**一个**项目（换项目后上一个直接消失）。
现在靠一份线索补齐，**数据位置不动**：

- `main.ts` 维护 `<userData>/projects.json`（`Memento_PROJECTS_FILE` 可覆盖），
  host 成功启动后登记当前项目；
- 启动 host 时用环境变量 `Memento_PROJECT_ROOTS`（冒号分隔）把清单交过去；
- `sessions.ts` 的 `rootsOf()` 把「当前项目的库 + 每个项目的 `<path>/.Memento/sessions`」
  拼成要扫的根，`locateProjects()` 逐根扫并**按 cwd 去重、先扫的根优先**；
- `rootsOf` 同时供 `listWorkspaceSessions` 与 `listProjectSessions` 使用 ——
  **两处必须一致**，否则会出现「列出来的项目点开是读不到」。

边界：登记最多 20 条、单次最多多扫 8 个根（`DEFAULT_MAX_EXTRA_PROJECTS`）；
路径被删、库不存在都只是跳过，**读写失败绝不影响启动**（顶多少列一个项目）。
没被 Memento 打开过的项目不会出现在树里。

## 四个已修的 bug —— 改布局/输入框前先看

### 浮层被祖先裁掉（症状：点了按钮/箭头毫无反应）

菜单弹层是 `.menu` 里**绝对定位**的子节点，向上弹时伸到触发器那一行**外面**。只要
祖先链上任何一层写了 `overflow: hidden`，弹层就被整个切掉 —— 而它**还在 DOM 里**，
所以「有没有打开」的各种 DOM 判断全是绿的。

真踩过：面包屑挪到输入框上方之后，`.crumbs` 上那句「路径再长也别挤到输入区」的
`overflow: hidden`（才 24px 高）把向上的分支菜单切没了。**裁剪要放在真正需要它的
那个子元素上**（`.crumbs__path`），不要图省事加在外层行容器上。

⚠️ 验证方式也得跟着改：`getBoundingClientRect()` 对**被裁掉的元素照样返回正常坐标**，
`inViewport` 这类几何判断会一起骗你（这个 bug 就是这么漏过去的）。要用
`document.elementFromPoint(x, y)` 问「这个坐标上**实际上是谁**」；最硬的是 CDP
`Input.dispatchMouseEvent` 投**真实**鼠标事件 —— 它走完整命中测试，而
`element.click()` 直接派发、绕过命中测试，正好验不出这类 bug。

### 布局失控（症状：展开推理后侧栏「样式变了」并卡死）

`.app-shell` 必须写 `grid-template-rows: minmax(0, 1fr)`，且 `.main-column` / `.messages`
要有 `min-height: 0`。只写 `height: 100%` 时 grid 行是隐式 `auto`，会被内容撑高：
侧栏被拉到和内容一样高（实测 800→1723px，底部内容顶出可视区），`.messages` 失去内部滚动，
长内容直接把渲染进程卡死。超长不可断片段用 `overflow-wrap: anywhere`（`break-word`
不参与 min-content 计算，仍可能撑开）。**改完务必展开一段长推理手动确认**：
外壳高度不该超过视口，滚动条应该在 `.messages` 内部。

### 输入法组字（症状：中文打词按回车就把半成品发出去）

守卫必须是键盘处理的**第一句**。textarea / 表单（`sidebar.tsx` 那种）：

```tsx
onKeyDown={(event) => {
  if (ime.isImeKeyNative(event.nativeEvent)) return   // ← 必须是第一句
  if (event.key === 'Enter' && !event.shiftKey) submit()
}}
```

判定用三个信号（`isComposing` / `keyCode 229` / `compositionend` 后的临时标记），
细节见 `composition.ts` 注释。**不要**改成持久标志位：`compositionend` 不触发时会永久卡住，
表现是回车彻底发不出去。表单里的输入框也要挂，否则组字回车会提交表单。

### 富文本输入框的合成 Enter（症状：输入法确认候选词时把半成品发出去）

Tiptap 里光判 `event.isComposing` **不够**（那个事件里根本没有这个属性）—— 必须加
`view.composing`，原因与实测现象见上面「输入法：`event.isComposing` 不够」一节。
这条是重写输入框时才暴露出来的：同样一句 `if (isComposing) return`，在 textarea 上是对的，
在 ProseMirror 上会被它的合成 Enter 绕过。

## 改完怎么验

```bash
npm run build:renderer     # 或者一直开着 npm run desktop:watch
npm run typecheck          # 三个项目：Node 侧 TS + 渲染进程 TSX + Node 侧 JS
npm run desktop            # 真开窗口，把改的地方操作一遍
```

打包成 .app / .dmg 是另一条链路，见技能 **`Memento-package`**（`npm run package` / `npm run make`）。

**没有自动化测试**，所以「操作一遍」要具体：改侧栏就跑一次会话切换、
改输入框就用中文输入法打一个词、改布局就展开一段长推理。

输入框这块可以只靠 CDP 验到底（窗口被遮住也能跑，`Input` 域照样投递真按键）：

```bash
Memento_DEV=1 ./node_modules/.bin/electron app/desktop/main.ts --remote-debugging-port=9225
# 然后：Input.dispatchKeyEvent 打字 / Page.captureScreenshot / Runtime.evaluate 量 getComputedStyle
```

要点与坑：

- 目标页要挑 `type === 'page' && url.startsWith('file://')`（另一个 target 是 DevTools 自己）；
- ⚠️ **窗口被遮挡时 `document.visibilityState === 'hidden'`，这时浏览器不发 scroll 事件、
  不跑 CSS 过渡、不做平滑滚动**（都是渲染时机驱动的），`transition` 的 `getComputedStyle`
  会停在起点值。想要可信的交互/样式结论，先 `Page.bringToFront` 或把窗口点到最前；
  拿不到可见窗口时改用三招：**合成事件**（`new WheelEvent('wheel', {deltaY})` 直接跑我们的
  监听器）、**给 `Element.prototype.scrollTo` 装探针**看「点了第 N 条到底请求滚到哪」、
  **读 CSSOM 的规则值**代替被冻结的 computed 值；
- `Input.dispatchMouseEvent` 的 `type: 'mouseWheel'` 在当前 Electron 上**不回包**
  （Promise 永远不 resolve），别用它测滚轮 —— 用上面的合成事件；
- 先 `Runtime.evaluate` 里 `element.focus()` 再投键 —— `Input.dispatchMouseEvent` 在
  `document.visibilityState === 'hidden'`（窗口被遮）时点不中；
- 量「chip 到底长什么样」用 `getComputedStyle` 的**实际值**（背景/字色/字重/字族），
  别只看 CSS 源码 —— 未定义的 CSS 变量会静默退化成继承（`--ds-font-family-mono` 就是这么
  空转了不知道多久）；
- 端到端最强的一条证据是**会话日志**：`<项目>/.Memento/sessions/*/*/session.v3.jsonl`，
  发一条 `用 /report 写稿` 就能看到 `user/message` 里是**展开后**的命令正文（说明 chip 序列化
  成 `/report …` 且 host 认出来了）；
- 中文/日文输入法没法用 CDP 完全模拟：`Input.imeSetComposition` 能造出真组字，但**不会发
  `compositionend`**，于是 `view.composing` 一直为 true、之后所有回车都不响应 —— 到这一步就
  刷新页面重来，别误判成守卫坏了。

`app/desktop/README.md` 里有每个子系统的设计说明与坑。
