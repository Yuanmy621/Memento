# Beautiful UI（vendored）

YuanMy 桌面端的界面底座来自 [Beautiful UI](https://www.beautifului.dev/)
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
atoms/                最小构件：Button / EntityChip / ValuePill / Shimmer / StreamText
primitives/           区块构件：ThinkingState / ToolChips / TaskRows / CodeBlock / LoadingState
```

## 相对上游做的改动

| 改动 | 原因 |
| --- | --- |
| `foundation.css` 删掉第 1 行 `@import "tailwindcss";` | 我们的 `styles/app.css` 已经引过，重复引会让 Tailwind 处理两次 |
| `foundation.css` 删掉一段孤儿块（`.records-footer-hint` + 一个多余右花括号） | **上游文件本身括号不配平**（84 左 vs 85 右）：Tailwind 解析到那里会整份丢掉 foundation 且不报错。RecordsTable 自己的 CSS 里有这条规则，删掉无副作用 |
| `@/lib/utils` → `../lib/utils`（相对路径） | 我们没有 `@/` 别名（esbuild 直编，不跑 shadcn CLI） |
| 字体：`--font-inter` / `--font-mono-face` 在 `styles/app.css` 里指到项目现有两套字体 | 上游靠 Next.js 的 `next/font` 注入这两个变量；本地应用不引 webfont |
| `atoms/*` 的根元素加 `...props` 透传 | 上游只声明自己的 props，`title` / `aria-*` 传不进去（我们到处挂 tooltip） |
| `ThinkingState` 加 `live` / `working` / `expanded` | 上游是**演示时序**：内部定时逐条放行、自动展开再收起。真实会话里时序必须由数据决定 |
| `ThinkingState` 行 key 带下标 | 真数据里同一句主文案会出现多次（连续两次「读取文件」），用 `row.primary` 当 key 会撞 |
| `ToolChips` 加 `live` / `compact` / `onChipActivate`，行拆成两个按钮，空 `diffs` 不渲染页脚 | 同上（它按 700ms 逐行演示、固定 220px 最小高、页脚永远有「+N more」）；chip 在真实界面里是「这次动了哪个文件」，**点它要能直接打开预览**，所以从行按钮里拆出来（HTML 不允许 button 套 button） |
| `TaskRows` 加 `failed` 状态与 `live`，明细行 key 带下标 | 上游只有 done/running/sequence 三种，而轨迹里「失败」必须一眼看到 |
| `LoadingState` 去掉 `videoSrc` 的远程默认值 | 上游默认指向一个远程 meme 视频，我们的 CSP 是 `default-src 'none'`，外链媒体放不出来，也不该塞进产物 |

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
