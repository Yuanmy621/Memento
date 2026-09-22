---
name: Memento-mcp
description: 往 Memento 上接 MCP 服务器的固定套路 —— 内核怎么挂官方 MCP 客户端、$Memento_MCP 怎么开、凭据为什么必须显式转发、以及这个仓库用 pnpm 时踩过的两个依赖坑（npm install 会展平布局、降级 dsh-subprocess 会打崩内核）。当你要给 Memento 加一个 MCP 服务器、接一个新平台（飞书/GitHub/补天之类）、排查「MCP 工具没出现在工具表里」，或者要改 app/mcp/ 下的服务器时使用。
# 默认保持 Agent 纯净：命令专用，不进模型的会话技能目录；用 /名字 显式加载。
disable-model-invocation: true
---

# 给 Memento 接 MCP 服务器

## 现状（别重新造轮子）

内核挂的是**官方**客户端插件 `@deepseek-ai/dsh-mcp-client`（`app/cli/kernel.ts` 的
`mountMcpServers()`）。它把 MCP 服务器的工具注册成 `mcp__<serverName>__<工具名>`，
模型看到的就是普通工具。**默认不挂** —— 每个服务器一个子进程，工具还会进每一次请求的
工具表（占上下文），所以用 `$Memento_MCP` 显式开启：

```bash
Memento_MCP=butian npm start          # CLI
Memento_MCP=vulbox npm start          # CLI（漏洞盒子，第二个内置 server）
npm run desktop:vulbox               # 桌面端；desktop:src = 补天 + 漏洞盒子一起
```

名字写错只警告不报错。仓库自带两个：`app/mcp/butian` 与 `app/mcp/vulbox`，
各自的 README 里有「接口是怎么挖出来的」与实测表。

## 企业 SRC 的「登录了但读不到范围」不是 bug

漏洞盒子这一档踩到的坑，值得记住这个模式：门户接口对**未加入项目**的账号会
`code: 301001 暂无权限`，范围字段 `assets.content` 是空串且 `accessible = 4`，
而 `user-info` 甚至回 `logged: false`（**主站明明登录着** —— 门户侧是另一套判定）。
所以错误分类要多一档 `forbidden`，提示落到「去门户点加入项目」，而不是让模型以为
Cookie 过期了、反复重配凭据。判据：`/暂无权限|无权限/` → `forbidden`。

## 加一个服务器：两条路，都不用改代码（第二条）

1. **仓库内置**：在 `app/cli/kernel.ts` 的 `mcpSpecs()` 里加一条。TS 直接用当前 node +
   `--experimental-strip-types` 拉起，**不需要构建**（别用 Electron 的二进制）。
2. **工作目录里丢文件**：`<cwd>/.Memento/mcp/<名字>.ts`，然后 `Memento_MCP=<名字>`。
   内核自动扫描（`customMcpSpecs()`），适合一次性的、跟项目走的服务器。

## ⚠️ 凭据必须写进 `forwardEnv`

MCP 客户端用**清洗过的父环境**起子进程：变量名匹配 `/KEY|PASSWORD|SECRET|TOKEN/i`
的一律丢掉，`DSH_*` 也一律丢掉。所以凭据不能指望继承，必须显式转发：

```ts
butian: {
  serverName: 'butian',
  command: process.execPath,
  args: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', serverPath],
  forwardEnv: ['BUTIAN_COOKIE'],   // ← 少了它，登录会「莫名其妙」失效
  title: '补天 butian.net（只读）',
}
```

`BUTIAN_COOKIE` / `VULBOX_COOKIE` 恰好不匹配那条正则（不含 KEY/PASSWORD/SECRET/TOKEN），
但**别依赖这个巧合**：哪天 DSH 把 `COOKIE` 加进规则，就会静默失效。
转发列表里连 `*_COOKIE_FILE` / `*_PORTAL` 这类**非凭据但影响行为**的变量也一起写上
（漏洞盒子用 `VULBOX_PORTAL` 选门户），否则用户在 shell 里设了却不生效，很难查。

给凭据留后路：让服务器**自己也读一个文件**（如 `~/.Memento/butian-cookie.txt`），
这样用户不用把密钥塞进 shell 环境、也能手工调试。同时提供
`BUTIAN_COOKIE_FILE` 之类的**路径覆盖**变量 —— 冒烟测试必须用它，
否则测试会读用户真实的凭据文件（断言测不准，还可能真打线上）。

## 这个仓库是 pnpm 管理的：两个踩过的坑

1. **不要用 `npm install`**。仓库用 pnpm（`pnpm-lock.yaml` + `node_modules/.pnpm`），
   npm 会把符号链接布局**展平成真实目录**，于是 `dsh-llm-deepseek` 的传递依赖
   `@deepseek-ai/dsh-credentials` 直接解析不到，内核报
   `Cannot find package '@deepseek-ai/dsh-credentials'` 起不来。
   仓库里那个 `package-lock.json` 是历史遗留、**早就和 package.json 不同步**
   （`npm ci` 会直接拒绝执行），别把它当事实来源。
   → 用 `pnpm add` / `pnpm install`；装崩了就 `rm -rf node_modules && pnpm install`。
2. **不要为了满足 peer 去降级 dsh 包**。`dsh-mcp-client@0.0.1-rc.1` 声明的 peer 是
   `^0.0.1-rc.1`，但装 `@deepseek-ai/dsh-subprocess@0.0.1-rc.1` 会被链接进
   `dsh-subprocess-local` 的解析路径，而后者要 `0.1.5-rc.2` 的 `SubprocessRuntime`
   → `does not provide an export named 'SubprocessRuntime'`，内核崩。
   → 正确做法是把 **`dsh-subprocess` 加成 `0.1.5-rc.2`**（树里本来就用的版本），
   两边同时对；peer 范围不匹配用 `pnpm-workspace.yaml` 的
   `peerDependencyRules.allowedVersions` 声明清楚（现状见该文件的注释）。

另外：pnpm 严格布局下，MCP 服务器**自己 import 的包必须是顶层依赖**
（`zod`、`@modelcontextprotocol/sdk` 都踩过 `Cannot find package`）——
传递依赖它能看见是运气，不是契约。

## 服务器本身怎么写

用官方 `@modelcontextprotocol/sdk`（`McpServer` + `StdioServerTransport`）：

```ts
const server = new McpServer({ name: 'butian', version: '0.1.0' })
server.registerTool('butian_x', {
  title: '…', description: '…（写清什么时候用）',
  inputSchema: { page: z.number().int().min(1).default(1) },   // 裸 ZodRawShape，不是 ZodObject
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ page }) => ({ content: [{ type: 'text', text: await run(page) }] }))
```

⚠️ **stdio 下 stdout 是协议通道**：任何 `console.log` 都会破坏 JSON-RPC 帧，
日志一律 `console.error`。

**错误要分类，不要一律抛**：`ButianError` 带 `kind`（`no-credential` / `auth` /
`http` / `api`），工具里转成**可操作**的中文说明（去哪填凭据 / 重新复制 Cookie /
原样报业务错误）。抛异常会让模型看到一段栈，等于没提示。

**界面不要裸 JSON dump**：把数据格式化成给人看的文本（标题带页数/总数、
逐条列名次），原始结构只在字段还没对齐时才交出去。

## 验证：让模型真调一次

没有测试脚本，验证靠**真实调用**（这也更接近使用现场）：

```bash
node app/mcp/<名字>/server.ts                              # 单独起：手工发一行 initialize 就能看它活没活
Memento_MCP=<名字> node app/cli/main.ts -p "调用 mcp__x__y，把返回原样列出来"
```

⚠️ 只看到工具出现在表里**不等于**调用能成功：MCP 服务器的进程可能起来了但接口全失败。
所以一定要真调一次、看返回内容。

四个容易出事的地方（写实现时自己确认，不要指望有断言替你兜）：

1. **stdio 下 stdout 是协议通道**：任何 `console.log` 都会破坏 JSON-RPC 帧，日志走 stderr；
2. **契约**：POST 要不要带 `ajax=1`、Content-Type 对不对、`X-Requested-With` 有没有
   —— 少一个就 302 或空响应；
3. **错误要分类**：业务失败 / 登录过期 / 被重定向成 HTML / 没凭据，四种给不同的可操作提示；
4. **只读边界**：写操作接口不要顺手注册（会真实改变用户账号数据）。


## 加完检查清单

1. `Memento_MCP=<名字> node app/cli/main.ts --list-tools` → 工具表里出现 `mcp__<名字>__*`；
2. 真让模型调一次（`node app/cli/main.ts -p "调用 mcp__x__y，把返回原样列出来"`），
   确认端到端通了 —— 只看到工具在表里**不等于**调用能成功；
3. 确认**只读边界**：工具表里不该出现任何写接口（`registerTool` 是写死的，别加）。
