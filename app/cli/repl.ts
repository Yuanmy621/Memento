/**
 * 交互式 REPL 与一次性执行：读一行输入、驱动一个回合、把结果渲染到终端。
 *
 * 内置命令（`/help`、`/model`、`/session` 等）在这里直接处理，其余 `/名字` 交给
 * `.agents/commands` 里的用户命令。
 *
 * @module Memento/repl
 */

import { createInterface, type Interface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Kernel } from './kernel.ts'
import { expandCommand, listCommands, matchCommand, type CommandDef } from './commands.ts'
import { listTools } from './kernel.ts'
import type { Options } from './options.ts'
import { attachRenderer, bold, cyan, gray, red, yellow, type Renderer } from './ui.ts'

/** `/help` 文本；`commands` 为空时只列内置命令。 */
function commandHelp(commands: readonly CommandDef[]): string {
  const lines = [
    `${bold('内置命令')}`,
    `  ${cyan('/help')}            显示本帮助`,
    `  ${cyan('/commands')}        列出项目里的用户命令（.agents/commands）`,
    `  ${cyan('/tools')}           列出已注册的工具`,
    `  ${cyan('/model')} [id]      查看或切换模型（下一次请求生效）`,
    `  ${cyan('/session')}         显示当前会话 id`,
    `  ${cyan('/exit')}            退出（等同 Ctrl-D）`,
  ]
  if (commands.length > 0) {
    lines.push('', `${bold('用户命令')}${gray('（定义在 .agents/commands/，只在触发的那一回合注入指令）')}`)
    for (const def of commands) {
      lines.push(`  ${cyan(`/${def.name}`.padEnd(14))} ${gray(def.description)}`)
      if (def.argsHint !== '') lines.push(`  ${' '.repeat(14)} ${gray(`参数: ${def.argsHint}`)}`)
    }
  }
  lines.push('', `${gray('快捷键：回合进行中按 Ctrl-C 中断当前回合；空闲时按 Ctrl-C 退出。')}`)
  return lines.join('\n')
}

/** 把用户输入变成一个用户消息。 */
function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    // `source` 是必填的来源标记，`kind: 'user'` 表示真人输入。
    source: { kind: 'user' },
  })
}

/** 一次提问 → 等待回合结束 → 汇报结果。 */
async function runTurn(kernel: Kernel, renderer: Renderer, input: string): Promise<boolean> {
  const { agent } = kernel
  renderer.reset()
  agent.followup(userMessage(input))
  // `whenIdle()` 不会因为模型/工具失败而 reject（内核在驱动边界吞掉了异常），
  // 所以真实结果要看 renderer 从 `turn/end` / `agent/error` 收到的事件。
  await agent.whenIdle()
  const stats = renderer.stats()
  if (stats.outcome === 'completed') {
    process.stdout.write(gray(`\n— 完成 · ${stats.toolCalls} 次工具调用 —\n`))
    return true
  }
  if (stats.outcome === 'aborted') {
    process.stdout.write(gray('\n— 已中断 —\n'))
    return false
  }
  if (stats.outcome === 'max-tokens') {
    process.stdout.write(yellow('\n— 达到输出上限，回答被截断 —\n'))
    return false
  }
  process.stdout.write(red(`\n— 失败: ${stats.error ?? '未知错误'} —\n`))
  return false
}

/**
 * 一次性执行：`Memento -p "..."`。
 */
export async function runOneShot(kernel: Kernel, options: Options, prompt: string): Promise<number> {
  const renderer = attachRenderer(kernel.ctx, kernel.agent, {
    showReasoning: !options.noReasoning,
    showToolResults: true,
  })
  try {
    const ok = await runTurn(kernel, renderer, prompt)
    return ok ? 0 : 1
  } finally {
    renderer.dispose()
  }
}

/**
 * 交互式 REPL。
 */
export async function runRepl(kernel: Kernel, options: Options): Promise<number> {
  const { ctx, agent } = kernel
  const interactive = stdin.isTTY === true
  const rl: Interface = createInterface({ input: stdin, output: stdout, terminal: interactive })
  const renderer = attachRenderer(ctx, agent, {
    showReasoning: !options.noReasoning,
    showToolResults: true,
  })

  /** 当前是否有一个回合在跑（决定 Ctrl-C 的语义）。 */
  let busy = false
  /** `/model` 的落点：由 `agent/request` waterfall 在每次请求前读取。 */
  const route: { model: string } = { model: options.model }

  // `agent/request` 是一次 waterfall：每个监听者都能改写即将发出的请求配置，
  // 用它实现「运行中切换模型」，不必重建 agent 或会话。
  const offRoute = ctx.on('agent/request', async ({ agent: subject }, next) => {
    const config: LlmCallConfig = await next()
    if (subject !== agent || config.model === route.model) return config
    return { ...config, model: route.model }
  })

  rl.on('SIGINT', () => {
    if (busy) {
      agent.cancel({ kind: 'user' })
      stdout.write(`\n${yellow('已请求中断当前回合…')}\n`)
      return
    }
    stdout.write('\n')
    rl.close()
  })

  // 用行队列而不是 `rl.question()`：管道输入时整段数据会在同一 tick 内产生多个
  // 'line'，question() 只接住一个、其余被丢掉；队列 + 'close' 哨兵对两种输入都成立。
  const pending: string[] = []
  let wake: (() => void) | undefined
  let closed = false
  rl.on('line', line => {
    pending.push(line)
    wake?.()
    wake = undefined
  })
  rl.on('close', () => {
    closed = true
    wake?.()
    wake = undefined
  })

  /** 取下一条输入；EOF 返回 `undefined`。 */
  async function nextLine(): Promise<string | undefined> {
    for (;;) {
      const line = pending.shift()
      if (line !== undefined) return line
      if (closed) return undefined
      await new Promise<void>(resolve => { wake = resolve })
    }
  }

  try {
    // 命令表只在进入循环前读一次：改命令文件后重开 REPL 生效（避免每回合都扫盘）。
    const commands = await listCommands(options.cwd)
    if (commands.length > 0) {
      stdout.write(gray(`  已加载 ${String(commands.length)} 个用户命令：${commands.map(def => `/${def.name}`).join('、')}\n`))
    }

    for (;;) {
      if (interactive) {
        rl.setPrompt(cyan('› '))
        rl.prompt()
      }
      const input = await nextLine()
      if (input === undefined) break
      const text = input.trim()
      if (text.length === 0) continue

      if (text.startsWith('/')) {
        const [command, ...rest] = text.split(/\s+/)
        if (command === '/exit' || command === '/quit') break
        if (command === '/help') { stdout.write(commandHelp(commands) + '\n'); continue }
        if (command === '/commands') {
          stdout.write(commands.length === 0
            ? gray('  还没有命令。在 .agents/commands/<名字>.md 里写一个即可。\n')
            : commands.map(def => `  ${cyan(`/${def.name}`.padEnd(14))} ${gray(def.description)}`
              + (def.argsHint === '' ? '' : `\n${' '.repeat(16)}${gray(`参数: ${def.argsHint}`)}`)).join('\n') + '\n')
          continue
        }
        if (command === '/tools') {
          const tools = listTools(ctx)
          stdout.write(tools.map(tool => `  ${cyan(tool.name.padEnd(12))} ${gray(tool.description)}`).join('\n') + '\n')
          continue
        }
        if (command === '/session') {
          stdout.write(`  ${kernel.sessionId}\n`)
          continue
        }
        if (command === '/model') {
          const next = rest[0]
          if (next === undefined) {
            stdout.write(`  当前模型: ${bold(route.model)} ${gray('(下一次请求生效)')}\n`)
          } else {
            route.model = next
            stdout.write(`  已切换到 ${bold(next)}；下一次请求生效。\n`)
          }
          continue
        }
        // 内置命令没命中：看是不是 .agents/commands 里的用户命令
        const hit = matchCommand(text, commands)
        if (hit !== undefined) {
          const expanded = await expandCommand(hit.def, hit.args)
          for (const path of expanded.missing) {
            stdout.write(red(`  ⚠ 命令引用的文件读不到：${path}\n`))
          }
          busy = true
          try {
            await runTurn(kernel, renderer, expanded.text)
          } finally {
            busy = false
          }
          continue
        }
        stdout.write(red(`未知命令 ${command}；用 /help 查看可用命令。\n`))
        continue
      }

      busy = true
      try {
        await runTurn(kernel, renderer, text)
      } finally {
        busy = false
      }
    }
    return 0
  } finally {
    offRoute()
    renderer.dispose()
    rl.close()
  }
}

/** 打印一次「凭据缺失」的提示。 */
export function printMissingCredential(): void {
  stdout.write([
    yellow('未找到 DeepSeek API key —— agent 已启动，但第一次请求会失败。'),
    gray('任选一种方式提供：'),
    gray('  1. export DEEPSEEK_API_KEY=sk-…'),
    gray('  2. export Memento_API_KEY=sk-…（优先）'),
    gray('  3. 用 DSH 自己写入的凭据库 ~/.dsh/.credentials.yaml'),
    '',
  ].join('\n'))
}
