import { fileURLToPath } from 'node:url'
/**
 * Electron Forge 配置（`app/desktop/forge.config.ts`）。
 *
 * ## 为什么这个文件不在仓库根、也不直接打包仓库根
 *
 * Forge 的 `package` 会把**项目目录整个**复制进 `app.asar`，然后按 `package.json`
 * 的生产依赖做一次 prune。直接拿仓库根当项目目录有两个问题：
 *
 *   1. **pnpm 的 node_modules 是符号链接布局**（`node_modules/<包>` → `.pnpm/<包>@<版本>/…`），
 *      Forge 的 prune 走的依赖遍历算法假定的是 npm/yarn 那种**扁平**布局 ——
 *      在 pnpm 布局下它会漏掉「靠 `.pnpm` 同级目录解析」的依赖，然后**把还要用的包删掉**，
 *      产物启动即崩。这不是配置能绕过去的，必须换布局。
 *   2. 仓库里还有 10MB 的渲染进程 bundle、测试脚本、opencli 适配器、文档 ——
 *      全打进 asar 既大又没必要。
 *
 * 所以打包链路是：**`scripts/build-app.js` 先把「要进应用的东西」收拢成一个自包含目录
 * `build/app/`**（生产依赖用 `nodeLinker: hoisted` 物化成扁平布局 + 渲染进程 + host 源码），
 * 本文件被复制到那个目录里，然后：
 *
 * ```bash
 * npm run app:build      # 生成 build/app/
 * npm run package        # electron-forge package build/app   → out/…（未压缩的 .app）
 * npm run make           # electron-forge make build/app      → out/make/**（zip + dmg）
 * ```
 *
 * ⚠️ 这个文件是 `.ts`：Forge 用 **jiti** 加载配置（`@electron-forge/core` 的
 * `forge-config.ts` 里对 `.ts/.mts/.cts` 走 jiti，其余走 rechoir），所以能直接吃 TS。
 * 名字必须与 staging 的 `package.json` 里 `config.forge` 指的那个一致。
 *
 * （Forge 的 `package`/`make` 接受一个目录参数，所以不必 cd 过去。）
 *
 * @module YuanMy/desktop/forge.config
 */

import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives'

export default {
  /**
   * 产物目录。默认是「项目目录下的 out/」，而项目目录是 `build/app/` ——
   * 产物埋在 staging 里不好找，所以往上退两级，统一落在**仓库根的 `out/`**。
   */
  outDir: '../../out',

  packagerConfig: {
    name: 'YuanMy Agent',
    /**
     * 应用图标（不带扩展名）：macOS 用 `assets/icon.icns`，Windows 用 `assets/icon.ico`。
     * 路径相对 **staging 目录**（`build/app`），所以 `build-app.ts` 要把 `assets/` 复制进去。
     */
    /*
     * ⚠️ 必须给**绝对路径**：`@electron/packager` 的 `normalizeIconExtension()` 把 `icon`
     * 原样交给 `fs.pathExists`，相对路径是按**进程 cwd**（仓库根，`electron-forge package build/app`）
     * 解析的 —— 写 `'assets/icon'` 它会去找 `<仓库根>/assets/icon.icns`，找不到就
     * **静默回落成 Electron 默认图标**（打包一路 ✔，只有 Dock 上图标不对）。
     * 用 `import.meta.url` 算出来：staging 里是 `build/app/assets/icon`，开发目录里是
     * `app/desktop/assets/icon`，两边都成立。
     */
    icon: fileURLToPath(new URL('./assets/icon', import.meta.url)),
    appBundleId: 'net.yuanmy.agent',
    appCategoryType: 'public.app-category.developer-tools',
    /**
     * 打进 asar。原生二进制必须**排除在外**（见下面的 `asar.unpack`）：
     * `dlopen` 读不了 asar 里的 `.node`，`spawn` 也执行不了 asar 里的可执行文件。
     *
     * ⚠️ 键名是 `asar.unpack`，**不是** electron-builder 的 `asarUnpack`。
     * 写错不会报错，只是静默不生效 —— 现象是打包一路 ✔、启动后内核起不来：
     * 那种写法在这里被原样忽略，只有 AutoUnpackNativesPlugin 兜住了 .node 文件，
     * 于是就「以为生效了」。（真踩过。）
     *
     * 📌 小坑：**别在这一段注释里写裸的 glob**（形如 两星斜杠星号，见下）；
     * 那个字符序列会**提前结束块注释**，报出来的是莫名其妙的
     * `Unexpected token '.'`。（也真踩过。）
     */
    asar: {
      unpack: [
        '**/*.node',
        // 原生模块**动态链接的共享库**也要在外面：`sharp` 的
        // `@img/sharp-darwin-arm64/lib/*.node` 能 unpack，但它 dlopen 时要加载
        // `@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.6.dylib` ——
        // 那个包只有 .dylib、没有 .node，只写 `**/*.node` 就会漏掉它，
        // 报 `Library not loaded: @rpath/libvips-cpp.8.18.6.dylib`。
        '**/*.dylib',
        '**/*.so',
        '**/*.so.*',
        '**/*.dll',
        // node-pty 的 `spawn-helper` 是个**没有 .node 后缀的可执行文件**，
        // 只靠 `**/*.node` 匹配不到它（它被 node-pty 用 spawn 拉起，必须在真实文件系统上）。
        '**/prebuilds/**',
      ].join(','),
    },
    /**
     * **关掉 Forge 的 prune。**
     *
     * prune 会按 `package.json` 的生产依赖重算「哪些包要留」，然后删掉其余部分。
     * 它只遍历 `dependencies` / `optionalDependencies`（`devDependencies` 只在根模块上看），
     * **完全不认 `peerDependencies`** —— 而 DSH 的包大量用 peer 来装配内核
     * （例如 `dsh-llm-deepseek` 的 12 个 peer 里有 `dsh-credentials`、`dsh-settings`、
     * `dsh-home-paths`…，它们都不在应用根 package.json 里）。pnpm 会自动安装 peer，
     * 所以 staging 里**有**这些包，但 prune 认为「没人依赖」就把它们删了。
     *
     * 失败现象很隐蔽：打包一路 ✔，启动后窗口能开、agent 永远「不可用」，
     * 日志里只有子进程的一句
     * `Cannot find package '@deepseek-ai/dsh-credentials' imported from …/app.asar/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`
     * （真踩过）。要在保留 prune 的前提下修，就得把十几个 peer 手工提升到根
     * `dependencies` —— 那等于把「哪天真缺了」变成一个静默的维护负担。
     *
     * 关掉它是安全的：staging 目录本来就是**按需物化**出来的
     * （`pnpm install --prod` + 明确复制的运行时文件），里面没有开发依赖可删。
     */
    prune: false,
    /**
     * **不重建原生模块。**
     *
     * node-pty / koffi 都自带 N-API 或平台预编译产物，实测在 Electron 自带的
     * Node 24.21 下能直接 `require` 成功（`ELECTRON_RUN_AS_NODE=1 electron -e "require('node-pty')"`），
     * 所以 Forge 默认的 `@electron/rebuild` 那一步是多余的：它要 Xcode 工具链、
     * 要几分钟，还会把「已经验证过能加载」的产物换成刚编出来的。
     *
     * `onlyModules: []` = 「一个模块都不要重建」。
     * ⚠️ 换平台（Windows/Linux）或升级 Electron 之后要重新验证这条 —— koffi 的原生库
     * 目前在本机根本没装（只有 Windows 分支才会 `await import('koffi')` 去 load dll），
     * Windows 产物要另外准备。
     */
    rebuildConfig: { onlyModules: [] },
  },

  makers: [
    // .zip 里是 .app，解压即用；也是自动更新（Squirrel/update.electronjs.org）要的形态。
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    // .dmg 是给人装的（拖进 Applications）。依赖 appdmg → fs-xattr / macos-alias，
    // 这两个包的构建脚本在 pnpm-workspace.yaml 的 allowBuilds 里放行。
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' }, platforms: ['darwin'] },
  ],

  plugins: [
    // 自动把检测到的 `.node` 也排除出 asar（与上面的 asarUnpack 互为保险）。
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      /**
       * ⚠️ **`RunAsNode` 必须保持开启**。
       *
       * Forge 官方模板默认把它关掉（安全加固：防止别人拿你的 Electron 当 node 用）。
       * 但 YuanMy 的内核是**子进程**，在打包形态下正是靠
       * `ELECTRON_RUN_AS_NODE=1 <App 里的 Electron 二进制> host/index.ts` 跑起来的
       * （见 `main.js` 的 `resolveHostRuntime()`）—— 关掉这个 fuse，内核就起不来，
       * 表现是「窗口能开、agent 永远不可用」。要关它就得改成内置一个 Node 运行时，
       * 那是另一个量级的改动（体积 +60MB、还要处理 Node 的分发许可）。
       */
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      // 宿主入口、渲染进程、node_modules 全都在 asar 里，不需要从 asar 外加载代码。
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
}
