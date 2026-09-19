# 补天 MCP 服务器（只读）

把[补天漏洞响应平台](https://www.butian.net)的接口包成 MCP 工具，接到 YuanMy 上之后
模型可以直接查项目大厅、排行榜、个人中心 —— 配合 `.agents/skills/src-hunter` 用。

```bash
YuanMy_MCP=butian npm start            # CLI
npm run desktop:butian                 # 桌面端
```

挂上之后模型看到的工具名是 `mcp__butian__butian_project_hall` 这种形式（共 7 个）。

## 填登录信息（就一个文件）

**免登录的 4 个工具不需要任何配置**（项目大厅、排行榜、平台数字、自检）。
要读个人中心 / 任务 / 关注列表，把 Cookie 写进这个文件就行：

```
~/.YuanMy/butian-cookie.txt        ← 把浏览器里 butian.net 的 Cookie 整串粘进去
```

```bash
mkdir -p ~/.YuanMy
pbpaste > ~/.YuanMy/butian-cookie.txt     # 已复制的话直接这样写进去
chmod 600 ~/.YuanMy/butian-cookie.txt     # 只有自己可读

# 想放别处：BUTIAN_COOKIE_FILE=/别的/路径
# 或者干脆用环境变量：export BUTIAN_COOKIE='...'
```

**Cookie 从哪复制**：浏览器登录补天 → F12 打开 DevTools → Network →
刷新页面 → 点任意一个请求 → Request Headers 里的 `Cookie:` 整行复制。

> 别用 `document.cookie` —— 会话 Cookie 通常是 HttpOnly，控制台里读不到。

文件里粘整行没关系：`Cookie:` 前缀、多余换行、首尾空格都会被自动清掉。
改完**不用重启**（每次调用工具都会重新读一次文件），但要让内核挂上 MCP：
`YuanMy_MCP=butian npm start` 或 `npm run desktop:butian`。

填完让模型跑一次 `butian_doctor`，它会逐个接口报告「通了 / 需要登录 / 失败」。

## 工具

| 工具 | 登录 | 接口 |
| --- | --- | --- |
| `butian_project_hall` | 否 | `POST /Reward/pub`（公益SRC）、`POST /Reward/corps`（专属SRC企业，带奖金区间） |
| `butian_rank` | 否 | `POST /Rank/monthWhiteRank`（`t=1` 月榜 / `t=2` 总榜，返回 fight/hunter/eye 三类） |
| `butian_platform_stats` | 否 | `POST /Rank/getNumbers`（累计漏洞/奖金/企业/白帽数） |
| `butian_me` | **是** | `POST /WhiteHat/Center/spaceData` |
| `butian_missions` | **是** | `GET /WhiteHat/Mission/lists` |
| `butian_my_follow` | **是** | `POST /WhiteHat/Follow/index` |
| `butian_doctor` | 否 | 自检：把上面每个接口打一遍并报告结构 |

## 只读边界

**写操作接口一个都没有注册**：签到（`/WhiteHat/Sign/userCheckin`）、
领任务（`/WhiteHat/Mission/take`）、戴勋章（`/WhiteHat/Mission/wear_medal`）、
荣誉币兑换、提交漏洞（`/Loo/*`）全都不在表里。

工具表是**写死的常量**（`server.ts` 里 7 个 `registerTool`），没有动态注册的入口，
所以只要没人去加，就不会有写操作。要加的话记得：它们会真实改变你账号的数据。

## 接口是怎么挖出来的

补天**没有公开 API 文档**，所以路径、方法、参数全部来自它自己前端 bundle 里的真实定义
（`/Public/static/js/main.js` 等），并且逐条 curl 实测过。三条必须遵守的约定：

| 约定 | 依据 |
| --- | --- |
| `POST` 必须带 `ajax=1` | 前端拦截器 `merge({ ajax: 1 }, data)`；少了会被当普通页面请求 |
| `Content-Type: application/x-www-form-urlencoded` | 前端 axios 实例就是这么建的 |
| 成功判定 `status === 1 \|\| success === 1` | 响应拦截器；业务失败也是 HTTP 200 |

envelope 长这样：

```json
{"status":1,"info":"棒棒哒","data":{"count":200,"current":1,"list":[...]}}
```

### 已验证 / 未验证

| 状态 | 内容 |
| --- | --- |
| ✅ 实测过 | 4 个免登录接口的真实返回结构（`/Reward/corps` 的 count 恒为 0、`/Reward/corps` 的 count 恒为 0 这类坑都记在代码注释里） |
| ⚠️ 只从 bundle 读到「路径+方法+参数名」 | 4 个登录接口的**返回结构**。没有凭据无法预先确认字段名，所以 `butian_me` / `butian_missions` / `butian_my_follow` 目前把原始 JSON 交给模型 —— 跑一次 `butian_doctor` 就能看到字段，随之固化成可读文本 |

这也是为什么有 `butian_doctor`：填完凭据跑一次，就能看清每个登录接口的真实结构，
不用逐个工具去试。


离线冒烟覆盖：工具表与只读边界、`ajax=1`/Content-Type/`X-Requested-With` 契约、
三类错误分类（业务失败 / 登录过期 / 被重定向成 HTML）、没凭据时的降级提示、
以及各工具的输出格式。它靠 `BUTIAN_BASE` 与 `BUTIAN_COOKIE_FILE` 两个环境变量
把自己关进本地环境 —— **不会读你真实的凭据文件，也不会打线上**。
