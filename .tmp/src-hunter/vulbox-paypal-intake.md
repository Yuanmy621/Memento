# 漏洞盒子 · PayPal 中国 SRC —— 接单（Phase 1 Intake）

> 生成于 2026-09-21，数据来自 `mcp__vulbox__*` 工具实测（网关 `https://vapi.vulbox.com`）。
> 这份文档只做一件事：把「能不能开打」这件事的**已知 / 未知**摆清楚。

## 1. 项目事实（已实测）

| 项 | 值 |
| --- | --- |
| 项目 | PayPal中国安全应急响应中心（企业 SRC，项目 id **2078**） |
| 门户 | <https://paypal.vulbox.com> |
| 状态 | 进行中：截止 **2030-12-31**，`src_cant_submit_vul = false`（可提交） |
| 奖金 | 严重 5000~10000 元｜高危 2500~5000｜中危 500~1500｜低危 100~500（接口口径） |
| 平台难度标注 | 简单 |
| 我方账号 | uid 576955（YuanMy），**已实名**（`**远`）、已绑手机（`173****2646`）、等级「见习白帽」61/61 经验、赛季第 3 季 —— 由 `vulbox_me` 读主站 SSR 实测 |
| 加入状态 | ❌ **未加入该项目**（`hacker_joined_exists = false`） |
| 门户模块 | 白帽榜 / 战队榜开；赏金榜、漏洞动态**关**（`enable=false`） |
| 门户活跃度 | 月榜仅 1 人（16 分）—— 该项目在平台上属冷门，竞争小 |

## 2. 为什么现在还不能开打（唯一的硬阻塞）

企业 SRC 的**资产范围与公告详情只对项目成员开放**，实测三种表现：

| 调用 | 返回 |
| --- | --- |
| `vulbox_src_scope`（`/web/src/project/profile`） | `assets.content = ""`、`assets.accessible = 4`（范围为空） |
| `vulbox_src_notice id=959`（评级标准） | `301001 暂无权限` |
| `vulbox_src_scope` 的 rules | 空串 |

**这不是 Cookie 过期**：主站 `www.vulbox.com` 的 SSR 明确是登录态（`isLogin: true`、uid 576955、
real_name 已打码、level 见习白帽）。门户侧的 `logged:false` 是它自己的成员判定。

### `accessible` 的准确语义（摘自门户前端 `f53acb0.js` 的提示文案）

| 值 | 门户会显示 | 该怎么办 |
| --- | --- | --- |
| 0 | 直接显示资产范围 HTML | 有权限，正常读 |
| 1 | 「完成认证加入项目后再查看哦~」＋「去认证」按钮 | 完成实名认证 → 加入项目 |
| 2 | 「内测SRC，联系管理员后加入~」＋「联系管理员」按钮 | 这类项目要联系管理员 |
| 3 | 「抱歉，您未取得资产查看权限～」 | 账号没有该项目权限 |
| **4** | （前端没有处理这个值，页面会空一块） | **实测=未加入项目**，PayPal 当前就是这个 |

### 又一层：范围接口还有一条「用户中心」线，当前 token 走不通

用户中心（`user.vulbox.com`，baseURL `/api` → 同一个 `vapi` 网关）里有一批更贴近挖洞的接口：

```
GET /hacker/user/account/info            # 账号 + verify（bind_we_chat / bind_identify / bind_phone / signed）
GET /hacker/project/detail?id=<id>       # 项目详情
GET /hacker/project/detail/assets?id=<id># 资产范围（就是我们要的）
GET /hacker/project/join/info?id=<id>    # 加入状态
POST /hacker/project/join                # 加入项目（写操作，MCP 不注册）
```

**实测：这批接口一律回 `401 Receive a wrong Token, Unauthenticated`**，而同一个 `vulbox_token`
在门户 SSR 上明确是登录态（uid 576955 / YuanMy）。试过 6 种带法都不行：`Bearer <jwt>`、
裸 token、小写 `bearer`、`token:` 头、`authorization=<jwt>` Cookie、Bearer + Cookie 组合；
`X-Host-Original` 给不给、给 `paypal` / `www` / `user` 三种都一样。

两种可能：① 这个 Cookie 对用户中心后端已经算旧（门户线的 token 轮换慢）；
② 两条线的 JWT 校验口径不同。**没有定论，也不该猜** —— 所以「加入项目」这一步
请在浏览器里点（浏览器用的是它自己最新的 Cookie）；如果浏览器里点也失败，
把报错发我，我按上面的 `verify` 四项逐条排。

### 横向验证：14 个门户全是同一个状态

2026-09-21 把企业 SRC 大厅前 14 个项目逐个打了一遍 `/web/src/project/profile`：
**全部 `accessible = 4`、`content` 长度 0、`rules` 长度 0**，且 `vulbox_projects` 里
「已加入」列一个都没有。所以这是「未加入」的统一表现，不是 PayPal 门户单独坏了。

### 「加入项目」到底点哪里（从门户代码里挖出来的精确路径）

门户首页那个**大状态按钮**就是入口 —— 它的文案由项目状态决定
（`cf25992.js`：`statusText = {0:"提交漏洞", 1:"暂停中", 2:"未开始", 3:"已结束"}`，
PayPal 的 `info.status = 0`，所以按钮写的是「**提交漏洞**」，不是「加入项目」）。
点它执行 `submitbugsAct()`，实测分支是：

```
已登录？ → 是
角色 role == 1（白帽）？ → 是
status ∈ [0,2]？ → 是（0）
accessible == 1 ？ → 否（我们是 4）→ userVerify.signed || joined ？ → 否
   ⇒ gotoJoinValidate()  ← 弹出「加入项目」校验框
```

**点法**：

1. 浏览器打开 <https://paypal.vulbox.com>，确认右上角是 **YuanMy**（未登录会先跳登录页）；
2. 首页点那个大按钮「**提交漏洞**」；
3. 弹出的校验框里逐项显示「微信 / 实名 / 手机」+ `已认证 / 未认证` 与「去认证」链接，
   底下有一个「**签署SRC项目参与协议**」的勾选框（协议 PDF：`www.vulbox.com/static/E签宝VULBOX_SRC项目参与协议.pdf`）；
4. 勾上协议 → 点「**立即加入**」（接口 `POST /hacker/project/join`，是写操作，MCP 故意没注册）。

> 找不到按钮是正常的：`accessible = 4` 时门户前端**没有处理这个值**，资产卡片会渲染成一片空白，
> 所以只能从这个「提交漏洞」状态按钮进 —— 它才是加入项目的入口。

加入后 `vulbox_projects` 的「已加入」列会变，`vulbox_src_scope` 就能读到范围与规则
（工具会把 `accessible` 语义打在输出里，不用再猜）。

## 3. 平台规则（Phase 1 的「规则」项，已从帮助中心取到原文）

| 红线 | 出处（`vulbox_help id=`） |
| --- | --- |
| **禁止**大流量 / 大线程 / 大规模扫描（可能被判攻击行为） | [45] |
| **禁止**内网横向探测（除非项目明确允许） | [46] |
| **禁止** DoS / 可能造成业务损失的技术验证 | [48]、[106] 行为准则 6~7 |
| SQLi **只注一条数据**证明即可，严禁拖库；只有报错无危害证明会被忽略 | [79] 第 2 条 |
| 弱口令同一系统只算第一个；后台爆破只收「成功进入」的案例 | [79] 第 1、8 条 |
| 同一漏洞源产生的多个问题**合并**；同系统短时间大量同类高危（一般 3 个）会被合并或降级 | [79] 第 4、11 条 |
| 拿到 shell 后**禁止下载源码审计**（要先联系审核员） | [79] 第 7 条 |
| 越权/未授权验证到「能证明」即止，**禁止**获取、留存用户数据 | [106] 测试规范 1~3 |
| 后台拿到权限后禁止再用功能做增删改 | [106] 测试规范 8~9 |
| **AI 辅助报告必须人工复现**：要 POC / 请求包 / 响应包 / 截图；纯 AI 推测的报告按无效驳回，累计 3 个警告、5 个限制提交 | [150] |

> 最后一条直接决定我们的作业方式：**没有真实请求包与响应，不进报告**。
> 本仓库的 `src-hunter` 技能里那条「无证据不下结论」和平台规则是一致的。

## 4. Phase 1 检查表（MUST 四项）

- [ ] **In-scope**：❌ 未知 —— 需要先加入项目，范围（assets）才可见
- [ ] **Out-of-scope**：❌ 未知 —— 同上（通常在门户「测试规则」里）
- [ ] **规则**：✅ 已取到平台通用规则（见上表）；项目级规则待范围解锁后一并读
- [ ] **时间盒**：❌ 未知 —— 需要你定（单次会话 / 6h / 更长）

## 4.5 已经备好的工具（范围一到就能跑）

| 工具 | 状态 |
| --- | --- |
| `app/mcp/vulbox/`（12 个只读工具） | ✅ 已接入、已验证（`vulbox_doctor` 九项全绿，含 SSR 账号那一路） |
| `.tmp/src-hunter/recon-passive.py` | ✅ 已自测（example.com：CT 6 个子域 / Common Crawl 282 条 / DNS / HackerTarget）。**只查公开数据源，不向目标发包** —— 符合平台「禁止大规模扫描」 |
| `.tmp/src-hunter/evidence.py` | ✅ 已自测：把一次请求/响应对固定成证据包（`request.http` / `response.http` / `manifest.json` + sha256），**Cookie / Authorization / Set-Cookie 自动打码** —— 直接满足 [150] 对「可验证请求包」的要求 |
| `.tmp/src-hunter/report-template.md` | ✅ 已按 [97][79][94][150] 写好的填空模板（含合规声明与 CVSS 段） |
| `app/mcp/vulbox/` 的 `vulbox_me` | ✅ 新增：读主站 SSR 拿登录态/实名/等级 —— 网关那两个账号接口恒回 `logged:false`，不可用 |
| 本机工具链 | dig / whois / host / openssl / curl / jq / python3 齐全；无 nmap（也不需要 —— 平台禁止扫描类行为，Phase 3 走低速率手工探测） |

> Internet Archive 当前整站 503（「Temporarily Offline」），所以历史 URL 用
> **Common Crawl** 兜底（脚本里已经是双来源，谁可用用谁，不可用会明写原因）。

## 5. 范围解锁后的执行顺序（预告，先不动手）

1. `vulbox_src_scope` 读资产范围 + 规则 → 落成 in-scope / out-of-scope 两张表；
2. **被动侦察**（技能 Phase 2，不发包）：CT 日志、Wayback、GitHub dorks、DNS 历史，产出资产清单；
3. **主动探测**（Phase 3）：只对 in-scope 资产做低速率指纹识别 —— 平台禁止大规模扫描，
   所以这一步是「挑重点、手工打」，不是跑扫描器；
4. **漏洞探测**（Phase 4）：按入口信号选 playbook（本仓库 `src-hunter` 技能的 19 个 playbook），
   每个候选漏洞都留 HTTP 包；
5. **报告**（Phase 5）：CVSS + 可复现步骤 + 证据，按平台 PoC 规范 [144] 与 AI 报告标准 [150] 走。

### 归档侧也查过了（被动，零发包）

| 数据源 | 结果 |
| --- | --- |
| Common Crawl（paypal.vulbox.com） | 只有 `/home`、`/rank`、`/`、`robots.txt`(404)。存档是**匿名视图**：SSR 里没有公告正文、没有资产范围（`accessible` 一次都没出现） |
| Common Crawl（user.vulbox.com/projectHall/*） | **零条**（登录态 SPA，爬虫进不去） |
| Common Crawl（src.vulbox.com/） | 有 2026-09-13 的存档，只列了华为等专区，无 PayPal、无范围 |

结论：**范围不存在公开副本**，只能靠加入项目解锁 —— 与接口侧的表现一致。

## 6. 怎么用这个 MCP（给模型的速查）

```
mcp__vulbox__vulbox_projects        # 选目标：47 个企业 SRC，含奖金/截止/门户/是否已加入
mcp__vulbox__vulbox_src_scope       # 当前门户的范围 + 规则 + 奖金（挖洞前必看）
mcp__vulbox__vulbox_src_notices     # 公告（评级标准 / 处理流程 / 活动）→ src_notice 读全文
mcp__vulbox__vulbox_src_rank        # 这个项目有没有人在挖
mcp__vulbox__vulbox_help            # 平台规范（45/46/48/79/106/144/150 这几篇必读）
mcp__vulbox__vulbox_doctor          # 接口通不通 / 凭据对不对
```

门户参数 `portal` 默认 `paypal.vulbox.com`（可用 `VULBOX_PORTAL` 改）。
