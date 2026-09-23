#!/usr/bin/env node
/**
 * 把本目录下的适配器安装到 opencli 的适配器目录（`~/.opencli/clis/`）。
 *
 * opencli 只从 `~/.opencli/clis/<site>/<命令>.js` 发现适配器，且要求真实目录（`entry.isDirectory()`）、只加载
 * `.js`，所以软链与 `.ts` 都用不上。仓库（`app/opencli/clis/`）是唯一事实来源，这个脚本覆盖式同步过去，
 * 改了适配器就跑 `npm run opencli:install`；仓库里删掉的文件也会从目标目录删掉（只动本仓库管理的 site 目录）。
 *
 * @module Memento/opencli/install
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库里的适配器源目录。 */
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'clis')
/** opencli 的适配器目录（它唯一会扫描的地方）。 */
const TARGET = join(homedir(), '.opencli', 'clis')

/** 列出源目录里的站点目录名。 */
async function sites() {
  const entries = await readdir(SOURCE, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

/** 主流程。 */
async function main() {
  await mkdir(TARGET, { recursive: true })
  const names = await sites()
  if (names.length === 0) {
    process.stdout.write(`源目录里没有适配器：${SOURCE}\n`)
    return
  }
  let files = 0
  for (const site of names) {
    const from = join(SOURCE, site)
    const to = join(TARGET, site)
    // 先删后拷：保证「仓库里删了的文件」不会留在安装目录里变成幽灵命令。
    await rm(to, { recursive: true, force: true })
    await cp(from, to, { recursive: true })
    const copied = (await readdir(to)).filter((file) => file.endsWith('.js') && !file.includes('.test.'))
    files += copied.length
    process.stdout.write(`✓ ${site} → ${to}\n    命令: ${copied.join(', ')}\n`)
  }
  process.stdout.write(`\n共安装 ${String(files)} 个适配器文件。\n`)
  process.stdout.write('用 `opencli list | grep <site>` 或直接 `opencli butian center` 验证。\n')
  // 目标目录存在但不可写时，上面的 cp 会抛错；这里不吞异常。
  const check = await stat(TARGET)
  if (!check.isDirectory()) throw new Error(`${TARGET} 不是目录`)
}

main().catch((error) => {
  process.stderr.write(`安装失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
