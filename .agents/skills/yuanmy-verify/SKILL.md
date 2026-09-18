---
name: yuanmy-verify
description: 在 YuanMy 仓库改完代码后怎么验证 —— 从便宜的静态检查到真窗口 E2E 的固定顺序、每一层能证明什么、以及「先让测试红一次」的纪律。当你要确认改动没坏、要跑测试、要验证桌面端、或者用户说「验证一下 / 跑一遍 / 确认没问题」时使用。
---

# 在 YuanMy 里验证改动

**一条命令跑完全部**（改完代码默认就该跑它）：

```bash
npm run verify     # typecheck(两个项目) → 构建渲染进程 → 界面链路 → 内核链路
```

`verify` **不**包含真窗口那层。涉及 UI、IPC、窗口行为的改动必须再补一次 `desktop:smoke`（见下）。

## 四层防线，从便宜到贵

| 命令 | 覆盖什么 | 需要窗口 | 需要 API key |
| --- | --- | --- | --- |
| `npm run typecheck` | 两个 tsconfig：Node 侧 + 渲染进程（DOM/JSX） | 否 | 否 |
| `npm run desktop:ui-smoke` | 静态契约 + 归约器回放 + 技能/输入法真值表 + Markdown 真渲染 | 否 | 否 |
| `npm run desktop:host-smoke` | 真起 host 子进程：内核装配、会话扫描；加 `-p` 可跑真实回合 | 否 | 加 `-p` 才要 |
| `npm run desktop:smoke` | **真开 Electron 窗口**：preload、React 挂载、侧栏、token 栏、布局、输入法 | 是 | 否 |
| `YuanMy_SMOKE_PROMPT="…" npm run desktop:smoke` | 上面全部 + 在真实窗口里跑完一个回合（含 Markdown 断言） | 是 | 是 |

`desktop:smoke` 由 `scripts/smoke-desktop.js` 包一层，会先造一个**临时工作区**再跑 Electron：
测试会话不会写进你真实的 `.YuanMy/sessions`，并且自带「两个项目」的 fixture
用于验证项目树的懒加载。断言在 `main.js` 的探针里（树 / token / 布局 / 输入法）。

CLI 侧的手工确认：

```bash
node app/cli/main.ts --list-tools          # 工具是否注册齐（含 skill）
node app/cli/main.ts -p "只回答两个字：好的"  # 一次性回合
```

## 什么算「验证过了」

1. **跑给对应层**。改了渲染进程却只跑 `host-smoke` 等于没验。
2. **构建产物比源码新**。`ui-smoke` 会检查这一点；忘了 `build:renderer` 会直接红。
3. **行为断言，不是「没报错」**。冒烟脚本的价值在于它**会失败**。

## 纪律：先让测试红一次

新加的断言必须在**坏代码上失败过**，否则你不知道它有没有在测东西。做法是把修复临时撤掉、重跑、确认红、再恢复：

```bash
cp app/desktop/renderer/styles/app.css /tmp/app.css.bak
# …撤掉被验证的那行…
npm run build:renderer && YuanMy_SMOKE=1 ./node_modules/.bin/electron app/desktop/main.js
# 期望：断言失败 + 退出码 1
cp /tmp/app.css.bak app/desktop/renderer/styles/app.css
```

已经这么验过的两条断言可以直接引用：布局探针（撤掉 `grid-template-rows: minmax(0,1fr)`
会打印 `侧栏 800→1723`）、输入法守卫（撤掉守卫会打印 `组字中发送=1 次`）。

## 三个踩过的坑

### 1. 冒烟静默「通过」

`desktop:smoke` 用独立 userData 目录，是为了能在你开着桌面端时照跑。
如果它报「无法取得单实例锁」，那是**真错误**（非零退出），别忽略 ——
早先这里走的是 `app.quit()`，结果是**什么都没测却退出码 0**。

### 2. 探针脚本是独立作用域

`SMOKE_PROBE` 与 `SMOKE_WAIT_TURN` 是两个独立的字符串脚本，助手函数**各带一份**。
借用过一次 `text()`，报 `ReferenceError` → Promise 永不 settle → `executeJavaScript`
死等，现象看起来像「界面卡死」。探针超时先用 `[renderer]` 日志确认是界面错还是探针错。

### 3. 输出被缓冲

冒烟脚本用 `say()` **逐行立即输出**。别改回「攒到最后一起打印」——
一卡住就什么都看不到，只能靠 180s 看门狗兜底。

## 相关

- 技能位置与格式：`.agents/README.md`
- 桌面端架构与扩展点：`app/desktop/README.md`
- 内核装配与扩展点：根 `README.md`
