# opencli 适配器（补天个人中心）

把 <https://www.butian.net/WhiteHat/Center> 包装成命令行，接到你本机全局装的
[`@jackwener/opencli`](https://www.npmjs.com/package/@jackwener/opencli) 上。

```bash
opencli butian center      # 个人中心概览：等级、称号、积分、荣誉币、漏洞数、排名、认证状态
opencli butian vulns       # 我的漏洞列表（可按名称/级别/状态筛）
opencli butian missions    # 任务/成就进度（按分类摊平）
opencli butian sign        # 连续签到天数（只读，不会替你签到）
```

常用参数：

```bash
opencli butian vulns --status 1        # 待审核的
opencli butian vulns --status 4        # 已完结的
opencli butian vulns --title 某厂商     # 按厂商/名称筛
opencli butian vulns -f json           # 看原始字段（表格只显示常用列）
opencli butian missions -f table
```

## 凭据：和补天 MCP 共用同一份

```
~/.YuanMy/butian-cookie.txt      ← 浏览器里 butian.net 的 Cookie 整串
```

填一次，opencli 的适配器和 YuanMy 里的补天 MCP 都能用（`BUTIAN_COOKIE_FILE` 可改路径，
`BUTIAN_COOKIE` 环境变量也可以）。**改完不用重装**，每次执行都会重新读。

失效时的表现是明确的：补天会 302 到登录页，命令返回
`AUTH_REQUIRED … Cookie 无效或已过期，请重新从浏览器复制一份`（退出码 77）。

## 安装：为什么要多一步 `npm run opencli:install`

opencli **只从一个地方**发现适配器：`~/.opencli/clis/<site>/<命令>.js`。而且它的扫描器

- 要求**真实目录**（`entry.isDirectory()`）→ 所以不能像 `.claude/skills` 那样把整个仓库目录
  软链过去（软链会被跳过）；
- 只加载 `.js` → `.ts` 会被明确忽略（日志里会 warn）。

于是分工是：**仓库是唯一事实来源**（`app/opencli/clis/`），安装脚本负责覆盖式同步过去。
改了适配器就跑一次：

```bash
npm run opencli:install
opencli list | grep butian        # 应该看到 4 条命令
```

脚本只动本仓库管理的 site 目录（`butian/`），不会碰 opencli 自带的和你手写的其他适配器。

## 为什么这些命令不需要 Chrome 扩展

opencli 原生的 `Strategy.COOKIE` 适配器靠 `page.getCookies()` 从浏览器拿 Cookie，
因此**要求** `opencli doctor` 里那项 Extension 连上。而补天这几个命令是
`browser: false`：自己用 Node 的 `fetch` 拿数据，Cookie 来自上面那个文件 ——
所以 `opencli doctor` 报 `Extension: not connected` 也照样能用。

代价是 Cookie 要自己填；收益是不依赖浏览器、也不需要扩展（更稳、更快）。

## 已实现 / 没实现

| 命令 | 接口 | 状态 |
| --- | --- | --- |
| `center` | `POST /WhiteHat/Center/spaceData` | ✅ 实测通过（需 Cookie + 页面 token） |
| `vulns` | `POST /WhiteHat/Center/loo` | ✅ 接口与字段实测；该账号当前 0 条漏洞，所以走的是空结果分支 |
| `missions` | `GET /WhiteHat/Mission/lists` | ✅ 实测通过（26KB 真实数据） |
| `sign` | `POST /WhiteHat/Sign/continue_days` | ✅ 实测通过（返回一个数字） |

**刻意没做**：签到（`/WhiteHat/Sign/userCheckin`）、领任务（`/WhiteHat/Mission/take`）、
提交漏洞（`/Loo/*`）—— 这些会真实改变账号数据；要加请先确认清楚。

想加的还有：`follow`（我关注的厂商，接口已知 `POST /WhiteHat/Follow/index`，但该页是
Vue 渲染的，行字段名没能从静态页面确认 —— 该账号关注数为 0 也验不了）、
站内消息、`threat`/`zhiwen` 那两个栏目。

## 接口是怎么挖出来的

补天没有公开 API 文档，也没有现成适配器（`opencli list` 里没有 butian）。路径、方法、
参数名全部来自**页面自身的内联脚本**（`axios.post("/WhiteHat/Center/xxx", {...})`、
`$.ajax({ url: ... })`），并用凭据实测过。三条必须遵守的约定：

| 约定 | 依据 |
| --- | --- |
| `POST` 要带 `ajax=1` + `x-www-form-urlencoded` | 站点的 axios 封装就这么发 |
| 成功判定 `status === 1 \|\| success === 1` | 业务失败也是 HTTP 200 |
| 个人中心接口要带**该页的 token** | 少了它返回 `{"status":0,"info":"no token"}` |

⚠️ **token 是每页一个**（`/WhiteHat/Center` 与 `/WhiteHat/Center/loo` 各一个），
嵌在该页 HTML 里。所以 `utils.js` 按页取并按页缓存 —— 拿 A 页的 token 调 B 页接口同样
`no token`。

代码在哪：`clis/butian/utils.js`（凭据 / token / envelope / 状态与级别映射）、
`clis/butian/*.js`（每个命令一个文件）。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `AUTH_REQUIRED … 被重定向到登录页（HTTP 302）` | Cookie 失效 | 重新复制一份写进 `~/.YuanMy/butian-cookie.txt` |
| `COMMAND_EXEC … 没有 token` | Cookie 失效，或补天改版 | 先确认 `opencli butian center` 能出数据；能出就说明是页面结构变了 |
| `EMPTY_RESULT … 共 0 条` | 该账号确实没数据（不是错误） | 换个筛选条件 |
| `opencli doctor` 报 Extension 未连接 | 浏览器桥没装扩展 | **不影响这些命令**（见上）；只有浏览器型适配器需要 |
| 命令不在 `opencli list` 里 | 没安装，或改了没同步 | `npm run opencli:install` |
