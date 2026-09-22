#!/usr/bin/env node
/**
 * Memento 入口：解析参数 → 安装凭据 → 启动内核 → 进入 REPL 或一次性执行。
 *
 * 注意这里的 import 顺序是有意的：`./credentials.ts` 必须在
 * `@deepseek-ai/dsh-llm-deepseek`（进而 `dsh-launch-environment`）被加载**之前**
 * 把 key 写进 `process.env`，所以内核用动态 `import()` 延迟载入。
 *
 * @module Memento/main
 */

import { installApiKey, installCredentials, PLUGIN_CREDENTIAL_REFS, fingerprint } from './credentials.ts'
import { helpText, parseOptions, UsageError, type Options } from './options.ts'

/** 退出码约定：0 成功，1 回合失败，2 用法错误，130 被信号中断。 */
const EXIT_OK = 0
const EXIT_TURN_FAILED = 1
const EXIT_USAGE = 2

/** 启动流程。 */
async function main(): Promise<number> {
  let options: Options
  try {
    options = parseOptions(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`参数错误: ${error.message}\n`)
      return EXIT_USAGE
    }
    throw error
  }

  if (options.help) {
    process.stdout.write(helpText())
    return EXIT_OK
  }

  // 1) 先安装凭据：内核里的 DeepSeek adapter 会在请求时从启动环境快照读取它。
  const credential = installApiKey()

  // 1b) 插件要的额外 key（system-one 的 TYPESAFE_API_KEY）：消费方同样是
  //     `process.env[名字]`，所以在载入内核之前一起装好。缺了不算错误 ——
  //     对应工具被调用时才报错，插件挂载时会自己打一行警告。
  installCredentials(PLUGIN_CREDENTIAL_REFS)

  // 2) 再延迟加载内核（此时环境已经就绪），所有工具的相对路径都以 --cwd 为基准。
  const [{ bootKernel, listTools }, { runOneShot, runRepl, printMissingCredential }, { printBanner }] = await Promise.all([
    import('./kernel.ts'),
    import('./repl.ts'),
    import('./ui.ts'),
  ])
  process.chdir(options.cwd)

  const kernel = await bootKernel(options)
  try {
    if (options.listTools) {
      for (const tool of listTools(kernel.ctx)) {
        process.stdout.write(`${tool.name.padEnd(14)} ${tool.description}\n`)
      }
      return EXIT_OK
    }

    printBanner({
      model: options.model,
      provider: options.provider,
      cwd: options.cwd,
      sessionId: kernel.sessionId,
      tools: listTools(kernel.ctx).length,
      credential: credential === undefined ? '未找到（首次请求会失败）' : `${credential.origin} ${fingerprint(credential.key)}`,
      persist: options.persist,
    })
    if (credential === undefined) printMissingCredential()

    if (options.prompt !== undefined) {
      return await runOneShot(kernel, options, options.prompt)
    }
    return await runRepl(kernel, options)
  } finally {
    // 卸载整棵插件树：agent、会话、子进程、文件句柄都在这里收敛。
    await kernel.dispose()
  }
}

try {
  const code = await main()
  process.exitCode = code
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`启动失败: ${message}\n`)
  process.exitCode = EXIT_TURN_FAILED
}
