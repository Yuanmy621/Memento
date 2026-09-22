# Beautiful UI（vendored）

Memento 桌面端的界面底座来自 [Beautiful UI](https://www.beautifului.dev/)
（作者 Shane Levine，**MIT License, Copyright (c) 2026 Shane Levine**，
全文见 <https://www.beautifului.dev/license>）。这里保存的是**从它公开的 shadcn registry
原样取回**的源码，只做了下面两类必要改动。

## 为什么要 vendored 而不是加依赖

Beautiful UI 通过 shadcn registry（`https://www.beautifului.dev/r/<名字>.json`）分发源码，
不是 npm 包。它没有 Next.js 依赖（只 import `react` 和几个小库），所以可以直接落进我们的
渲染进程；**但要按我们的路子改 import 路径**，所以不跑 `npx shadcn add`，改为取 JSON 自己落盘 ——
这样升级时能逐文件 diff。

## 目录

```
foundation.css        设计令牌（:root 亮色 / .dark 暗色）、@theme inline、基础工具类与关键帧
lib/utils.ts          cn()：clsx + tailwind-merge（它们的组件都 import 它）
atoms/                最小构件：Button / EntityChip / ValuePill / Shimmer
primitives/           区块构件：ToolChips / CodeBlock / LoadingState
```

## 相对上游做的改动

| 改动 | 原因 |
| --- | --- |
| `foundation.css` 删掉第 1 行 `@import "tailwindcss";` | 我们的 `styles/app.css` 已经引过，重复引会让 Tailwind 处理两次 |
| `foundation.css` 删掉一段孤儿块（`.records-footer-hint` + 一个多余右花括号） | **上游文件本身括号不配平**（84 左 vs 85 右）：Tailwind 解析到那里会整份丢掉 foundation 且不报错。RecordsTable 自己的 CSS 里有这条规则，删掉无副作用 |
| `@/lib/utils` → `../lib/utils`（相对路径） | 我们没有 `@/` 别名（esbuild 直编，不跑 shadcn CLI） |
| 字体：`--font-inter` / `--font-mono-face` 在 `styles/app.css` 里指到项目现有两套字体 | 上游靠 Next.js 的 `next/font` 注入这两个变量；本地应用不引 webfont |
| `atoms/*` 的根元素加 `...props` 透传 | 上游只声明自己的 props，`title` / `aria-*` 传不进去（我们到处挂 tooltip） |
| `ToolChips` 加 `live` / `compact` / `onChipActivate`，行拆成两个按钮，空 `diffs` 不渲染页脚 | 同上（它按 700ms 逐行演示、固定 220px 最小高、页脚永远有「+N more」）；chip 在真实界面里是「这次动了哪个文件」，**点它要能直接打开预览**，所以从行按钮里拆出来（HTML 不允许 button 套 button） |
| `ToolChips` 加 `preview`（行尾输出首行）、明细不截断可滚动、明细首次展开才挂载、展开状态按下标记 | 上游明细是「一行一条 + `truncate`」：真实 bash 输出几十行，折叠时看不见、展开后全是省略号。展开状态原本按 `label` 记，同一次 run 里两次 `bash` 会一起展开 |
| `LoadingState` 去掉 `videoSrc` 的远程默认值 | 上游默认指向一个远程 meme 视频，我们的 CSP 是 `default-src 'none'`，外链媒体放不出来，也不该塞进产物 |
| 删掉 `atoms/StreamText.tsx`（整份）与 `foundation.css` 里所有**没有落盘**构件的块：StreamingText/ContextCards、FilterTable、InsightCards、RecordsTable、component nav、`primitive-*` 间距、`theme-switching`、`.home-reveal`、`eq-bounce`/`caret-blink` | 那些构件我们只取了自己要用的几个，规则与关键帧没有任何宿主元素 —— Tailwind 会照单全收、白白进 CSS 产物。删的是「COMPONENT-SPECIFIC」块，generic foundation（令牌 / `@theme` / base / 共享关键帧）一条没动 |

## 怎么再接一个构件

```bash
curl -sSL https://www.beautifului.dev/r/<名字>.json -o /tmp/<名字>.json
# 取出 files[].content，落到 ui/beautifului/<atoms|primitives>/<文件>.tsx
# 把 '@/' 开头的 import 改成相对路径；registryDependencies 里提到的原子构件先落盘
```

`foundation.css` 只有在**升级上游**时才需要重新取，取完记得再数一次括号。

## 使用约定（本项目）

- **保留 Tiptap 与 Streamdown**：编辑器内核与 markdown 渲染不换，只换它们外面的壳。
- 只用它们的**构件与令牌**，不改我们的数据流（`use-agent.ts` 仍是唯一归约器）。
- 自研且上游没有对应物的东西继续自研：右侧会话刻度尺、下拉菜单、侧栏柱面粒子背景。
- **轨迹视图不要用上游的 `TaskRows`**：它的绿勾徽章 / 绿药丸 / 44px 卡片行是 TODO 清单的语汇，
  放进消息流里格式对不上（用户点名不要）。轨迹现在是 `components/trace.tsx` 自绘的时间线，
  所以上游那份文件已经从本目录删掉了；要再取回来就按下面的 recipe 重取。
- **思考（推理）不要用上游的 `ThinkingState`**：它把宽度写死 380px（推理只在左半边换行），
  行 key 用文本本身（流式时每个 delta 都重建元素 → `fade-up` 从 opacity 0 重播 →
  整块看着是空白，这就是「没有流式输出」的真相）。思考现在是
  `components/reasoning.tsx`：吃满内容区、流式限高 132px 自动滚底、结束自动收起成一行，
  所以上游那份也删掉了。
