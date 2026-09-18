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

`npm run desktop:ui-smoke` 会检查「构建产物不比源码旧」，忘了构建直接红。

主进程（`main.js`）与 host（`host/*.ts`）**不需要**构建。

## 加一个界面动作：四步，缺一不可

以「切换主题」这种动作为例：

1. `app/desktop/ipc.js` —— 往 `IPC` 表加频道名；
2. `app/desktop/main.js` —— 加 `ipcMain.handle(IPC.xxx, (event) => { assertSender(event); … })`；
3. `app/desktop/preload.js` —— 在 `CHANNEL` 与 `api` 里**各加一条**
   （沙箱化 preload 不能 require 本地文件，频道字面量只能重复一份）；
4. `renderer/src/` —— 通过 `window.YuanMy.xxx()` 调用。

`ui-smoke` 会静态比对这三处的频道名/方法名，改漏了会红。

**加一种内核事件到界面**是另一条链路：

1. `host/protocol.ts` 的 `HostEvent` 加分支（顺手更新 `isHostEvent`）；
2. `host/bridge.ts` 在对应事件里 `this.send({...})`；
3. `renderer/src/use-agent.ts` 的归约器加 `case`（这是唯一把事件变成界面状态的地方）；
4. `renderer/src/components/*.tsx` 里渲染；`message.tsx` 负责消息条目内的排布。

**加断言**：新功能要在 `ui-smoke.js`（纯函数/真值表）或 `main.js` 的探针（真窗口）里留下断言，
并给需要的节点加 `data-testid`——它是脚本与界面之间唯一的契约。

## Streamdown 的样式：缺 token 会静默消失

Markdown 由 Streamdown 渲染，它内部用的是 **shadcn 那套 token 名**
（`bg-muted`、`text-muted-foreground`、`border-border`、`text-primary`…）。
Tailwind **只为已定义的 token 生成工具类**，缺了会被静默丢掉——表现是行内代码、链接、
表格描边突然没样式，看着像「Streamdown 没生效」。所以 `styles/app.css` 的 `@theme` 里
把这一整套别名都映射到了项目色板。**改配色时别删这些别名。**

组件里不要堆 Tailwind 工具类：Tailwind 是给 Streamdown 用的，自己的组件用语义类
（`.sidebar` / `.tool-card` / `.tokenbar` …）。要加类就写在 `styles/app.css`。

## 侧栏是懒加载的树

侧栏是「项目 → 会话」两级树，数据**分两批**来：`workspace` 帧给项目清单 + **当前项目**的会话；
折叠的项目被点开时才发 `list-project-sessions` 去读那个项目（`project-sessions` 帧回来）。
改这块时注意：别把「所有项目的会话」塞进 `workspace` 帧 —— 那会让首屏随项目数变慢，
也会让 `ui-smoke` 里那条「首屏只带当前项目的会话」的断言失效。

## 两个已修的 bug —— 改布局/输入框前先看

### 布局失控（症状：展开推理后侧栏「样式变了」并卡死）

`.app-shell` 必须写 `grid-template-rows: minmax(0, 1fr)`，且 `.main-column` / `.messages`
要有 `min-height: 0`。只写 `height: 100%` 时 grid 行是隐式 `auto`，会被内容撑高：
侧栏被拉到和内容一样高（实测 800→1723px，底部内容顶出可视区），`.messages` 失去内部滚动，
长内容直接把渲染进程卡死。超长不可断片段用 `overflow-wrap: anywhere`（`break-word`
不参与 min-content 计算，仍可能撑开）。`desktop:smoke` 的布局探针盯着这条。

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
npm run desktop:ui-smoke                                        # 不需要窗口
YuanMy_SMOKE_PROMPT="只回答两个字：好的" npm run desktop:smoke    # 真窗口 + 真回合
```

细节与坑见 `yuanmy-verify` 技能与 `app/desktop/README.md`。
