# MCP 服务器（外部工具）

`app/mcp/` 放的是**本项目自己带的 MCP 服务器** —— 它们不依赖 Memento 的 TS 类型，
只是普通的标准输入输出 JSON-RPC 进程，谁都能拉起（Claude Desktop、官方 DSH CLI 都行）。

当前有两个（都是**只读**的 SRC 侦察工具）：

| 名字 | 目录 | 说明 |
| --- | --- | --- |
| `butian` | [`butian/`](./butian/README.md) | 补天（butian.net）：项目大厅、排行榜、平台数字、个人中心 |
| `vulbox` | [`vulbox/`](./vulbox/README.md) | 漏洞盒子（vulbox.com）12 个只读工具：企业 SRC 大厅、门户资产范围/规则/公告、排行榜、帮助中心、账号自检。**注意**：某个 SRC 的资产范围要先在门户「加入项目」才可见 |

## 怎么接到 Memento 上

内核里挂的是**官方 MCP 客户端插件** `@deepseek-ai/dsh-mcp-client`（`app/cli/kernel.ts`），
它把 MCP 服务器的工具注册成 `mcp__<serverName>__<工具名>`，模型看到的就是普通工具。

**默认不挂** —— 每挂一个都会起一个子进程，而且它的工具会进每一次请求的工具表（占上下文）。
用 `$Memento_MCP` 显式开启，值是逗号以外的冒号分隔名字：

```bash
Memento_MCP=butian npm start              # CLI 挂补天
Memento_MCP=vulbox npm start              # CLI 挂漏洞盒子
Memento_MCP=butian:vulbox npm start       # 两个一起挂
npm run desktop:vulbox                   # 桌面端挂漏洞盒子（desktop:src = 两个都挂）
Memento_MCP=butian:my-thing npm start     # 再挂一个工作目录里的自定义 server
```

名字写错只警告不报错（写错一个字不该让内核起不来）。

### 加一个自己的 MCP 服务器

两种方式，都不用改代码：

1. **工作目录里丢文件**：`<cwd>/.Memento/mcp/<名字>.ts`（或 `.js`），
   然后 `Memento_MCP=<名字>`。内核用当前 node + `--experimental-strip-types` 拉起它，
   所以 TS 不需要构建。
2. **仓库内置**：在 `app/cli/kernel.ts` 的 `mcpSpecs()` 里加一条（需要转发凭据时
   必须写 `forwardEnv`，见下）。

### ⚠️ 凭据必须显式转发

MCP 客户端会用**清洗过的父环境**起子进程：`KEY` / `PASSWORD` / `SECRET` / `TOKEN`
之类的变量名一律丢掉，`DSH_*` 也一律丢掉。所以凭据只能走配置里的 `env`
（`mcpSpecs()` 的 `forwardEnv` 就是干这个的）—— 这也是为什么 `BUTIAN_COOKIE`
被显式列进去，而不是指望它自己继承。

> `BUTIAN_COOKIE` / `VULBOX_COOKIE` 恰好不在清洗规则里（规则不匹配 `COOKIE`），
> 但**别依赖这个巧合**：哪天规则加一个 `COOKIE`，登录会悄无声息地失效。
> 两个 server 的凭据文件名也不一样：`~/.Memento/butian-cookie.txt` 与
> `~/.Memento/vulbox-cookie.txt`（都能用 `*_COOKIE_FILE` 换路径）。

## 依赖：这个插件的版本线是错位的

`@deepseek-ai/dsh-mcp-client` 在 npm 上只有 **`0.0.1-rc.1`**（属于过期的那条发布线），
而我们其它 40 个 `dsh-*` 包锁在 `0.1.5-rc.2`。它声明的 peer 范围因此全都对不上：

```
✕ unmet peer @deepseek-ai/dsh-invariants  Installed: 0.1.5-rc.2  Wanted: ^0.0.1-rc.1
✕ unmet peer @deepseek-ai/dsh-llm         Installed: 0.1.5-rc.2  Wanted: ^0.0.1-rc.1
✕ unmet peer @deepseek-ai/dsh-subprocess  Installed: 0.1.5-rc.2  Wanted: ^0.0.1-rc.1
✕ unmet peer @deepseek-ai/dsh-tools       Installed: 0.1.5-rc.2  Wanted: ^0.0.1-rc.1
```

**这是可以接受的**，理由不是「凑合能跑」，而是逐条核对过：

- 它 `inject` 的是 `['tools']`，两边完全一致；
- 运行时只从 `dsh-subprocess` 取一个纯函数 `scrubbedParentEnv`，
  而 `0.1.5-rc.2` 同时导出它**和** `SubprocessRuntime`；
- `dsh-invariants` 只在注释里被提到，代码里**没有任何 import**。

所以 `pnpm-workspace.yaml` 里用 `peerDependencyRules.allowedVersions` 把 peer
对齐到本仓库实际安装的版本（而不是为它引入过期依赖线）。

### 踩过的两个坑（别重犯）

1. **用 `npm install` 装**：这个仓库是 **pnpm** 管理的（`pnpm-lock.yaml` +
   `node_modules/.pnpm`）。npm 会把 pnpm 的符号链接布局展平成真实目录，
   于是 `dsh-llm-deepseek` 的传递依赖 `@deepseek-ai/dsh-credentials`
   直接解析不到，内核起不来。仓库里那个 `package-lock.json` 是历史遗留、
   且**早就和 package.json 不同步**（`npm ci` 会直接拒绝），别拿它当事实来源。
2. **为它降级装 `@deepseek-ai/dsh-subprocess@0.0.1-rc.1`**：这个包会被链接进
   `dsh-subprocess-local` 的解析路径，而后者要 `0.1.5-rc.2` 的 `SubprocessRuntime`
   → `does not provide an export named 'SubprocessRuntime'`，内核崩。
   正确做法是把它**升到树里本来就用的 `0.1.5-rc.2`**，
   这样 `dsh-subprocess-local`（幽灵依赖）和 MCP 插件（peer）两边同时对。

另外 `zod` 和 `@modelcontextprotocol/sdk` 必须声明成**顶层依赖**：
pnpm 的严格布局下，MCP 服务器进程解析不到别人的传递依赖
（第一版就报 `Cannot find package 'zod'`）。

