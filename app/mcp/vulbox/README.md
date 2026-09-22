# 漏洞盒子 MCP 服务器（只读）

把[漏洞盒子](https://www.vulbox.com)的企业 SRC / 门户接口包成 MCP 工具，接到 Memento 上之后
模型可以直接查**有哪些 SRC 项目能打、某个项目的资产范围与规则、公告、排行榜、平台规范** ——
配合 `.agents/skills/src-hunter` 用。

```bash
Memento_MCP=vulbox npm start            # CLI
npm run desktop:vulbox                 # 桌面端
Memento_MCP=butian:vulbox npm start     # 补天 + 漏洞盒子一起挂
```

挂上之后模型看到的工具名形如 `mcp__vulbox__vulbox_projects`（共 12 个）。

## 填登录信息（就一个文件）

**免登录也能用的 4 个**：`vulbox_projects` / `vulbox_rank` / `vulbox_platform_stats` / `vulbox_help`。
要看某个门户的范围、公告、榜，把 Cookie 写进这个文件：

```
~/.Memento/vulbox-cookie.txt        ← 把浏览器里 vulbox.com 的 Cookie 整串粘进去
```

```bash
mkdir -p ~/.Memento
pbpaste > ~/.Memento/vulbox-cookie.txt     # 已复制的话直接这样写进去
chmod 600 ~/.Memento/vulbox-cookie.txt     # 只有自己可读

# 想放别处：VULBOX_COOKIE_FILE=/别的/路径
# 或者干脆用环境变量：export VULBOX_COOKIE='...'
```

文件里真正被用到的只有两个键：

| 键 | 用途 |
| --- | --- |
| `vulbox_token` | JWT，**鉴权就靠它**（请求头 `Authorization: Bearer <它>`） |
| `uuid` | 请求头 `uuid`（前端从 localStorage 取，实测不参与鉴权） |

其余 Cookie（`VB_INDEX_LAYOUT`、`WeChat_uuid`、`authorization=1`）实测都不参与接口鉴权，
留着也无妨。**Cookie 从哪复制**：浏览器登录 vulbox.com → F12 → Network → 刷新 → 点任意请求
→ Request Headers 里的 `Cookie:` 整行复制（别用 `document.cookie`，会话 Cookie 多半是 HttpOnly）。

改完**不用重启**（每次调用都会重新读文件），但要让内核挂上 MCP：`Memento_MCP=vulbox npm start`。
填完让模型跑一次 `vulbox_doctor`，它会逐个接口报告「通了 / 需要登录 / 暂无权限 / 失败」。

## 「暂无权限」不是 bug：企业 SRC 的范围要**先加入项目**

这是实测出来、也是最容易误会的一条：**没加入某个 SRC 项目时，它的资产范围与公告详情读不到**。

| 现象 | 含义 |
| --- | --- |
| `assets.accessible = 4` 且 `assets.content` 是空串 | 未加入该项目（接口只对成员开放范围） |
| 公告详情回 `301001 暂无权限` | 同上 |
| `user-info` / `account/basic-info` 回 `logged: false` | 这两个接口**恒回 false**（Bearer / Cookie / 两者组合、4 种 `X-Host-Original` 全试过），不可作为登录态判据 —— 要判登录态用 `vulbox_me`（读主站 SSR，实测能拿到 uid/用户名/实名） |
| `/hacker/...` 回 `Receive a wrong Token` | 那批接口属于**用户中心那个后端**（`user.vulbox.com` 的 `/api` → 同一个网关），校验 token 的口径与 SRC 门户的 `/web/*` **不一致**：同一个 `vulbox_token`（Cookie 里的）门户 SSR 认、这里不认。项目详情的资产范围（`/hacker/project/detail/assets`）与「加入项目」（`/hacker/project/join`）都在这条线上 —— 所以**加入项目请在浏览器里点**，别用脚本重放（本 MCP 也没有注册这些写接口） |

正确做法：用浏览器打开对应门户（如 <https://paypal.vulbox.com>）点「加入项目」
（先在设置里完成实名认证），之后 `vulbox_src_scope` 就能读到范围、`vulbox_src_notice` 能读全文。
`vulbox_projects` 的「已加入 / 未加入」列就是这个状态。

## 工具

| 工具 | 登录 | 接口（网关 `https://vapi.vulbox.com`） |
| --- | --- | --- |
| `vulbox_projects` | 否 | `GET /web/project/enterprise/src`（企业 SRC 大厅，47 个项目：奖金区间/截止/门户/是否已加入/能否提交） |
| `vulbox_platform_stats` | 否 | `GET /web/project/application/info`（累计漏洞 639 万 / 白帽 21.8 万 / 企业 8768） |
| `vulbox_rank` | 否 | `GET /web/index/ranking`（主站赛季总榜） |
| `vulbox_help` | 否 | `GET /web/help-center/articles`（目录）、`/article?id=`（全文）、`/articles/search?search=` |
| `vulbox_src_info` | 否 | `GET /web/src/basic-info`（门户概况 + 模块开关） |
| `vulbox_src_scope` | 是* | `GET /web/src/project/profile`（奖金档位 / 说明 / 规则 / 资产范围） |
| `vulbox_src_notices` | 否 | `GET /web/src/project/notices?page&page_size`（page_size 必填且 ≥5） |
| `vulbox_src_notice` | 是* | `GET /web/src/project/notice/<id>` |
| `vulbox_src_rank` | 否 | `GET /web/src/rank/user`、`/web/src/rank/team` |
| `vulbox_src_vulns` | 否 | `GET /web/src/vuln/moments`、`/web/src/vuln/bounties`（很多门户 `enable=false`） |
| `vulbox_me` | **Cookie** | `GET /`（**主站 SSR 页面**里的 `window.__NUXT__`）：登录态、用户名/uid、实名与手机打码、等级经验、站内信 |
| `vulbox_doctor` | 否 | 自检：把上面每个接口打一遍并报告结构（含 SSR 账号那一路） |

\* 「是」的准确含义是**要加入该项目**，不是「要登录」—— 见上一节。

门户域名通过 `X-Host-Original` 指定（工具参数 `portal`，默认 `paypal.vulbox.com`，
可用环境变量 `VULBOX_PORTAL` 改）。`vulbox_projects` 返回里的「门户」列就是它。

## 只读边界

**写操作接口一个都没有注册**：加入项目（`POST /hacker/project/join`）、项目邀请
（`POST /hacker/project/invitation`）、提交漏洞、意见反馈（`POST /web/feedback/in`）、
实名认证（`POST /hacker/user/account/real-verify`）、退出登录（`POST /openapi/account/logout`）
全都不在表里。

工具表是**写死的常量**（`server.ts` 里 12 个 `registerTool`），没有动态注册入口。
`client.ts` 里也**只实现了 GET**，写路径没有开口子。要加写操作请先想清楚：
它们会真实改变你账号的数据（比如「加入项目」——那也该由人自己在浏览器里点）。

## 接口是怎么挖出来的

漏洞盒子**没有公开 API 文档**。路径、请求头与判定规则全部来自它自己前端 bundle 里的真实定义，
并逐条 curl 实测过：

- 门户 `paypal.vulbox.com`（Nuxt SSR）→ `/public/3752b65.js`：SRC 模块的 8 个接口 +
  axios 拦截器（`BASE_URL_API`、`X-client-Type`、`uuid`、`Authorization: Bearer vulbox_token`、
  `X-Host-Original`）；
- 主站 `www.vulbox.com` → `/_nuxt/5c59150.js` 等：企业 SRC 大厅、总榜、帮助中心、账号接口。

四条必须遵守的约定：

| 约定 | 依据 |
| --- | --- |
| 网关只有一个：`vapi.vulbox.com` | bundle 里 `BASE_URL_API:"https://vapi.vulbox.com"`，门户与主站共用 |
| `X-Host-Original` 决定「哪个门户的身份」 | 传 `www.vulbox.com` 打 SRC 接口会回 `404 企业SRC信息不存在` |
| `Authorization: Bearer <vulbox_token>` | 拦截器从 Cookie 取 token 再拼 Bearer；不带会回 `Can't found Token` |
| 成功判定 `code === 200` | 响应拦截器 `200 !== t.data.code` 即失败；业务失败也是 HTTP 200 |

envelope 长这样：

```json
{"code":200,"msg":"success","data":{"current_page":1,"data":[...],"total":47}}
```

### 已验证（2026-09-21 实测）

| 内容 |
| --- |
| 企业 SRC 大厅 47 个项目，字段含 `id / task_title / reward_range / task_etime / src_url / hacker_joined_exists / src_cant_submit_vul` |
| PayPal 门户（id 2078）：奖金 100~10000（严重 5000-10000、高 2500-5000、中 500-1500、低 100-500），截止 2030-12-31，可提交 |
| 公告列表（5 条，含「PPSRC漏洞等级评级标准V1.0」「PPSRC漏洞处理流程V1.0」）；详情需加入项目 |
| 门户白帽榜、主站总榜、平台数字、帮助中心目录与全文（`?id=5` 返回富文本） |
| `logged: false` 与「暂无权限」的真实成因（见上文），以及未加入时 `assets.accessible = 4` |
| `accessible` 五个取值在门户前端的**原文案**（0 有权限 / 1 完成认证加入 / 2 内测联系管理员 / 3 无权限 / 4 未加入），已写进 `vulbox_src_scope` 的输出 |
| `window.__NUXT__` 的受限解析（形参→实参 + 前缀赋值；**不 eval** 远端脚本），拿到 uid 576955 / Memento / 已实名 |
