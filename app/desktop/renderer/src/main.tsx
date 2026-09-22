/**
 * 渲染进程入口：挂载 React 根组件。
 *
 * 这是个**经典脚本**（由 `index.html` 用 `<script src>` 加载，不是 ES module）：
 * 构建脚本（`scripts/build-renderer.js`）把 React、Streamdown、Tailwind 一起
 * 打成单个 IIFE，`file://` 下不需要任何模块解析。
 *
 * 注意：源码是 `.tsx`，但**类型检查与打包都独立于 Electron** ——
 * 类型由 `app/desktop/renderer/tsconfig.json` 检查，产物由 esbuild 生成。
 *
 * @module Memento/desktop/renderer
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'

const container = document.getElementById('root')

if (container === null) {
  document.body.textContent = '初始化失败：找不到 #root 挂载点。'
} else if (globalThis.window.Memento === undefined) {
  // preload 没注入：这是主进程配置问题，把原因直接摆在界面上。
  container.textContent = '初始化失败：window.Memento 不存在，preload 脚本没有加载。'
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
