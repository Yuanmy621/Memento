---
description: 把 YuanMy Agent 桌面端打成可分发的 macOS 应用（Electron Forge）—— 打包链路、四个静默失效的坑、以及怎么验证产物真的能跑
---

# 打包 YuanMy Agent 桌面端

## 三条命令

```bash
npm run app:build        # 只生成 staging（build/app/）：生产依赖 + 运行时文件，排查用
npm run package          # → out/YuanMy Agent-darwin-arm64/YuanMy Agent.app
npm run make             # → out/make/{*.dmg, zip/darwin/arm64/*.zip}
```

`package` / `make` 都是 `app:build` + `electron-forge <命令> build/app`。
`app:build` 会先跑 `build:renderer`，所以不用手动构建界面。

## 链路长什么样

```
npm run make
 └ build-renderer.ts          TSX → renderer/dist/renderer.{js,css}，并打 preload.cjs
 └ build-app.ts               物化 build/app/（见下）
    ├ pnpm install --prod --frozen-lockfile   （nodeLinker: hoisted → 扁平真实文件）
    ├ 白名单清理 staging（只留 node_modules 与依赖产物，其余全删 —— 逐个删必漏）
    ├ 复制 main.ts/ipc.ts/preload.ts/preload.cjs + host/ + cli/ + mcp/ + renderer/{index.html,dist}
    ├ 生成 package.json（main=desktop/main.ts / config.forge=./forge.config.ts / 生产依赖 / devDependencies.electron）
    ├ 放 electron 占位包（只给 Forge 的依赖遍历看版本号）
    └ 自检（缺文件、node_modules 不是符号链接、forge.config.ts 语法）
 └ electron-forge make build/app
    ├ @electron/packager 复制 staging → app.asar（asar.unpack 里的东西留在外面）
    └ maker-zip / maker-dmg
```

**产物自检**：asar 里应该只有 `/desktop/{main.ts,ipc.ts,preload.ts,preload.cjs}` 与
`/forge.config.ts` —— **不该有任何手写的 `.js`**（除了 `preload.cjs` 这个构建产物）。
改完文件名之后记得跑一次 `npx asar list …/app.asar | grep '^/desktop'` 确认没有旧名字的残留。

**为什么不直接打包仓库根**：Forge 复制完会按 `package.json` 的生产依赖 prune，而它假定
npm/yarn 的扁平 `node_modules`，且**不认 `peerDependencies`**。这个仓库是 pnpm 符号链接布局，
DSH 又大量用 peer 装配内核 —— 两个假设都不成立，结果就是**静默删掉还要用的包**。
所以先物化一个自包含的 `build/app/`，并在 forge 配置里 `prune: false`。

## 打包后内核怎么跑（不依赖系统 Node）

`main.ts` 的 `resolveHostRuntime()`：打包形态用 **App 自带的 Electron 二进制 +
`ELECTRON_RUN_AS_NODE=1`** 跑 `desktop/host/index.ts`（Electron 44 自带 Node 24.21，
`--experimental-strip-types` 照旧能用，host 仍然直接跑 `.ts`、不需要构建）。
MCP 子进程同理（`app/cli/kernel.ts` 里 `process.execPath` + 显式转发 `ELECTRON_RUN_AS_NODE`）。

⚠️ 因此 `forge.config.ts` 里 **`FuseV1Options.RunAsNode` 必须保持 `true`**
（Forge 模板默认是关的）。关掉的表现：窗口能开、agent 永远「不可用」。

验证自包含性（PATH 里连 node 都没有）：

```bash
env PATH=/usr/bin:/bin "out/YuanMy Agent-darwin-arm64/YuanMy Agent.app/Contents/MacOS/YuanMy Agent" \
  --remote-debugging-port=9227
# 界面应显示「就绪」，再发一条 "run bash: echo hi" 应看到工具卡
```

## 四个坑：全是**静默失效**

1. **`asarUnpack` 不存在** —— 那是 electron-builder 的键名。`@electron/packager` 只认
   `asar: { unpack: '…' }`（glob 字符串）。写错不报错，只是不生效，然后：
   - `sharp` 的 `libvips-cpp.*.dylib`（只有 `.dylib`、没有 `.node`）留在 asar 里 →
     `Library not loaded: @rpath/libvips-cpp.8.18.6.dylib`；
   - `node-pty` 的 `spawn-helper`（没有 `.node` 后缀的可执行文件）留在 asar 里。
   所以 unpack 列表要覆盖：`.node` / `.dylib` / `.so*` / `.dll` / `prebuilds/**`。
2. **prune 不认 peerDependencies** —— 现象是启动后
   `Cannot find package '@deepseek-ai/dsh-credentials' imported from …/app.asar/node_modules/…`。
   已用 `prune: false` 关掉（staging 里没有开发依赖可删，关掉是安全的）。
3. **staging 要自己声明「我是 Forge 项目」** —— `resolveDir()` 会从目标目录**向上**找标记
   （`package.json` 的 `config.forge`，或 `devDependencies` 里有 `@electron-forge/cli`）。
   找不到就一路找到**仓库根**，把仓库当成要打包的项目，报错却是什么
   `Failed to locate module "@standard-schema/spec" from …/YuanMy/node_modules/…`。
   所以生成的 package.json 里有 `config: { forge: './forge.config.ts' }` + `devDependencies.electron`。
4. **块注释里别写裸 glob** —— 形如「两颗星 + 斜杠 + 星号」的字面量会提前结束注释，
   报出来的是莫名其妙的 `Unexpected token '.'`（`build-app.ts` 里加了 `node --check` 自检兜住）。

## 怎么判断「打包产物坏了」

按这个顺序看，基本一次定位：

| 现象 | 先看哪 |
| --- | --- |
| 窗口开不了 / 白屏 | `Contents/Resources/app.asar/desktop/main.ts` 与 `desktop/preload.cjs` 是否都在、`"type": "module"` 是否还在 staging 的 package.json 里 |
| 窗口能开、agent 永远「不可用」 | 终端日志里 host 子进程的第一句报错（`[host] …`）。常见：缺包（prune 删了）、fuse 关了、`ELECTRON_RUN_AS_NODE` 没传 |
| 日志里 `dlopen` / `Library not loaded` | `asar.unpack` 的 glob 覆盖不全（见坑 1） |
| `Failed to locate module "X" from "…/build/app"` | staging 的 `node_modules` 少包，或占位包没放 |
| `Failed to locate module "X" from "…/YuanMy"` | 项目目录认错了（见坑 3） |

## 改打包时要一起改的地方

- `app/desktop/forge.config.ts` —— makers / asar.unpack / fuses / outDir
- `app/desktop/scripts/build-app.ts` —— staging 里放什么文件（**加了新的运行时目录要在这里复制**，
  比如以后 `app/opencli/` 要被桌面端用到）
- `app/desktop/main.ts` 的 `resolveHostRuntime()` / `defaultProjectDir()` —— 打包形态的
  运行时与默认工作目录（打包后 `process.cwd()` 是 `/`，所以默认取「上次打开的项目 → 家目录」）
- `package.json` 的 `main` 字段（`app/desktop/main.ts`）—— Forge 的 `import-existing-project`
  第一步就是它，`electron-forge start` 也读它
