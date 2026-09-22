# Memento

一个 **coding agent**：内核完全建立在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）之上，同时提供**终端 CLI** 与 **Electron 桌面客户端**两种外壳。

DSH 本身是一个插件化的 agent 内核：agent 循环、会话日志、工具执行管线、文件系统 / Shell / 沙箱能力都是独立的 cordis 插件。
`Memento` 做的事情是**用手写装配把内核搭起来**，再加上两种交互外壳和两个自定义工具，最终得到一个能读代码、改代码、跑命令的编码助手。

```
$ npm start                              # 终端：交互式 REPL
$ npm start -- -p "重构 app/cli/ui.ts 里的颜色函数"   # 终端：一次性执行
$ npm run desktop                        # 桌面：Electron 客户端
```

两种外壳共用**同一个内核装配**（`app/cli/kernel.ts`）与**同一套参数解析**（`app/cli/options.ts`），
所以 `--cwd` / `--model` / `--resume` 这些开关在哪一边语义都一样。

---

## 1. 它长什么样

```
Memento · 基于 DeepSeek Harness 内核的 coding agent
模型     deepseek-official/deepseek-v4-flash
工作目录 /Users/me/project
会话     Memento-20260917115410-jq637s
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
export Memento_API_KEY=sk-...          # ② 优先级更高的环境变量
# ③ 不设置也行：会自动读取 DSH 自己写入的 ~/.dsh/.credentials.yaml

npm start
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-p, --prompt <text>` | 一次性执行一个任务后退出（退出码 0 成功 / 1 回合失败） |
| `--cwd <dir>` | agent 的工作目录（文件工具与 bash 的基准） |
| `--model <id>` / `--provider <id>` | 模型与 provider（默认 `deepseek-v4-flash` / `deepseek-official`） |
| `--effort <off\|low\|high\|max>` | 推理强度 |
| `--session <id>` / `--resume <id>` | 指定新会话 id / 恢复已持久化的会话 |
| `--state-dir <dir>` | 会话与运行数据目录（默认 `<cwd>/.Memento`） |
| `--no-persist` | 不写会话日志 |
| `--no-reasoning` | 不显示推理过程 |
| `--list-tools` | 打印内核注册的全部工具后退出 |

会话以明文 JSONL 落在 `.Memento/sessions/<项目>/<会话 id>/session.v3.jsonl`，可以直接 `cat` / `jq` 查看 DSH 的完整事件流。

### 桌面客户端

```bash
npm run desktop          # 打开 Electron 窗口
```

界面里可以做：发任务、看着正文流式输出（推理过程可折叠）、Markdown 正式渲染
（标题/列表/表格/代码高亮）、逐条查看工具调用与结果、随时中断当前回合、
切换模型与**推理强度**（`low` / `high` / `max`，都只对下一次请求生效）、新建会话、
查看已注册工具。

左侧栏是**「项目 → 会话」两级树**：会话归纳在它所属的项目下面，点项目折叠/展开
（展开才去读盘，项目再多也不拖慢首屏），点会话就用 `--resume` 恢复，当前会话有竖线标记。
标题与轮数直接来自落盘日志（第一条用户消息 + `turn/end` 计数）。
侧栏只保留真正需要常驻的东西（项目树 + 模型 / 强度切换 + 一行底栏），
状态点/工具数/版本挤在底栏一行里，凭据**只在缺失时**才提示。

**切换会话不会中断正在跑的任务**：每个会话有自己的内核子进程，切走只是换前台 ——
还在跑的那个继续跑完并落盘，侧栏给它的行打一个呼吸点；等它跑完（或不忙时）再切回，
内核会被回收，内容走 `--resume` 历史回放。切回一个**仍在跑**的会话则直接挂回同一个内核
（不重启、不丢流式内容）。空闲内核在切换时立刻回收，同时最多留 6 个（每个都是一整个内核）。

输入框下面常驻一行 **token 统计**：未命中输入 / 输出 / 缓存命中 / 命中率，
鼠标悬停（或 Tab 聚焦）弹出**明细卡**：未命中 / 缓存命中 / 缓存写入 / 计费输入合计 /
输出（含推理）/ 命中率，以及**最近一次调用**的四个数。

外观是 Codex 风格：近单色深色主题、无渐变；**整个窗口**都用**系统原生材质**做磨砂玻璃
（macOS `vibrancy` / Windows `acrylic`，不是 CSS `backdrop-filter`）——
侧栏一层同族染色、主界面与顶栏同一层但**颜色更深**（深浅差本身就是层级：侧栏浮起、主区下沉）。
系统标题栏隐藏，拖拽区由界面自己提供。改界面时用 `npm run desktop:watch` 起监听重建。

改完代码至少跑一次类型检查（三个 tsconfig 一起）：

```bash
npm run typecheck          # Node 侧 TS + 渲染进程 TSX + Node 侧 JS
npm run desktop            # 真开窗口（会自动重新构建渲染进程）
npm run desktop:butian     # 带补天 MCP 起桌面端
npm run desktop:host       # 只起内核宿主，输出 NDJSON，可 `| jq` 单看内核链路
npm run opencli:install    # 把 app/opencli 下的适配器同步给全局的 opencli
```

> ⚠️ 改 `main.ts` 时注意：**Electron 的 ESM 主进程入口不能用顶层 `await app.whenReady()`**。
> 入口模块是异步加载的，顶层 await `ready` 会与 Electron 的启动流程互相等待 ——
> 现象是进程活着、日志停在模块加载完成，但**永远不出现窗口**。
> 用 `app.whenReady().then(onReady)` 注册回调（`main.ts` 启动段末尾有详细注释）。

---

## 3. 代码结构

```
.agents/                 仓库级 agent 配置（给 agent 看的，不是产品代码）
  README.md              目录约定、技能格式、技能与命令怎么分
  skills/<名字>/SKILL.md  全局长期技能：进模型会话目录，模型按需加载
  commands/<名字>.md      命令：用户 `/名字` 触发，指令只在那一个回合注入
.claude/skills -> .agents/skills   符号链接（Claude Code 等工具复用同一批技能）

app/
  cli/                   终端形态：一个 .ts 文件一个人
    main.ts              入口：参数 → 凭据 → 启动内核 → REPL / 一次性执行
    kernel.ts            核心：用 cordis 手工装配整个 DSH 插件树
    options.ts           零依赖命令行解析（桌面端也复用它）
    credentials.ts       API key 解析（环境变量 → DSH 凭据库）
    prompt.ts            coding agent 的 persona 与系统提示词 section
    tools.ts             自定义工具：tree、fetch_url（defineTool 完整示例）
    repl.ts              交互式循环、斜杠命令、中断处理
    ui.ts                终端流式渲染、工具调用可视化、颜色

  desktop/               桌面形态：Electron 壳 + 独立的 agent host 子进程
    main.ts             Electron 主进程：窗口、菜单、生命周期、IPC 收口、窗口材质
    preload.ts          安全桥**源码**；构建成 preload.cjs（沙箱 preload 只认 CJS）
    ipc.ts              IPC 频道名与状态形状
    forge.config.ts     Electron Forge 配置（打包成 .app / zip / dmg）
    host/               TS：跑在内核侧的全部逻辑
      index.ts           agent host：把内核跑在独立 Node 进程里
      bridge.ts          内核事件 → UI 帧（复用 CLI 的工具摘要格式化）
      protocol.ts        主进程 ⇄ host 的消息类型契约（渲染进程也复用它的类型）
      sessions.ts        读会话日志，列出「项目 / 会话」（侧栏数据源）
    renderer/           界面：React + Streamdown，源码是 TSX
      src/               app.tsx / use-agent.ts / markdown.tsx / components/
      styles/app.css     Tailwind v4 + Codex 色板 + 原生磨砂玻璃
      dist/              构建产物（不入库）
      tsconfig.json      DOM + JSX 的独立类型检查
    scripts/
      build-renderer.ts  渲染进程打包（esbuild + PostCSS/Tailwind）+ preload.cjs
      build-app.ts       打包用的 staging：生产依赖（hoisted）+ 运行时文件
    README.md            桌面端设计说明：代码地图、技术栈与官方文档、自研 vs 成熟组件

  opencli/               把站点包成 shell 命令（适配器源在这里，装在 ~/.opencli/clis/）
    clis/butian/*.js     补天个人中心：center / vulns / missions / sign
    install.js           同步到 opencli 的适配器目录（npm run opencli:install）
    README.md            命令清单、凭据位置、为什么不需要 Chrome 扩展

  mcp/                   自己带的 MCP 服务器（外部工具，默认不挂载）
    README.md            怎么接到内核上、凭据怎么转发、pnpm 依赖坑
    butian/              补天（butian.net）只读接口：项目大厅 / 排行 / 平台数字 / 个人中心
      server.ts          MCP server 本体（stdio，无需构建）
      client.ts          补天私有接口客户端（envelope 解包 + 错误分类）
```

一屏就能读完的装配逻辑在 `app/cli/kernel.ts`，它是理解 DSH 内核最好的入口。
桌面端为什么要把内核放进子进程、IPC 为什么这么设计，见 `app/desktop/README.md`。

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
| 工具 | `dsh-tool-fs` `dsh-tool-fs-search` `dsh-tool-bash` `dsh-tool-jobs` + 自定义 `Memento-tools` | `read` `write` `edit` `read_image` `glob` `grep` `bash` `job_*` `tree` `fetch_url` |
| 技能 | `dsh-skill` `dsh-skill-filesystem` `dsh-tool-skill` | `ctx.skills` + `skill` 工具；技能放 `.agents/skills/`（见第 5 节） |
| 持久化 | `dsh-session-persistence-jsonl` | 明文 JSONL 会话日志，支撑 `--resume` |

### 为什么没有沙箱与审批

`dsh-fs-local` 与 `dsh-bash-local` 都是**不受限**的本地 provider：它们的 `sandboxMode` 是 `undefined`，因此工具 schema 里不会出现提权字段，也不会有任何调用被拦下来要审批 —— 这正是 `sdk-minimal` 那套「独立 SDK 形态」的做法。

想换成受限形态，需要把这两个 provider 换成 `dsh-fs-sandbox` + `dsh-bash-sandbox`，再挂 `dsh-sandbox-local` + `dsh-sandbox-policy`（`mode: workspace-write`）和 `dsh-user-approval`；注意两条硬约束：同一个 `ctx.fs` / `ctx.shell` 只能有一个 provider，且受限 provider 缺少 `ctx.sandboxPolicy` 时会在挂载阶段直接报错。

---

## 5. 技能（skill）：`.agents/skills`

技能是**给模型按需加载的指令包**，和写死在系统提示词里的规则不同 —— 它只在相关时才进入上下文。
本仓库的技能放在 `.agents/skills/`（与 DSH 仓库同样的位置与格式）：

```
.agents/skills/
  Memento-desktop-ui/SKILL.md    改桌面端界面的固定套路与两个已修 bug 的复现条件
  Memento-mcp/SKILL.md           往 Memento 上接 MCP 服务器的固定套路
  src-hunter/                   SRC / 众测漏洞挖掘工作流（27 个文件 + 上游 MIT LICENSE）
```

`src-hunter` 是 **vendored 的第三方技能**（上游 [MyuriKanao/src-hunter-skill](https://github.com/MyuriKanao/src-hunter-skill)，MIT）：
只落地「能力内核」约 1.1 MB（5 阶段方法论 + 19 个 playbook + 指纹库 + 合规红线），
上游那 46 MB 的 H1 案例库与 3 MB 的 payloader 刻意没进仓库 ——
playbook 把 payload 内联在文件里，砍掉它们不影响可用；需要时按该技能〈收录范围〉用
`$Memento_SKILL_DIRS` 挂上。改写要点与 vendored 技能的规矩见 [`.agents/README.md`](.agents/README.md)。

每个技能是一个目录包，`SKILL.md` 以 YAML frontmatter 开头（`name` + `description` 必填）：

```markdown
---
name: Memento-mcp
description: 往 Memento 上接 MCP 服务器的固定套路 …… 当你要给 Memento 加一个 MCP 服务器时使用。
---

# 正文：写成可执行步骤
```

`description` 决定模型会不会选它，所以要写清「什么时候用」。可选字段
（`whenToUse` / `metadata` / `disable-model-invocation` / `user-invocable`）
与根目录优先级见 [`.agents/README.md`](.agents/README.md)。

### 它是怎么接上内核的

`app/cli/kernel.ts` 挂了 DSH 的三个插件 —— 这三个包本身就属于 DSH 的 skill 体系，
所以 Memento 的技能行为与 DSH CLI 完全一致：

| 插件 | 作用 |
| --- | --- |
| `@deepseek-ai/dsh-skill` | 技能注册表（`ctx.skills`），不含内容 |
| `@deepseek-ai/dsh-skill-filesystem` | 从磁盘发现 `SKILL.md`（解析 frontmatter、监听目录变化） |
| `@deepseek-ai/dsh-tool-skill` | 首个请求前投递「可用技能目录」，并注册 `skill` 工具按需加载正文 |

扫描范围由 `skillDirs()` 显式指定为 `<cwd>/.agents/skills` 与 `<cwd>/.dsh/skills`，
可用 `$Memento_SKILL_DIRS`（冒号分隔）追加。**没有**开启 DSH 的全局默认根
（`~/.dsh/skills`）—— 那是几十个飞书 / 记忆类技能，对编码 agent 是噪声；
想要 DSH 那套默认行为，把 `includeDefaultRoots` 改成 `true` 即可。

技能按 `<cwd>` 定位，所以 `--cwd` / 桌面端「更换工作目录」会连带切换技能集；
目录变化被监听，加了技能下一次请求就能用，不用重启。

### 自查

```bash
node app/cli/main.ts --list-tools | grep '^skill'   # skill 工具已注册
node app/cli/main.ts -p "用 skill 工具加载 Memento-mcp，告诉我它的第二节标题"
```

⚠️ frontmatter 写错（`name` 与目录名不一致、`description` 为空）的技能会被 provider
**静默忽略** —— 技能没生效时先回去核这两项。

---

## 6. 自定义工具：`defineTool` 完整示例

`app/cli/tools.ts` 是一个标准插件（`name` + `inject` + `apply(ctx, config)` + schemastery `Config`），补了两个官方内核没有、但编码时很顺手的工具：

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

### 6.1 决策原语：`app/plugins/system-one/`（TypeSafe / Jev 的架构移植）

同一个 `defineTool` 机制还挂了两个「判断」类工具，把 [TypeSafe System One](https://docs.typesafe.ai/introduction)
的分工搬进来：**模型给判断（带概率与置信度），代码做决策**。

- `sysone_ask` —— 一份 state + 一组原子问题（`choice` / `score` / `noul`），一次请求
  全部评估，直接走官方 Jev；`TYPESAFE_API_KEY` 没配或调用失败就明确报错，**没有本地兜底**；
- `sysone_compose` —— 确定性组合：加权总分（Composite scoring）或置信度门控路由
  （`act` / `review` / `escalate`），**不再花 token**。

默认挂载（两个工具，上下文开销很小）。
接口契约、工具语义、错误行为与实测证据见 `app/plugins/system-one/README.md`。

---

## 7. 扩展点速查

| 想做的事 | DSH 的做法 | 本项目中的例子 |
| --- | --- | --- |
| 加一个工具 | `ctx.tools.register(defineTool({…}))` | `app/cli/tools.ts`（`tree` / `fetch_url`）、`app/plugins/system-one/`（`sysone_ask` / `sysone_compose`） |
| 加一个技能 | 在 `.agents/skills/<名字>/SKILL.md` 写 frontmatter + 正文，无需改代码 | `.agents/skills/` |
| 改系统提示词 | `ctx.systemPrompt.section({ name, order, text })`，`order` 决定位置 | `app/cli/prompt.ts`（300 / 1950） |
| 运行中改模型 / 请求参数 | 监听 `agent/request` waterfall，`return { ...config, model }` | CLI 的 `/model`、桌面端 host 的 `set-model` |
| 拦截或改写工具调用 | `tools/pre-execute` / `post-execute` / `tools/result` 事件 | 官方 `dsh-fs-observation-policy`（先读后写） |
| 换 LLM provider | 继承 `LlmAdapter`，实现 `stream()`，`ctx.llm.registerAdapter()` | 官方 `dsh-llm-deepseek` |
| 换文件系统 / Shell | 挂另一个 provider（如 `dsh-fs-sandbox`） | `kernel.ts` 第 3 组 |
| 观察流式输出 | `agent/assistant-stream` 事件（`chunk.type === 'text-delta'`） | `app/cli/ui.ts`（终端）、`app/desktop/host/bridge.ts`（GUI） |
| 读权威历史 | `session/event`（`tool/call` / `tool/result` / `turn/end`） | 同上 |
| 给桌面端加一个界面动作 | preload 加一个方法 → main 加一个 `ipcMain.handle` → renderer 调用 | `app/desktop/preload.cjs` / `main.ts` / `renderer/src/` |
| 给桌面端加一种 UI 帧 | 在 `host/protocol.ts` 加一个 `HostEvent` 分支，bridge 发出、renderer 消费 | `app/desktop/host/bridge.ts` |
| 读会话历史 / 列会话 | 会话以 JSONL 落在 `<cwd>/.Memento/sessions/<项目>/<会话 id>/session.v3.jsonl`，第一行是头 | `app/desktop/host/sessions.ts` |
| 列会话（项目 → 会话树） | 会话以 JSONL 落在 `<cwd>/.Memento/sessions/<项目>/<会话 id>/session.v3.jsonl`，第一行是头 | `app/desktop/host/sessions.ts` |
| 跨项目列表 | 内核 stateDir 每项目一份库 → 桌面端记一份「最近打开过的项目」（`<userData>/projects.json`），经 `Memento_PROJECT_ROOTS` 交给 host 多扫几个根 | `app/desktop/main.ts` + `host/sessions.ts` |
| 把某个网站包成 agent 能用的命令 | 写 opencli 适配器放 `app/opencli/clis/<site>/`，`npm run opencli:install` 同步到 `~/.opencli/clis/`（要真实目录、只认 .js） | `app/opencli/` |
| 加一个命令（`/名字`） | 在 `.agents/commands/<名字>.md` 写 frontmatter + 指令；`include` 可内联技能正文，仅触发那一回合生效 | `.agents/commands/` |
| 把技能改成命令专用 | 在 `SKILL.md` 的 frontmatter 加 `disable-model-invocation: true`（内核原生政策，不进模型目录） | `.agents/skills/<名字>/SKILL.md` |
| 接一个 MCP 服务器 | `Memento_MCP=<名字> npm start`（默认不挂）；内置的在 `app/cli/kernel.ts` 的 `mcpSpecs()`，也可以丢一个 `<cwd>/.Memento/mcp/<名字>.ts` | `app/mcp/` |
| 回放一个会话的历史 | 恢复会话 = `--resume <id>` 重启内核；界面侧由 host 读日志发 `history` 帧（实时路径与回放路径共用 `protocol.ts` 的词表与 `toOutcome`）。界面重载而内核还活着时走 `history:replay`，不必重启 | `app/desktop/host/history.ts` |
| 拿 token 计量 | `session/event` 的 `assistant/message` 带 `usage`（计数互斥：未命中/命中/写入分开记） | `bridge.ts` 的 `usage` 帧 |
| 切会话而不打断正在跑的任务 | 主进程按 `sessionKey(cwd, sessionId)` 持有多个 host 槽位：忙的留着、闲的收掉；每一帧打上 `hostId`，渲染进程按会话分视图归约（`Store.views`），对组件只暴露当前那一份 | `main.ts` 的 `attach` + `renderer/src/use-agent.ts` 的 `reducer`/`project` |
| 改推理强度 | `agent/request` waterfall 里改 `reasoningEffort`（与改模型同一条路，不重建 agent）；档位来自适配器对**这个模型**申报的 `reasoning.efforts` | `host/index.ts` 的 `route` / `set-effort` |

---

## 8. 已知边界

- **无沙箱、无审批**：本地 provider 意味着 agent 拥有当前用户的全部读写与执行权限。这是有意的默认值（与 DSH 的 `sdk-minimal` 形态一致），生产环境请按第 4 节换成受限 provider。
- **单 agent**：没有挂 `dsh-subagent` / `dsh-tool-workflow` / `dsh-tool-todo` / 压缩与技能等插件，这些都可以按同一套 `ctx.plugin` 方式增量加进来。
- **桌面端还不能打包**：只做了开发态运行（`npm run desktop`）。要出安装包需要再补 `electron-builder` 配置与签名流程，参考 DSH 自己的 `apps/desktop`。
- **改桌面端布局时注意**：`.app-shell` 的 `grid-template-rows: minmax(0, 1fr)` 与子项的 `min-height: 0` 不能删 —— 少了它，内容会把整个外壳撑高（侧栏被拉长、失去内部滚动，长内容卡死渲染进程）。**改这一块时手动展开一段长推理确认**：外壳高度不该超过视口，滚动条应在 `.messages` 内部。
- **桌面端会话列表不生成标题**：标题取会话日志里的第一条用户消息。正式标题应由 `@deepseek-ai/dsh-session-title` 生成（写 `session/title` 事件），但那个插件还需要 `dsh-invariants` 一整套 companion 插件，暂时没挂；读取端已经优先认这个事件。
- **token 统计是会话累计的估算口径**：DSH 的 `inputTokens` 只算**未命中缓存**的部分，命中部分在 `cacheReadTokens`，所以「输入」一栏看起来会比直觉小 —— 悬停明细卡里的「计费输入合计」才是这次请求的完整提示词量。
- **多内核是有上限的**：每个「后台继续跑」的会话都是一整个内核子进程（10MB 级 bundle + 插件 + 可能的 MCP 子进程），所以空闲的会在切换时立刻回收，同时最多 6 个；超了会明确告诉用户「这个后台任务已被中断」，而不是静默杀掉。
- **推理强度下拉只露 `low | high | max`**：适配器还会申报 `off`（关掉推理），但它是「关」不是「一档强度」，放进同一个下拉会让人以为它是最低档。要 `off` 就用启动参数 `--effort off`。
- **技能不扫描全局目录**：默认只看项目里的 `.agents/skills` 与 `.dsh/skills`，`~/.dsh/skills` 里那几十个飞书/记忆类技能不会进编码 agent 的目录（想要就用 `includeDefaultRoots: true` 或 `$Memento_SKILL_DIRS`）。
- **三个 tsconfig，各管一层**：`tsconfig.json`（Node 侧 TS：`app/cli` + `app/desktop/host` + `app/mcp`）、`app/desktop/renderer/tsconfig.json`（渲染进程 TSX，DOM+JSX）、`tsconfig.js.json`（Node 侧 **.js**：Electron 入口与冒烟脚本，`checkJs: false`，只管「被认领」与语法）。
  新增源码目录时**必须把 glob 加进对应的 include** —— 漏了的话 `npm run typecheck` 根本不会检查它，编辑器还会另建推断项目、报出极具误导性的「找不到名称 "node:fs/promises"，请安装 @types/node」（真踩过）。自查办法：`npm run typecheck` 之后确认新文件确实被某个项目收进来了
（`npx tsc --noEmit --listFiles -p <项目> | grep <文件名>`）。
- **MCP 客户端插件用的是过期发布线**：npm 上 `@deepseek-ai/dsh-mcp-client` 只有 `0.0.1-rc.1`（其它 dsh 包锁在 `0.1.5-rc.2`），peer 范围全都对不上。已逐条核对过它实际用到的 API 在 0.1.5-rc.2 上成立，并用 `peerDependencyRules.allowedVersions` 声明；升级到同一条线时要回来清掉这段。细节见 `app/mcp/README.md`。
- **桌面端渲染进程的 bundle 约 10 MB**：其中约 9 MB 是 shiki 的 200 多种语言语法定义（单文件 IIFE 会把「按需加载」全部内联）。实测冷启动到窗口可见约 235–400 ms，暂不处理；瘦身路线见 `app/desktop/README.md`。
- **磨砂玻璃与隐藏标题栏只在 macOS 上验证过**：Windows 走 `backgroundMaterial: 'acrylic'` + `titleBarOverlay`，Linux 保留原生标题栏（否则没有关闭按钮），都还没实机跑过。材质覆盖**整窗**（侧栏 + 主界面），渲染进程这边按 `html[data-vibrancy]` 分支让出背景并各刷一层同族染色（`--ym-sidebar-tint` / `--ym-main-tint`）。
- **模型目录**：默认 `deepseek-v4-flash`；用 `--model` 或 `/model` 切换。适配器申报 4 款，但 Memento 只对用户暴露 `deepseek-v4-flash` 与 `deepseek-v4-pro` 两款主力（清单在 `app/cli/options.ts` 的 `SUPPORTED_MODELS`，CLI 默认值与桌面端下拉框共用它）。
- **依赖版本锁定**：所有 `@deepseek-ai/dsh-*` 固定在 **`0.1.5-rc.2`**，即标准发布线 —— 官方 CLI `@deepseek-ai/dsh`（npm `latest`）依赖 `^0.1.5-rc.1`，解析结果正是它。安装时请认准这条线：
  - 不要按各**子包**自己的 `latest` 标签装：那些标签是过期的（核心停在 `0.1.0-rc.6`，`dsh-tool-fs` / `dsh-fs-local` / `dsh-llm-deepseek` 停在 `0.0.1-rc.1`），混装会因 `inject` 列表不一致而静默停在 PENDING；
  - 也不要用 `0.1.0-rc` 线：它本身缺包（例如没有 `dsh-deepseek-llm-api-extensions`）；
  - 更不要用 `alpha` 线（`0.1.6-alpha.1`）：那是预发布通道，API 会先于标准线变动（例如 `PromptSection.interpolate` 只存在于 alpha 线）。
