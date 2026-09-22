/**
 * 静态图片资源的类型声明。
 *
 * 构建时由 esbuild 的 `loader: { '.png': 'dataurl' }` 内联成 data URL，
 * 所以 import 进来的是**字符串**（不是文件路径）—— 这里把这个契约告诉 TS。
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
