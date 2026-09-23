/**
 * 静态图片资源的类型声明。
 *
 * 构建时由 esbuild 的 `loader: { '.png': 'dataurl' }` 内联成 data URL，import 进来的是字符串。
 *
 * @module Memento/desktop/renderer/src/assets
 */

declare module '*.png' {
  const dataUrl: string
  export default dataUrl
}

declare module '*.svg' {
  const dataUrl: string
  export default dataUrl
}
