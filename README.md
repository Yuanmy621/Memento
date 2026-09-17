# YuanMy

一个跑在终端里的 **coding agent**，内核完全建立在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）之上。

DSH 本身是一个插件化的 agent 内核：agent 循环、会话日志、工具执行管线、文件系统 / Shell / 沙箱能力都是独立的 cordis 插件。
`YuanMy` 做的事情是**用手写装配把内核搭起来**，再加上终端交互层和两个自定义工具，最终得到一个能读代码、改代码、跑命令的编码助手。

```
$ npm start                       # 交互式 REPL
$ node src/main.ts -p "重构 src/ui.ts 里的颜色函数"   # 一次性执行
```

---

## 1. 它长什么样

```
YuanMy · 基于 DeepSeek Harness 内核的 coding agent
模型     deepseek-official/deepseek-flash
工作目录 /Users/me/project
会话     YuanMy-20260917115410-jq637s
工具     12 个
凭据     ~/.dsh/.credentials.yaml sk-de…9a3

› 用 tree 看一下项目结构，然后跑一下测试

⋯ 先看目录结构，再确认测试命令是否存在。
⏺ tree .
  ⎿ tree → <path>/Users/me/project</path> (6 行)
⏺ bash npm test
  ⎿ bash → 12 passing exit 0
项目是一个 TypeScript 库……
— 完成 · 2 次工具调用 —
```

- 灰色 `⋯` = 模型推理过程（`--no-reasoning` 可关）
- 青色 `⏺` = 工具调用，`⎿` = 工具结果摘要
- 回合进行中 `Ctrl-C` 中断当前回合，空闲时 `Ctrl-C` 退出

REPL 里还有：`/help`、`/tools`、`/model [id]`（运行中换模型）、`/session`、`/exit`。

---

## 2. 快速开始

要求 **Node.js ≥ 22.19（推荐 24）** —— 直接用 `node` 运行 `.ts`（Node 原生类型擦除），无需构建步骤。

```bash
npm install

# 提供 DeepSeek API key（三种方式任选）
export DEEPSEEK_API_KEY=sk-...      # ① 环境变量
export YuanMy_API_KEY=sk-...          # ② 优先级更高的环境变量
# ③ 不设置也行：会自动读取 DSH 自己写入的 ~/.dsh/.credentials.yaml

npm start
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-p, --prompt <text>` | 一次性执行一个任务后退出（退出码 0 成功 / 1 回合失败） |
| `--cwd <dir>` | agent 的工作目录（文件工具与 bash 的基准） |
| `--model <id>` / `--provider <id>` | 模型与 provider（默认 `deepseek-flash` / `deepseek-official`） |
| `--effort <off\|low\|high\|max>` | 推理强度 |
| `--session <id>` / `--resume <id>` | 指定新会话 id / 恢复已持久化的会话 |
| `--state-dir <dir>` | 会话与运行数据目录（默认 `<cwd>/.YuanMy`） |
| `--no-persist` | 不写会话日志 |
| `--no-reasoning` | 不显示推理过程 |
| `--list-tools` | 打印内核注册的全部工具后退出 |

会话以明文 JSONL 落在 `.YuanMy/sessions/<项目>/<会话 id>/session.v3.jsonl`，可以直接 `cat` / `jq` 查看 DSH 的完整事件流。

---

## 3. 代码结构

```
src/
  main.ts         入口：参数 → 凭据 → 启动内核 → REPL / 一次性执行
  kernel.ts       核心：用 cordis 手工装配整个 DSH 插件树
  options.ts      零依赖命令行解析
  credentials.ts  API key 解析（环境变量 → DSH 凭据库）
  prompt.ts       coding agent 的 persona 与系统提示词 section
  tools.ts        自定义工具：tree、fetch_url（defineTool 完整示例）
  repl.ts         交互式循环、斜杠命令、中断处理
  ui.ts           流式渲染、工具调用可视化、颜色
```

一屏就能读完的装配逻辑在 `kernel.ts`，它是理解 DSH 内核最好的入口。

---

## 4. 内核是怎么搭起来的

DSH 的官方形态是用 `cordis.yml` 交给加载器组装。这里**不用加载器**，而是显式 `await ctx.plugin(...)` —— 装配顺序、依赖、配置全部写在一个文件里，可读性优先。

```ts
const ctx = new Context()                                   // 根上下文，没有 App / ctx.start()

await ctx.plugin(LlmRuntime)                                // ctx.llm
await ctx.plugin(SessionStore)                              // ctx.sessions
await ctx.plugin(SessionProjectionRegistry)                 // ctx.sessionProjections
await ctx.plugin(SystemPrompt, { personaPrefix: '…' })      // ctx.systemPrompt
await ctx.plugin(ToolRuntime)                               // ctx.tools（inject: systemPrompt）
await ctx.plugin(AgentRegistry)                             // ctx.agents
await ctx.plugin(AgentLoop, { agents: [] })                 // ctx.agentLoop
```

装配里踩到的四条硬规则，都在 `kernel.ts` 里以注释形式标了出来：

1. **顺序是语义的一部分。** `await ctx.plugin(X)` 在 `X` 的 `inject` 依赖未就绪时**不会报错**，而是静静停在 `PENDING`。所以必须按依赖顺序逐个 await（`ctx.tools` 依赖 `ctx.systemPrompt`，`agentLoop` 依赖前六个）。
2. **装配完要自检。** 正因为上面那条，`kernel.ts` 在启动最后显式检查七个必需服务是否真的存在，缺失就带着服务名报错，而不是等到第一次对话才莫名其妙地失败。
3. **`whenIdle()` 不会因为模型失败而 reject。** agent 循环把驱动异常吞在边界内，所以真实结果要从事件里读：`turn/end` 的 `reason`（`completed` / `aborted` / `max-tokens` / `error`）与 `agent/error`。`repl.ts` 就是这么判断回合结果的。
4. **凭据要在导入 adapter 之前装好。** DeepSeek adapter 从「启动环境快照」按变量名取 key，因此 `main.ts` 先 `installApiKey()`，再动态 `import('./kernel.ts')`。

### 挂载了哪些插件

| 分组 | 插件 | 提供 |
| --- | --- | --- |
| 内核 | `dsh-llm` `dsh-session` `dsh-session-projection` `dsh-system-prompt` `dsh-tools` `dsh-agent` `dsh-agent-loop` | agent 循环与六个必需服务 |
| 模型 | `dsh-llm-deepseek` `dsh-deepseek-llm-api-extensions` `dsh-llm-retry` | DeepSeek 路由 + 请求级重试 |
| 执行能力 | `dsh-subprocess-local` `dsh-shell-env` `dsh-bash-local` `dsh-fs-local` `dsh-fs-observation-policy` `dsh-jobs-local` `dsh-spill-local` `dsh-attachment-local` | `ctx.subprocess` / `ctx.shell` / `ctx.fs` / `ctx.jobs` / `ctx.spillStore` / `ctx.attachments` |
| 工具 | `dsh-tool-fs` `dsh-tool-fs-search` `dsh-tool-bash` `dsh-tool-jobs` + 自定义 `YuanMy-tools` | `read` `write` `edit` `read_image` `glob` `grep` `bash` `job_*` `tree` `fetch_url` |
| 持久化 | `dsh-session-persistence-jsonl` | 明文 JSONL 会话日志，支撑 `--resume` |

### 为什么没有沙箱与审批

`dsh-fs-local` 与 `dsh-bash-local` 都是**不受限**的本地 provider：它们的 `sandboxMode` 是 `undefined`，因此工具 schema 里不会出现提权字段，也不会有任何调用被拦下来要审批 —— 这正是 `sdk-minimal` 那套「独立 SDK 形态」的做法。

想换成受限形态，需要把这两个 provider 换成 `dsh-fs-sandbox` + `dsh-bash-sandbox`，再挂 `dsh-sandbox-local` + `dsh-sandbox-policy`（`mode: workspace-write`）和 `dsh-user-approval`；注意两条硬约束：同一个 `ctx.fs` / `ctx.shell` 只能有一个 provider，且受限 provider 缺少 `ctx.sandboxPolicy` 时会在挂载阶段直接报错。

---

## 5. 自定义工具：`defineTool` 完整示例

`src/tools.ts` 是一个标准插件（`name` + `inject` + `apply(ctx, config)` + schemastery `Config`），补了两个官方内核没有、但编码时很顺手的工具：

- **`tree`** —— 一次看清项目结构（目录在前、自动跳过 `node_modules`/`.git` 等），比逐层 `glob` 省 token；
- **`fetch_url`** —— 抓取 URL 文本，用于读在线文档或失败的接口。

一个工具由四部分组成，缺一不可：

```ts
export const Config = z.object({ cwd: z.string().required() })   // ① 插件配置，挂载时校验

ctx.tools.register(defineTool({
  name: 'tree',                                                  // ② 模型看到的名字
  description: 'Show a directory as an indented tree. …',
  parameters: {                                                  // ③ 参数 DSL：对象根是隐式的，
    path: { type: 'string', description: '…' },                   //    每个属性默认可选，
    depth: { type: 'integer', description: '…' },                 //    要必填得写 required: true
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { … } },  // ④ 规范值 schema
    render: (_args, value) => [{ type: 'text', text: value.text }],              //    规范值 → 模型可见内容
  },
  isConcurrencySafe: () => true,                                 // 只读工具可并行
  async execute(args, exec) {
    exec.signal.throwIfAborted()                                 // 必须尊重取消信号
    return { root, text, entries, truncated }
  },
}))
```

要点：`defineTool` 会**先**按 `parameters` 校验模型给的参数再进 `execute`；返回值必须能通过 `output.schema`；`render` 的输出必须可 JSON 序列化。工具的注册时机也灵活 —— DSH 在**每次组装 prompt 时**才汇总工具表，所以运行中注册的新工具下一次请求就能用。

---

## 6. 扩展点速查

| 想做的事 | DSH 的做法 | 本项目中的例子 |
| --- | --- | --- |
| 加一个工具 | `ctx.tools.register(defineTool({…}))` | `src/tools.ts` |
| 改系统提示词 | `ctx.systemPrompt.section({ name, order, text })`，`order` 决定位置 | `src/prompt.ts`（300 / 1950） |
| 运行中改模型 / 请求参数 | 监听 `agent/request` waterfall，`return { ...config, model }` | `repl.ts` 的 `/model` |
| 拦截或改写工具调用 | `tools/pre-execute` / `post-execute` / `tools/result` 事件 | 官方 `dsh-fs-observation-policy`（先读后写） |
| 换 LLM provider | 继承 `LlmAdapter`，实现 `stream()`，`ctx.llm.registerAdapter()` | 官方 `dsh-llm-deepseek` |
| 换文件系统 / Shell | 挂另一个 provider（如 `dsh-fs-sandbox`） | `kernel.ts` 第 3 组 |
| 观察流式输出 | `agent/assistant-stream` 事件（`chunk.type === 'text-delta'`） | `src/ui.ts` |
| 读权威历史 | `session/event`（`tool/call` / `tool/result` / `turn/end`） | `src/ui.ts` |

---

## 7. 已知边界

- **无沙箱、无审批**：本地 provider 意味着 agent 拥有当前用户的全部读写与执行权限。这是有意的默认值（与 DSH 的 `sdk-minimal` 形态一致），生产环境请按第 4 节换成受限 provider。
- **单 agent**：没有挂 `dsh-subagent` / `dsh-tool-workflow` / `dsh-tool-todo` / 压缩与技能等插件，这些都可以按同一套 `ctx.plugin` 方式增量加进来。
- **模型目录**：默认 `deepseek-flash`；用 `--model` 或 `/model` 切换，可用值由 DeepSeek provider 决定。
- **依赖版本锁定**：所有 `@deepseek-ai/dsh-*` 固定在 **`0.1.5-rc.2`**，即标准发布线 —— 官方 CLI `@deepseek-ai/dsh`（npm `latest`）依赖 `^0.1.5-rc.1`，解析结果正是它。安装时请认准这条线：
  - 不要按各**子包**自己的 `latest` 标签装：那些标签是过期的（核心停在 `0.1.0-rc.6`，`dsh-tool-fs` / `dsh-fs-local` / `dsh-llm-deepseek` 停在 `0.0.1-rc.1`），混装会因 `inject` 列表不一致而静默停在 PENDING；
  - 也不要用 `0.1.0-rc` 线：它本身缺包（例如没有 `dsh-deepseek-llm-api-extensions`）；
  - 更不要用 `alpha` 线（`0.1.6-alpha.1`）：那是预发布通道，API 会先于标准线变动（例如 `PromptSection.interpolate` 只存在于 alpha 线）。
