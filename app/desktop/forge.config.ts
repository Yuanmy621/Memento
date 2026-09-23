import { fileURLToPath } from 'node:url'
/**
 * Electron Forge 配置（`app/desktop/forge.config.ts`），`package` / `make` 用它出 .app 与 zip、dmg。
 *
 * 打包对象是 `scripts/build-app.ts` 收拢出的自包含目录 `build/app/`，不是仓库根：Forge 会复制整个项目目录再按
 * `package.json` 的生产依赖 prune，而 prune 假定扁平的 `node_modules`，在 pnpm 的符号链接布局下会删掉仍在用的包
 * （该目录里的生产依赖已用 `nodeLinker: hoisted` 物化，本文件也被复制进去）。Forge 用 jiti 加载 `.ts` 配置
 * （`@electron-forge/core` 对 `.ts/.mts/.cts` 走 jiti），文件名与 staging 的 `package.json` 里 `config.forge` 一致。
 *
 * @module Memento/desktop/forge.config
 */

import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives'

export default {
  /** 产物目录：默认的「项目目录下 `out/`」会埋在 `build/app/` 里，所以往上退两级落到仓库根的 `out/`。 */
  outDir: '../../out',

  packagerConfig: {
    name: 'Memento Agent',
    /**
     * 应用图标（不带扩展名）：macOS 用 `assets/icon.icns`，Windows 用 `assets/icon.ico`。
     * 路径相对 staging 目录（`build/app`），所以 `build-app.ts` 要把 `assets/` 复制进去。
     */
    /*
     * 取绝对路径：`normalizeIconExtension()` 把 `icon` 原样交给 `fs.pathExists`，相对路径按进程 cwd（仓库根）
     * 解析，找不到时静默回落成 Electron 默认图标；用 `import.meta.url` 算出的路径在 staging 与开发目录两边都成立。
     */
    icon: fileURLToPath(new URL('./assets/icon', import.meta.url)),
    appBundleId: 'net.Memento.agent',
    appCategoryType: 'public.app-category.developer-tools',
    /*
     * 打进 asar；原生二进制要排除在外（见下面的 `unpack`），`dlopen` 读不了 asar 里的 `.node`，`spawn` 也执行不了
     * asar 里的可执行文件。键名是 `asar.unpack` 而非 electron-builder 的 `asarUnpack`，写错不报错、只是静默不生效。
     * 本段注释里不能出现裸 glob 字面量，那个字符序列会提前结束块注释。
     */
    asar: {
      unpack: [
        '**/*.node',
        // `sharp` 的原生模块 dlopen 时还要加载同族包里的共享库：`@img/sharp-libvips-darwin-arm64`
        // 只有 `.dylib`、没有 `.node`，只写 `**/*.node` 会漏掉它，报 `Library not loaded: @rpath/libvips-cpp.8.18.6.dylib`。
        '**/*.dylib',
        '**/*.so',
        '**/*.so.*',
        '**/*.dll',
        // node-pty 的 `spawn-helper` 没有 `.node` 后缀，`:node` 之外还得靠这条 glob 才匹配得到它；
        // 它由 node-pty 用 spawn 拉起，要留在真实文件系统上。
        '**/prebuilds/**',
      ].join(','),
    },
    /**
     * 关掉 Forge 的 prune：它只认 `dependencies` / `optionalDependencies`、不认 `peerDependencies`，
     * 而内核的包大量靠 peer 装配（`dsh-llm-deepseek` 的 peer 里有 `dsh-credentials`、`dsh-settings` 等），
     * pnpm 会装上它们，prune 却视为无人依赖而删除，表现为打包正常、启动后 agent 永远不可用
     * （`Cannot find package '@deepseek-ai/dsh-credentials'`）。staging 是按需物化出来的
     * （`pnpm install --prod` + 明确复制的运行时文件），本来就没有开发依赖可删，关掉安全。
     */
    prune: false,
    /**
     * 不重建原生模块：node-pty / koffi 自带 N-API 或平台预编译产物，在 Electron 自带的 Node 24.21 下能直接
     * `require`（`ELECTRON_RUN_AS_NODE=1 electron -e "require('node-pty')"`），Forge 默认的 `@electron/rebuild`
     * 只是多要一次 Xcode 工具链与几分钟。`onlyModules: []` 即一个都不重建；换平台或升级 Electron 后要重新验证，
     * koffi 的原生库按平台准备（只有 Windows 分支才会 `await import('koffi')` 去 load dll），Windows 产物需另外处理。
     */
    rebuildConfig: { onlyModules: [] },
  },

  makers: [
    // .zip 里是 .app，解压即用；自动更新（Squirrel / update.electronjs.org）也要求这个形态。
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    // .dmg 供人安装（拖进 Applications）；依赖 appdmg → fs-xattr / macos-alias，
    // 这两个包的构建脚本在 pnpm-workspace.yaml 的 allowBuilds 里放行。
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' }, platforms: ['darwin'] },
  ],

  plugins: [
    // 自动把检测到的 `.node` 也排除出 asar，与上面 `asar.unpack` 的规则互为保险。
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      /**
       * `RunAsNode` 保持开启：内核是子进程，打包形态下靠 `ELECTRON_RUN_AS_NODE=1 <App 里的 Electron 二进制>
       * host/index.ts` 启动（见 `main.js` 的 `resolveHostRuntime()`），关掉这个 fuse 内核就起不来，
       * 表现是「窗口能开、agent 永远不可用」；要关它就得改成内置一个 Node 运行时。
       */
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      // 宿主入口、渲染进程、node_modules 全都在 asar 里，不需要从 asar 外加载代码。
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
}
